# 商汤小浣熊（Raccoon）上游协议

> **用途**：实现方直接照做的协议规格。每条事实都带证据；拿不到证据的写「未验证」并说明尝试过什么。
>
> **取证时间**：2026-11-10（本机 Windows）。本机**未安装**桌面客户端，`~/.box-agent/config/auth.json` 与 `~/.agent2api/` 均不存在，因此凡涉及「真实账号返回」的字段一律标注来源为参考实现，不是本机实测。
>
> **证据简称**
>
> | 简称 | 含义 |
> | --- | --- |
> | `UPSTREAM` | `https://raw.githubusercontent.com/zhlcba/dsh-raccoon-connect/HEAD/docs/upstream-protocol.md`（192 行，作者在装了客户端的机器上的实测记录） |
> | `CONNECT` | `zhlcba/dsh-raccoon-connect@HEAD/src/*.ts`（原始 TypeScript） |
> | `LOCAL` | 本机解包 `dsh-llm-adapters@1.2.7/package/src/*.ts` |
> | `MAGPIE` | `lin2670/magpie-plugins@HEAD/packages/raccoon-auth/index.mjs` |
> | `AGENT2API` | `aimod-cc/agent2api@HEAD/...`（Rust；magpie 的移植来源） |
> | `FE-WORK` | 官网 `/work/home` 前端 chunk `main-app-12246bf347090427.js`（32 个 chunk 共 6.2 MB，本机下载） |
> | `FE-AUTH` | 授权页 chunk `app/(identity)/authorize/page-e3bacc9bca2bfe71.js`（本机下载，20 695 B） |
>
> 长摘录见 [`PROTOCOL-EVIDENCE.md`](./PROTOCOL-EVIDENCE.md)。

---

## 0. 一页速查

| 项 | 值 | 证据强度 |
| --- | --- | --- |
| 站点主域 | `https://xiaohuanxiong.com` | 已实测 |
| LLM 网关 | `https://xiaohuanxiong.com/api/web/llm/v2` | 已实测（v2 存在、v1 为 404） |
| 对话 | `POST {llm}/chat/completions` | 已实测（401 而非 404） |
| 模型目录 | `GET {llm}/model_catalog` | 已实测（同上） |
| 图像生成 | `POST {llm}/images/gen` | 已实测（401） |
| auth API | `https://xiaohuanxiong.com/api/web/auth/v1` | 前端 `prefixes.auth` 逐字 |
| IAM（扫码） | `https://xiaohuanxiong.com/api/iam/v1` | 已实测返回 200 |
| 积分 | `/api/web/points/v1/balance`、`/api/web/points/v2/bills` | 前端逐字 + 已实测 401 |
| 鉴权头 | `Authorization: Bearer <access_token>` | 三份实现一致 |
| 业务失败信封 | `{code, message, details}`，HTTP **200 也可能是失败** | 已实测 |
| access 有效期 | **≈3 小时**；refresh **≈30 天** | UPSTREAM（JWT `exp` 实测） |
| refresh 轮转 | **单次使用**，旧 token 复用 → `200822 refresh_conflict` | UPSTREAM + CONNECT + MAGPIE |
| 桌面凭据 | `~/.box-agent/config/auth.json`，`BOX_AGENT_CONFIG_DIR` 可改，**明文无加密** | UPSTREAM + CONNECT + 同事 `DESKTOP-CREDS.md` |

**给实现者的三条硬约束**

1. **刷新必须写回**（如果登录态来自桌面文件）。不写回 = 把用户在客户端里登出。
2. **刷新必须单飞**。两个并发刷新会烧掉唯一 refresh token 并让另一个调用方彻底失效。
3. **`reasoning_effort` 的 200 不能当作「档位被接受」**。网关对无意义字符串也返回 200（§5.3）。

---

## 1. 站点与基址

### 1.1 主站与网关

```
站点主域        https://xiaohuanxiong.com
LLM 网关        https://xiaohuanxiong.com/api/web/llm/v2
```

- `CONNECT/src/variants.ts:63-64` 逐字：`llmBase: 'https://xiaohuanxiong.com/api/web/llm/v2'`、`siteOrigin: 'https://xiaohuanxiong.com'`。
- `LOCAL/src/raccoon.ts:29`：`RACCOON_BASE = 'https://xiaohuanxiong.com/api/web'`，后续路径拼 `/llm/v2/...`、`/points/v1/...`。
- `MAGPIE:52-53`：`RACCOON_LLM_BASE_URL` 默认 `https://xiaohuanxiong.com/api/web/llm/v2`。
- 前端 `FE-WORK` 逐字 `prefixes:{api:"/api/web/office/v3", basic:"/api/web", org:"/api/web/org", auth:"/api/web/auth/v1"}` —— 注意 **web 端业务前缀是 `office/v3`**，LLM 走独立的 `llm/v2`。

**网关版本存在性实测**（本机，假 Bearer）：

```
GET  /api/web/llm/v2/model_catalog   → 401 {"code":200003,"message":"authorization_verify_error"}
GET  /api/web/llm/v1/model_catalog   → 404 "404 page not found"
POST /api/web/llm/v2/chat/completions→ 401 （路径存在）
POST /api/web/llm/v2/images/gen      → 401 （路径存在）
```

> **判定依据**：该站对不存在的路径返回纯文本 `404 page not found`，对存在但未鉴权的路径返回 JSON `401 {code:200003}`。两个对照（`/llm/v2/bogus_xyz`、`/points/v1/bogus_xyz` 均 404）证明这个判据成立。**故 v1 不存在，v2 是正确的网关版本。**

### 1.2 auth API

```
https://xiaohuanxiong.com/api/web/auth/v1
```

- `MAGPIE:54`：`authBase()` 默认 `` `${mainOrigin()}/api/web/auth/v1` ``。
- `CONNECT/src/upstream.ts:212-214`：`private get authBase()` 返回 `` `${siteOrigin}/api/web/auth/v1` ``。
- `FE-WORK` `prefixes.auth:"/api/web/auth/v1"` —— 第一方证据。

已存在端点（全部 POST-only，实测）：

| 端点 | 作用 | 实测响应（空/假体） |
| --- | --- | --- |
| `/auth/v1/refresh` | 刷新令牌对 | `400 {"code":100002,"message":"params_invalid_error","details":"param token invalid format invalid"}` |
| `/auth/v1/login_with_authorization_code` | 授权码换 token | `400 {"code":200035,"message":"authorization_code_not_found_error"}` |
| `/auth/v1/authorization_code` | 申请授权码（需登录态） | `401 {"code":200001,"message":"authorization_empty_error"}` |
| `/auth/v1/iam/confirm` | IAM token 换业务会话 | `401 {"code":200003,...}` |
| `/auth/v1/entitlement_info` | 权益/套餐 | `401 {"code":200003,...}` |

> `/api/web/auth/v1/*` 是 **POST-only**：GET 一律 404（同事 `WEB-LOGIN.md` §1 #15 实测）。做端点枚举时别用 GET。

### 1.3 积分 / 账单域

```
GET  /api/web/points/v1/balance
GET  /api/web/points/v2/bills?paging.limit=..&type=all[&cursor=..]
```

第一方证据 `FE-WORK` 逐字：

```js
static get baseUrl(){ return ".../api/web" + "/points" }
static get billsUrl(){ return ".../api/web" + "/points/v2/bills" }
static async getBalance(){ ... fetchWithAuth(".../v1/balance", {method:"GET"}) ... }
// getBills(): URLSearchParams({"paging.limit":..., type:h}); cursor 可选
```

**注意 `v1` / `v2` 混用**：余额在 **v1**，账单在 **v2**。`LOCAL/src/raccoon.ts:473` 用的是 `/points/v2/bills?paging.limit=50&type=all`，与前端一致。

**但 `MAGPIE:450` 用的是 `/points/v1/bills`** —— 两个都实测 **401（都存在）**：

```
GET /api/web/points/v1/bills → 401 {"code":200003,...}
GET /api/web/points/v2/bills → 401 {"code":200003,...}
```

**推荐 v2**（第一方前端 + `LOCAL` 一致），v1 作为回退。

### 1.4 其它域（同站，已实测 401 = 存在）

| 端点 | 用途 | 证据 |
| --- | --- | --- |
| `/api/web/office/v3/setting_info` | 每日积分发放触发器（响应含 `point_grant_popups`） | `FE-WORK` 逐字 + 实测 401 |
| `/api/web/desktop/v1/login/points/grant` | 首次电脑端登录奖励 | `MAGPIE:396` + 实测 401 |
| `/api/web/mobile/v1/login/points/grant` | 首次手机端登录奖励 | `MAGPIE:397` + 实测 401 |
| `/api/iam/v1/auth/mp/qrcode` | 创建扫码会话 | 实测 **200 OK**（见 §2.3） |
| `/api/iam/v1/auth/mp/qrcode/login` | 轮询扫码状态 | 实测 401 `AUTH_QRCODE_INVALID` |

### 1.5 环境别名

`UPSTREAM:98`：`code-test` / `code-stage` / `code-dev.xiaohuanxiong.com` 为测试环境，**正式只有裸域**。

前端也有一处硬编码的环境分支（`FE-WORK`）：`window.location.host.includes("office-stage") ? "https://code-stage.xiaohuanxiong.com" : "https://xiaohuanxiong.com"` —— 说明 stage 与 prod 是同构部署，路径不变、只换主机。

**实现建议**：只认裸域 `xiaohuanxiong.com`，不要做环境猜测。

---

## 2. 鉴权

### 2.1 access / refresh 的来源与有效期

**有效期**（`UPSTREAM:18-19`，作者在装了客户端的机器上解 JWT 实测）：

- access token：**3 小时**
- refresh token：**30 天**

JWT 载荷实测字段：`exp`、`nbf`、`iss`、`name`（昵称）、`nation_code`、`owner_type`（`users`）、`sid`（会话 id，带登录来源前缀如 `web…`）。

**凭据文件本身不存过期时间** —— 只能解 JWT 的 `exp`。`CONNECT/src/auth.ts:131-139` 明确写了这一点：「The desktop document stores no expiry field of its own... Malformed or non-JWT values yield an empty claim set, which callers treat as 'expiry unknown' rather than 'expired'」。

**签名不校验**：`CONNECT/src/auth.ts:136` ——「Signature verification is not the plugin's job — it forwards the token and the upstream decides」。

### 2.2 桌面端凭据文件 `~/.box-agent/config/auth.json`

**路径解析**（三份独立证据一致）：

```js
process.env.BOX_AGENT_CONFIG_DIR ?? path.join(os.homedir(), '.box-agent', 'config')
// 文件名固定 auth.json
```

- `UPSTREAM:11-12`（来自 asar 内 `build/electron/main/boxAgentAuthFile.js` 的 `getBoxAgentAuthPath`）
- `CONNECT/src/variants.ts:66-68`：`configDirEnv: 'BOX_AGENT_CONFIG_DIR'`、`configDirRel: '.box-agent/config'`、`desktopFilename: 'auth.json'`
- `LOCAL/src/auth.ts:116-128`：`desktopAuthCandidatesFor()` 同样的解析顺序

**字段**（扁平 JSON，全部可选，字符串）：

| 字段 | 含义 |
| --- | --- |
| `access_token` | 访问令牌 |
| `refresh_token` | 刷新令牌 |
| `office_identity` | 身份（个人/企业，如 `personal`） |
| `office_org_name` | 组织名 |
| `office_org_role` | 组织角色 |

- `CONNECT/src/auth.ts:94`：`DESKTOP_TOKEN_KEYS = ['access_token','refresh_token','office_identity','office_org_name','office_org_role']`（**「the keys the desktop app itself writes, in its own order」**）
- `CONNECT/src/auth.ts:227`：读取端**额外兼容** `token` / `auth_token` 作为 access token 别名 ——「so an older or alternate build's file still works」。
- `UPSTREAM:14` 同样记录了这个别名兼容。

**是否加密：不加密，明文 JSON。**

- `UPSTREAM:9`：主进程写成「普通 JSON 文件」。
- `CONNECT/src/auth.ts:5-6` 的模块注释把它与 WorkBuddy 类做法对比：本文件是可直接读的明文。
- 同事 `DESKTOP-CREDS.md` §0 结论：「扁平 JSON，5 个键……**明文**（非加密信封）」。
- **本机未验证**：本机没有该文件（`C:\Users\xingx\.box-agent\config\` 不存在），无法独立复核加密格式。**结论来源为参考实现 + 同事侦察，非本机实测。**

**写入方式**（若实现要写回，必须完全照做）：

```
JSON.stringify(payload, null, 2) + '\n'
权限 0o600
先写 ${path}.${pid}.tmp，再 rename
```

`CONNECT/src/auth.ts:540-550` 逐字：

```ts
private async writeAtomically(path, payload) {
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, payload, { encoding:'utf8', mode:0o600 })
  await rename(temp, path)   // 原子替换
}
```

**主进程不缓存**：`UPSTREAM:16` —— `readDesktopAuthState()` 每次都重读该文件。这是「插件刷新后写回立即生效」的前提。

### 2.3 刷新：`POST /api/web/auth/v1/refresh`

**请求**（`UPSTREAM:21-30`，来自 asar 内渲染端 `S.refreshTokenRequest`；`MAGPIE:118-123` 与 `CONNECT/src/upstream.ts:323-331` 一致）：

```http
POST https://xiaohuanxiong.com/api/web/auth/v1/refresh
Content-Type: application/json

{"refresh_token":"<jwt>"}
```

- **不带 `Authorization`**。`CONNECT/src/upstream.ts:318-319` 注释：「Deliberately unauthenticated: the refresh token is the credential, and **the gateway rejects a request that also carries an `Authorization` header**.」
- 响应：`200 {"code":0,"data":{"access_token":"...","refresh_token":"..."}}`
- **access 与 refresh 一起轮转**。

**第一方证据**（`FE-WORK`，官方渲染端自己的刷新实现，逐字）：

```js
static async refreshTokenRequest(e){
  let i = v.resolveUrl(v.config.refreshEndpoint||"/refresh","auth"),
      s = await fetch(i, {
        method:"POST", credentials:"include",
        headers:{"Content-Type":"application/json", ...v.createHeaders()},
        body: JSON.stringify({refresh_token:e})
      });
  ...
  let c = s?.data;
  if(!c?.access_token) throw u({type:"validation", code:"INVALID_REFRESH_RESPONSE"});
  v.config.tokenAdapter.setTokens({accessToken:c.access_token, refreshToken:c.refresh_token});
  return c.access_token
}
```

> 注意 `...v.createHeaders()` —— 官方渲染端刷新请求**是带 `Authorization` 的**，与其 `getToken()` 为空时不加。**这与 `CONNECT` 注释「带 Authorization 会被拒」矛盾。** 冲突处理见 §2.4。

**单次使用轮转语义**（`UPSTREAM:36-38` 实测）：

```
旧 refresh token 再用 → 400 {"code":200822,"message":"refresh_conflict",
                            "details":"refresh token conflict or reused"}
```

**参数名写错**（本机实测，补充确认）：

```
{"refresh_token":"bogus"}                       → 400 {"code":100002,"details":"param token invalid format invalid"}
{"refreshToken":"eyJ..."}                       → 400 {"code":100002,"details":"param token invalid format invalid"}
{"refresh_token":"eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjF9.x"} → 400 {"code":100002,"details":"param payload iss invalid invalid"}
{}                                              → 400 {"code":100002,"details":"param token invalid format invalid"}
```

> 本机实测补充了一条 `UPSTREAM` 没有的事实：JWT 形状正确但 `iss` 非法时，错误明细是 **`param payload iss invalid`** 而不是格式错。**服务端会验 `iss`**。空体给的也是 `param token invalid format invalid`（不是 `UPSTREAM:39` 说的 `100000 request_body_error`），可能是上游改版，**以实测为准**。

### 2.4 `refresh_conflict` / `200822` 处理

`CONNECT/src/auth.ts:461-464` 判据：

```ts
private isConflict(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('refresh_conflict') || message.includes('200822')
}
```

`CONNECT/src/auth.ts:417-445` 的 `refreshNow()` 顺序（**推荐的实现顺序**）：

1. 没有 refresh token → 直接报错，提示「打开一次客户端重新登录」。
2. 有 → 调 refresh。
3. **失败且是 conflict → 先重读桌面 `auth.json` 一次**：

```ts
const reread = await this.readDesktopCredential()
if (reread !== undefined && reread.refreshToken !== '' && reread.refreshToken !== credential.refreshToken) {
  return await this.refreshOnce(reread)   // 用 App 刚写入的新 token 再来一次
}
```

理由：conflict 通常意味着**客户端自己刚刷新过**，文件里已是新令牌。重读比报错更可能救活会话。

4. 仍失败且 access 已过期 → 报错，文案含「打开客户端重新登录」。

**`MAGPIE` 的处理不同**（`MAGPIE:106-113`）：**不重读文件**，改为 429 冷却：

```js
const REFRESH_COOLDOWN_MS = 10 * 60e3
if (res.status === 429) { refreshCooldownUntil = Date.now()+REFRESH_COOLDOWN_MS; throw ... }
```

> **两处差异是真实的，不是笔误**：magpie 的凭据**不是**桌面文件（来自 agent2api 导入或网页登录），没有「重读」的对象，所以只能冷却退避。**若你的凭据来自桌面文件，用 CONNECT 的重读策略；否则用 magpie 的冷却策略。**

### 2.5 web 登录拿 token 的已知路径

#### 路径 A：授权码 + 本地回环（**推荐**，第一方支持，无需 DevTools）

这是本次侦察最重要的发现：官方授权页**显式支持**把授权码投递到本地回环地址，本是给 VSCode / JetBrains 插件用的。

**授权页 URL**：

```
https://xiaohuanxiong.com/code/authorize?login_source=desktop&appname=<名称>&state=<随机>
  附加：&desktop_callback=loopback&redirect=http%3A%2F%2F127.0.0.1%3A<port>%2Fauth%2Fcallback
```

- `/code/authorize` → **307** 重定向到 `/authorize?...`（保留全部 query，本机实测）。
- `/authorize?...&desktop_callback=loopback` → **200**，返回官方 SPA。

**第一方校验规则**（`FE-AUTH`，逐字）：

```js
let E=["login_source","appname","state","redirect","ide","org","lang","desktop_callback"];

// 回环地址 + state 的联合校验
function v(e,t){
  if(!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{3,4}\/auth\/callback$/.test(e) || !/^[a-f0-9]{64}$/.test(t))
    return false;
  try{ let t=new URL(e); return Number(t.port)>=1024 && 65535>=Number(t.port) }catch{ return false }
}

// desktop_callback 只有在 desktop 分支、无 ide、且 v(redirect,state) 通过时才合法
let s=e.get("desktop_callback");
if(e.has("desktop_callback") && ("loopback"!==s || !r || o || !v(n,i))) return null;
```

由此得到**四条硬性要求**，违反任一条授权页直接拒绝（返回 `null` = 参数非法）：

1. `redirect` 必须**逐字匹配** `^http://127\.0\.0\.1:[port]/auth/callback$` —— **只认 `127.0.0.1`，不认 `localhost` / `[::1]`**（对比：非 desktop 分支的 `C()` 函数反而接受 localhost）。
2. `state` 必须**恰好 64 位小写十六进制**（`^[a-f0-9]{64}$`）。`crypto.randomUUID().replace(/-/g,'')` 正好是 32 位，**不够**；需要 `randomBytes(32).toString('hex')`。
3. 端口必须在 **1024–65535**。
4. 有 `desktop_callback` 时**不能带 `ide` 参数**。

**回调投递机制**（`FE-AUTH`，逐字）：

```js
function g(e,t){                       // 构造回调 URL
  if(!t || t.length>4096) throw Error("Invalid authorization code");
  if(!e.desktop && !C(e.redirect)) throw Error("Invalid callback");
  if(e.desktopCallback && (!e.desktop || !v(e.redirect,e.state))) throw Error("Invalid desktop callback");
  let r = new URL(e.desktop && !e.desktopCallback
        ? "office-raccoon://auth/callback"     // 有客户端：深链
        : e.redirect);                          // 有 desktop_callback：回环
  r.searchParams.set(e.desktop ? "code" : "authorization_code", t);
  e.state && r.searchParams.set("state", e.state);
  return r.href
}
// ...（原文件此处为调用点，已省略无关代码）
let x = { signal:l.signal, current:u, navigate:e=>window.location.assign(e) };
await n.deliver(g, x);
```

**所以回环收到的是一条普通 GET**：

```
GET /auth/callback?code=<授权码>&state=<state>   HTTP/1.1
Host: 127.0.0.1:<port>
```

**参数名是 `code`，不是 `authorization_code`** —— `e.desktop` 为真走 `code`，非 desktop 才用 `authorization_code`。这个区分是**官方代码里的三元表达式**，不是推测。

投递方式：`desktop` 分支一律 `window.location.assign(url)`（`FE-AUTH`：`if(e.desktop||"idea"!==e.ide) r.navigate(t)`）。仅 `ide==="idea"` 且非 desktop 时才改用 `fetch`。

**换 token**：

```http
POST https://xiaohuanxiong.com/api/web/auth/v1/login_with_authorization_code
Content-Type: application/json

{"authorization_code":"<裸 code>"}
```

响应（`MAGPIE:196-217` 逐字读取字段名）：

```json
{"code":0,"data":{
  "access_token":"...", "refresh_token":"...",
  "office_identity":"...", "office_org_name":"...", "office_org_role":"..."
}}
```

- **`access_token` / `refresh_token` 可能带 `Bearer ` 前缀，必须 strip**（`MAGPIE:58` 专门写了 `stripBearer`，`MAGPIE:205-206` 对两个字段都调用）。
- 授权码**一次性**；已用过 → `200035`（见 §5.5）。

**本机实测限制**：`login_with_authorization_code` 对任意假值都返回 `200035 authorization_code_not_found_error`，**无法用探针区分字段名**，字段名证据来自 `MAGPIE` 代码 + 同事侦察。端到端（真人在浏览器完成登录 → 回环收到 code）**未验证**，因为需要真实凭据。

#### 路径 B：桌面端 `office-raccoon://` 深链

```
office-raccoon://auth/callback?code=<授权码>&state=<state>
```

- 官方客户端监听该协议，`location.assign` 唤起客户端。
- **纯 Node 进程收不到**（没有注册协议处理器）。`LOCAL/src/raccoon-login.ts:4-8` 明确：「the official desktop client receives its authorization through the `office-raccoon://auth/callback` protocol, **which a host-side Node process cannot receive**」。
- 没装客户端时：导航静默失败，**地址栏什么都不会留下**（`MAGPIE:146-147` 实测，2026-10）。所以「从地址栏复制回调 URL」这条路在无客户端时不存在。
- 有客户端时可用：`MAGPIE:536` 的兜底提示仍建议用户抄地址栏。

#### 路径 C：微信小程序扫码（**无 refresh token**）

```
POST https://xiaohuanxiong.com/api/iam/v1/auth/mp/qrcode        {}
POST https://xiaohuanxiong.com/api/iam/v1/auth/mp/qrcode/login  {"qrcode_code":"<code>"}
```

**本机实测（这组不鉴权，真返回数据）**：

```json
POST /api/iam/v1/auth/mp/qrcode {}
→ 200 {"code":"OK","message":"success",
       "data":{"expires_in":300,"poll_interval":2,
               "qrcode_code":"qr-01a1c358-97e8-7b93-b2d7-8389ad710c3e",
               "scan_path":"/login/mp","status":"pending"}}

POST /api/iam/v1/auth/mp/qrcode/login {"qrcode_code":"qr-bogus"}
→ 401 {"code":"AUTH_QRCODE_INVALID","message":"mini-program QR code invalid"}
```

**二维码内容**（`LOCAL/src/raccoon-login.ts:167-174` 逐字，注释说「The exact URL the website encodes into its own QR」）：

```ts
const url = new URL(session.scanPath, RACCOON_QR_ORIGIN)   // https://xiaohuanxiong.com/login/mp
url.search = ''
url.searchParams.set('code', session.code)
url.searchParams.set('appname', '商汤小浣熊')     // RACCOON_QR_APP_NAME
url.searchParams.set('source', 'platform')
```

状态机（`LOCAL/src/raccoon-login.ts:54-60, 189-224`）：`pending` / `logging`（已扫码待确认）/ `canceled` / `success` / `expired` / `error`。成功时读 `data.access_token`，校验 `token_type` 若非 `bearer` 则拒绝。

**关键限制**：

- `IAM` 信封是 `{code:"OK", ...}`（**字符串 `"OK"`**，不是数字 0），与 `/api/web/*` 的 `{code:0}` **不是同一套**。`LOCAL/src/raccoon-login.ts:119-120` 判 `code !== 'OK'`。
- **只拿到 `access_token`，没有 `refresh_token`**（`LOCAL/src/raccoon-login.ts:200-212` 只读 `access_token`）。→ **扫码路径无法自动续期，3 小时后必须重扫。** 是否真的没有 refresh，**未验证**（需真人扫码），但两份参考实现都只取 access，倾向「没有」。
- 扫码后**还需第二步换业务 cookie**：`POST /api/web/auth/v1/iam/confirm` 带 `Authorization: Bearer <iam token>`，从 `Set-Cookie` 取 `xhx_token`（`LOCAL/src/raccoon-login.ts:253-283`）。本机实测假 Bearer 得 401 且不下发 `xhx_token`。成功形态**未验证**。

#### 路径 D：手机 / 邮箱登录（需人机验证）

同事 `WEB-LOGIN.md` §1 实测：

```
POST /api/iam/v1/sms/send  {nation_code, phone, scene:"login"} → {"code":"COMMON_INVALID_ARGUMENT","message":"captcha_token required"}
POST /api/iam/v1/auth/login/sms  {} → {"code":"COMMON_INVALID_ARGUMENT","message":"verification_id invalid"}
```

- **必须过 captcha**（`captcha_token required`）。**不做绕过**（也不应做）。
- **结论：不推荐作为实现路径**，成本高于路径 A。

#### 路径 E：cookie session

前端 token 存储键（`FE-WORK` 逐字）：

```js
h = u("raccoon_token"),  f = u("xhx_token"),  p = u("raccoon_refresh_token")
g = u("user_id"),        m = u("user_name"),  v = u("office_identity")
let d = env.NEXT_PUBLIC_STORAGE_TYPE || "cookie"   // 可切 localstorage
```

- 登录态默认存 **cookie**，键名 `raccoon_token` / `xhx_token` / `raccoon_refresh_token`。
- **但 `/api/web/*` 认 `Authorization: Bearer`**（三份实现 + 本机实测均走 Bearer）。cookie 只是 web 前端自用。
- `LOCAL` 的 `confirmIamSession` 主动从 `Set-Cookie` 抓 `xhx_token` 作为业务 token —— 说明**存在 cookie 形态的 token 也能用**，但只在扫码路径出现。
- **未验证**：手工粘 cookie 是否足以调用 `/api/web/llm/v2/*`。没有实测（无可信 cookie）。

### 2.6 「有证据」vs「未验证」总表

| 结论 | 状态 | 依据 |
| --- | --- | --- |
| access 3h / refresh 30d | **有证据（他机实测）** | `UPSTREAM:19` JWT `exp` |
| `auth.json` 5 个字段、明文、0600、tmp+rename | **有证据（他机实测 + 代码）** | `UPSTREAM:11-16`、`CONNECT/src/auth.ts:94,540-550` |
| 本机 `auth.json` 不存在 | **本机实测** | `ls` 无该目录 |
| refresh 单次轮转 + `200822` | **有证据（他机实测）** | `UPSTREAM:36-38` |
| refresh 参数名 `refresh_token`；`iss` 被校验 | **本机实测** | §2.3 四组探针 |
| 带 `Authorization` 刷新会被拒 | **冲突，未验证** | `CONNECT` 注释说会被拒；`FE-WORK` 官方代码却带 header。**两说并存，别依赖此条** |
| 授权页 loopback 参数校验规则 | **有证据（第一方代码）** | `FE-AUTH` 正则与 `v()` 函数 |
| 回环收到 `code` 而非 `authorization_code` | **有证据（第一方代码）** | `FE-AUTH` 三元表达式 |
| 扫码创建会话（`qrcode_code`/`scan_path`/300s） | **本机实测** | §2.5 路径 C |
| 扫码成功返回 `access_token` 但无 refresh | **部分未验证** | 成功分支需真人扫码；`LOCAL` 代码只取 access |
| `iam/confirm` 下发 `xhx_token` | **未验证** | 假 Bearer 得 401 无 cookie |
| 授权码端到端跑通 | **未验证** | 需真人在浏览器登录 |
| 短信/邮箱登录可行 | **判否（需 captcha）** | `WEB-LOGIN.md` 实测 `captcha_token required` |
| cookie 能否直接调 LLM 网关 | **未验证** | 无可信 cookie 可测 |

---

## 3. 客户端身份头

### 3.1 官方渲染端的构造逻辑（第一方，`FE-WORK` 逐字）

```js
static createHeaders(){
  let m = {"Content-Type":"application/json"};
  let w = v.config.tokenAdapter.getToken?.();          if(w) m.Authorization = "Bearer "+w;
  let C = v.config.runtimeAdapter.getOrgCode?.();      if(C) m["X-Org-Code"] = C;
  let x = v.config.runtimeAdapter.getClientInfo?.();
  x?.platform && (m["X-Client-Platform"] = x.platform);
  x?.version  && (m["X-Client-Version"]  = x.version);
  x?.deviceId && (m["X-Client-Device-ID"]= x.deviceId);
  return v.config.headerAdapter.getHeaders?.({headers:m}) ?? m
}
```

**三条要点**：

1. 所有身份头都是**条件添加** —— 拿不到就不发，**不发明文空值**。
2. `X-Org-Code` 来自 `getOrgCode()`，**个人版为空 → 整个头不出现**。
3. 平台/版本/设备号来自 `initFromUA()`（从 UA 解析）。

`X-Raccoon-Language` 不在这段里，是各业务调用单独加的（`FE-WORK` 的 `getUserSettingInfo` 等）。

### 3.2 各实现实际发了什么（逐头对照）

| 头 | `LOCAL`（dsh-llm-adapters） | `CONNECT`（dsh-raccoon-connect） | `MAGPIE` | 官方渲染端 |
| --- | --- | --- | --- | --- |
| `Authorization` | `Bearer <token>` | `Bearer <token>` | `Bearer <token>` | 条件加 |
| `X-Org-Code` | `''`（**发明文空串**） | `''`（**发明文空串**） | 不发 | 空则**不发** |
| `X-Raccoon-Language` | `'zh'` | `'zh'` | `'zh'`（仅 `setting_info`） | 按调用加 |
| `X-Client-Platform` | `desktop-windows` / `desktop-macos` / `desktop-linux`（按 `process.platform`） | `desktop`（默认，可 `RACCOON_CLIENT_PLATFORM` 覆盖） | `desktop-windows` / `app-android`（按端点选） | 由 UA 解析 |
| `X-Client-Version` | `'v1.0.35'`（硬编码 `RACCOON_CLIENT_VERSION`） | 从安装树读，读不到**不发** | `'v1.0.0'` / `'v1.0.3'`（按端点选） | 由 UA 解析 |
| `X-Client-Device-ID` | **不发** | 从 `desktop-device-identity.json` 的 `clientDeviceId` 读，读不到不发 | **不发** | 由 UA 解析 |
| `x-raccoon-session-id` | **仅 chat 发**，见 §3.3 | 不发 | 不发 | 未观察到 |

证据：

- `LOCAL/src/raccoon.ts:94-102`：

```ts
function raccoonHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    'x-org-code': '',
    'x-raccoon-language': 'zh',
    'x-client-platform': raccoonClientPlatform(),   // desktop-windows/macos/linux
    'x-client-version': RACCOON_CLIENT_VERSION,     // 'v1.0.35'  (raccoon.ts:30)
  }
}
```

- `CONNECT/src/upstream.ts:227-239`：

```ts
const out = {
  'Content-Type':'application/json', Accept:'application/json',
  Authorization:`Bearer ${accessToken}`,
  'X-Org-Code':'',
  'X-Raccoon-Language':'zh',
  'X-Client-Platform': identity.platform,
}
if (identity.version  !== undefined) out['X-Client-Version']   = identity.version
if (identity.deviceId !== undefined) out['X-Client-Device-ID'] = identity.deviceId
```

  `CONNECT/src/client-identity.ts:97`：`platform = process.env['RACCOON_CLIENT_PLATFORM']?.trim() || 'desktop'`。
  **`CONNECT` 的平台值是 `'desktop'`，`LOCAL` 是 `'desktop-windows'` —— 两者不同**，而官方是 `desktop`/`web`（`UPSTREAM:50`）。**`'desktop-windows'` 的来源未验证**（`LOCAL` 未注明出处）。

- `MAGPIE:400-401`：

```js
const desktopHeaders = { "X-Client-Platform":"desktop-windows", "X-Client-Version":"v1.0.0" }
const mobileHeaders  = { "X-Client-Platform":"app-android",      "X-Client-Version":"v1.0.3" }
```

  `app-android` 只用于 mobile 首登奖励端点（`MAGPIE:397,414`）。

### 3.3 `x-raccoon-session-id`（只有 `LOCAL` 发）

`LOCAL/src/raccoon.ts:347-358`：

```ts
// The chat headers, including the session id the gateway counts sessions by.
// Only chat carries it: the catalogue, quota and check-in routes are plain
// business calls the official client sends outside any session.
private async chatHeaders(token, model) {
  const base = raccoonHeaders(token)
  const sessionId = await this.sessionIds.for(model).catch(() => undefined)
  return sessionId === undefined ? base : { ...base, 'x-raccoon-session-id': sessionId }
}
```

**动机**（`LOCAL/src/raccoon.ts:175-187`，很有说服力）：

> 「The official client never opens a session per request — measured on its own logs, **125 calls over 26 minutes all carried one `sess-0-53927d74`** — while an implementation that mints a fresh id per request tells the gateway that one account opened hundreds of sessions within minutes.」

`LOCAL/src/raccoon.ts:211-214` 的格式与生成：

```ts
export function raccoonSessionId(principal, model) {
  const digest = createHash('sha256').update(`${principal}\0${model}`).digest('hex').slice(0, 8)
  return `sess-0-${digest}`
}
```

- 形状 `sess-<sequence>-<8 hex>`，序号**固定 0**（重启后同一会话不换 id）。
- `principal` 是账号标识（JWT 的 `sub`），**不出进程**，只发摘要。
- **该头是否为上游必需：未验证**。它是「别让网关以为你在刷号」的卫生措施，不是协议硬要求。

### 3.4 版本常量

| 实现 | 常量 | 值 |
| --- | --- | --- |
| `LOCAL` | `RACCOON_CLIENT_VERSION` | `'v1.0.35'`（`raccoon.ts:30`，硬编码） |
| `MAGPIE` | desktop / mobile | `'v1.0.0'` / `'v1.0.3'` |
| `CONNECT` | 无常量 | 从 `update-install-attempt.json` 或 `resources/app-update.yml` 读，读不到就不发 |
| `CONNECT`（自身版本） | `RACCOON_CONNECT_VERSION` | 构建期注入，与 `package.json` 一致（`version.ts:13-14`） |

`CONNECT/src/client-identity.ts:59-63` 解释为何宁可不发：「the header is optional, and **a wrong version is worse than no version at all**」。

**实现建议**：`X-Client-Version` 不是鉴权要素（当前无证据表明它会拒绝请求）。要么读真实安装版本，要么不发；**不要硬编码一个假版本**。

### 3.5 UA

- **没有任何参考实现设置 `User-Agent`。** 三份实现都用 Node/undici 默认 UA 或宿主 fetch 默认值。
- 官方 web 端从 UA 解析平台/版本/设备号，但**服务端是否校验 UA：未验证**。
- 本机所有探针用 curl 默认 UA，全部得到正常业务响应（401/400），**说明 UA 不是硬门槛**。

---

## 4. 模型目录

### 4.1 请求

```http
GET https://xiaohuanxiong.com/api/web/llm/v2/model_catalog
Authorization: Bearer <access_token>
```

- `CONNECT/src/upstream.ts:351-362`：`GET ${llmBase}/model_catalog`，用统一 `headers()`。
- `LOCAL/src/raccoon.ts:387`：`authorizedJson('/llm/v2/model_catalog')`。
- `MAGPIE:19`/README：`GET {llmBase}/model_catalog`，10 分钟 TTL，失败回落静态清单。
- 本机实测：假 Bearer → **401 `{code:200003}`**，路径存在。

### 4.2 返回结构

```json
{"code":0,"data":{"categories":[
  {"type":"chat","default_model":"<name>","models":[
    {"name":"<模型 id>",
     "description":"<产品名，如 GLM-5-3>",
     "display_description":"<一句话用途说明>",
     "visible":true,
     "model_name":"<可选别名>",
     "tags":["general","code","vision","reasoning"],
     "ability_level":3,
     "params":{"context_window":1000000,"max_tokens":100000},
     "billing_multiplier":0.75,
     "billing_effective_multiplier":0.6,
     "billing_status":"discount",
     "billing_status_note":"限时折扣",
     "billing_discounts":[{"name":"..","multiplier":0.8,
                            "daily_start":"..","daily_end":"..",
                            "start_at":"..","end_at":"..","active":true}]}
  ]}
]}}
```

**逐字段**（`UPSTREAM:62-73` 的 asar 解析器实测 + `CONNECT/src/catalog.ts:337-367` 的解析代码，两处一致）：

| 字段 | 类型 | 说明 | 解析要点 |
| --- | --- | --- | --- |
| `name` | string | **模型 id**，也是 `/chat/completions` 的 `model` 取值 | 必填；空则丢行 |
| `description` | string | **产品名**（`GLM-5-3`） | 人类可读名优先取它 |
| `display_description` | string | **用途描述句**（不是名字！） | 与 `description` 不同，见下 |
| `visible` | bool | `false` = 不展示 | `CONNECT` 判 `visible !== false` |
| `model_name` | string? | 别名 | `LOCAL` 作为 `description` 的 fallback |
| `tags` | string[] | 能力标签 | `image` / `image-understanding` 归一为 `vision`；上限 32 个 |
| `ability_level` | int | 能力档位 | **缺省按 1**（`?? 1`） |
| `params.context_window` | int | 上下文窗口 | 顶层也有同名 fallback |
| `params.max_tokens` | int | 输出上限 | 同上 |
| `billing_multiplier` | number | **原价倍率**（>0） | `positiveNumber` |
| `billing_effective_multiplier` | number | **折后实际倍率**（≥0） | `nonNegativeNumber`；**优先用它** |
| `billing_status` | string | `normal` / `discount` / `limited_free` | 三值枚举，其他值丢弃 |
| `billing_status_note` | string | 促销文案（「限时折扣」） | 可空 |
| `billing_discounts` | array | 促销明细 | 每条含 `name/multiplier/daily_start/daily_end/start_at/end_at/active` |

**两个字段名极易搞混，务必分清**（`LOCAL/src/catalog.ts:289-292` 注释）：

> 「The catalogue's `name` is both the model id and the value the completion endpoint accepts; **the human label comes from `description` (the product name), while `display_description` is a workload sentence shown as the description**.」

即：`name`=id、`description`=名字、`display_description`=描述。`LOCAL` 在 `display === parsed.name` 时把 `description` 置空（`LOCAL/src/catalog.ts:323`），避免重复展示。

**倍率算法**（`CONNECT/src/catalog.ts:357-362` + `:267-279`）：

```ts
function billingMultiplier(record) {
  const effective = record.billing_effective_multiplier
  if (typeof effective === 'number' && effective >= 0) return effective   // 折后优先
  const base = record.billing_multiplier
  return typeof base === 'number' && base >= 0 ? base : undefined
}
```

促销因子是**对原价的乘数**，不是结果价：`effective = billing_multiplier * best.multiplier`（取 `active` 折扣里 `multiplier` 最小的一条）。`CONNECT/src/catalog.ts:267-279` 注释强调「promotion's `multiplier` is a **factor on the list price**, not the resulting price」，并给了实测对照：

```
sn-glm-5-3-flash   原价 0.2 × 折扣因子 0.5 = 上游明说 effective 0.1
限免一个月          原价 0.5 × 因子 0      = 上游明说 0
```

**注意**：目录一次抓取要展示数小时，而促销有 `daily_start`/`daily_end` 时间窗，所以 `CONNECT` 在**展示时**重新推导（`modelWithCurrentBilling()`），而不是在解析时固化 ——「'currently discounted' cannot be baked in at parse time」。

**`isRateUnknown` 判据**（`CONNECT/src/catalog.ts:331-333`）：倍率、折后倍率、促销列表、促销文案**四者全无**才算「未知价格」（这是过期促销的残留形态）。

### 4.3 解析规则与清洗

`CONNECT/src/catalog.ts:380-405` 与 `UPSTREAM:76-79` 一致：

1. **只取 `categories` 里 `type === 'chat'` 的那一组**。其他组（work / code 等）全部忽略。
2. `visible === false` 的行**丢弃**。
3. **名字或 id 等于 `raccoon-work` 的行丢弃** —— 注释：「`raccoon-work` is the app's own agent-routing row, not a chat model」（`CONNECT/src/catalog.ts:395-397`）。
4. `default_model` 不在清洗后的列表里 → **退回首行**（`catalog.ts:402-403`）。
5. 同名去重，**首个生效**（`MAGPIE:19`、`catalog.ts:394` `seen` 集合）。
6. **解析后为空视为失败**，不能拿空列表冒充目录（`CONNECT/src/upstream.ts:360` 抛 `model_catalog resolved to an empty list`）。

**信封容错**（`CONNECT/src/catalog.ts:380-383`）：同时接受 `{code, data}` 与**裸文档** ——「the gateway has been observed to answer either way depending on the endpoint」。`code !== 0` 直接判失败。

**不要截断响应体**（`CONNECT/src/upstream.ts:259-273` 的教训）：

> 「That cap was survivable while the gateway's `model_catalog` document fitted in 4 KiB, but the roster is account-dependent and grows: once it crossed 4096 characters the slice cut the document mid-string, `JSON.parse` threw... **new models never appeared**」

**真实目录样本**（`UPSTREAM:107-115`，2026-09-16 真机，个人账号 `office_identity: personal`、`owner_type: users`）：

```
default_model = sn-sensenova-6-8-flash-lite

sn-sensenova-6-8-flash-lite  SenseNova-6.8-Flash-Lite  ctx 256000  max 63999  rate 0     tags general,chat,rewrite,summary,fast,vision  限免一个月
sn-glm-5-3                   GLM-5-3                  ctx 1000000 max 100000 rate 0.75  tags general,office,code,vision,debug,analysis,html,reasoning
sn-kimi-k3                   Kimi-K3                  ctx 1000000 max 100000 rate 1     tags ...同 glm-5-3...
sn-glm-5-3-flash             GLM-5-3-Flash            ctx 1000000 max 100000 rate 0.1   tags general,chat,rewrite,summary,fast      限时折扣
sn-deepseek-v4-pro           DeepSeek-V4-Pro-0813     ctx 1000000 max 100000 rate 0.5   tags general,code,html,analysis,reasoning,auto
```

> **目录是按账号变化的**：`UPSTREAM:86-88` 提到账号绑定的 hosted profile（如 `sn-glm-5-3-flash`，`contextWindow` 1000000，`maxTokens` 100000，`profileId` `hosted:<hash>`）。**不要内置一份静态模型表当权威**，只能当兜底。

### 4.4 `model_catalog` 的 OpenAI 兼容形态

**上游没有 OpenAI 兼容的 `/v1/models`** —— `GET /api/web/llm/v2/models` 实测 **404**。

要暴露 OpenAI 形态，必须**自己合成**。`CONNECT/src/shim.ts` 的做法（回环 façade，`shim.ts:2-14`）：

```ts
/** Model list in OpenAI's `/v1/models` shape. */
models(): { object: string, data: { id: string, object: string, owned_by?: string }[] }

// shim.ts:210-212
{ object: 'list',
  data: (options.catalog?.().current() ?? []).map(model => ({ id: model.id, object: 'model' })) }
```

关键设计（`shim.ts:5-6, 14`）：

- 回环 `127.0.0.1:<随机端口>` 提供 OpenAI 兼容 HTTP。
- **上游 SSE 原样逐字节 pipe** ——「so usage accounting, ...」
- 只有**非** OpenAI 兼容的部分（模型名解析、错误映射）在 façade 里处理。

**注意**：`chat/completions` 本身**是** OpenAI 兼容的（§5.1），所以 façade 主要解决的是「模型目录形态」和「Raccoon 特有 header / 错误码」，而不是报文改写。

---

## 5. 对话

### 5.1 请求体：OpenAI 兼容

```http
POST https://xiaohuanxiong.com/api/web/llm/v2/chat/completions
Authorization: Bearer <access_token>
Content-Type: application/json

{"model":"<name>","stream":true,
 "messages":[{"role":"user","content":"..."}],
 "max_tokens":..,"temperature":..,
 "tools":[...],"tool_choice":"auto"}
```

**三份实现一致：body 原样透传，不做私有报文改写。**

- `UPSTREAM:83-85`：「标准 OpenAI Chat Completions 形状，流式 SSE；本地 agent 就是按 `provider:"openai"` + `apiBase = https://xiaohuanxiong.com/api/web/llm/v2` 直连……**因此插件不需要 WorkBuddy 那类私有报文改写**」
- `CONNECT/src/upstream.ts:386-392`：「The body is passed through as the caller built it: this gateway is the same OpenAI-compatible endpoint the desktop app's own agent uses, so **rewriting fields here would only risk diverging from what it actually accepts**」
- `MAGPIE:18,321-326`：「OpenAI 兼容 body 原样透传」「the body passes through untouched (agent2api build_chat_request)」

**唯一常见的改写**：`MAGPIE` 把 SSE 回帧里的 `model` 名回写成客户端请求的名字（`MAGPIE:330-380` `rewriteModel`），因为「the vendor's gateway writes its own model name into every reply」。**这不是协议要求，是体验修正。** 非流式响应同样改（`MAGPIE:336-345`）。

`LOCAL` 构造的 body（`wire.ts:303-312`）：

```ts
{ stream: true,
  ...options.maxTokens === undefined ? {} : { max_tokens: Math.floor(options.maxTokens) },
  ...options.temperature === undefined ? {} : { temperature: options.temperature },
  ...tools === undefined ? {} : { tools, tool_choice: 'auto' } }
```

### 5.2 工具调用：透传，无特殊处理

- `tools` 按标准 OpenAI 形状发（`LOCAL/src/wire.ts:291-292` 把宿主工具映射为 `{type:'function', function:{...}}`）。
- 响应侧解析 `delta.tool_calls` 分片累加（`LOCAL/src/wire.ts:425-433, 573-594`）。
- **没有任何实现报告上游拒绝工具调用或需要特殊字段。** 即：**工具调用是纯标准 OpenAI 形状，透传即可。**
- **`tool_choice` 的接受范围未逐一验证**（只观察到 `'auto'` 被使用）。

### 5.3 `reasoning_effort`：可取值与网关校验缺陷

**这是本协议最容易被写错的一节，必须照做。**

**背景**：目录里**没有任何字段**声明档位词表。`CONNECT/README.md:166`：

> 「小浣熊这边没有这个字段——目录行的全部字段是 `name / description / display_description / visible / model_name / tags / ability_level / params / billing_*`，**没有任何一处提到档位**，App 自己也从不发 `reasoning_effort`。」

**逐值实测**（`UPSTREAM:159-168`，`sn-glm-5-3-flash`，`max_tokens:8`，读到首个 SSE 事件即断）：

| 值 | 结果 |
| --- | --- |
| 不传 | 200 |
| `low` / `medium` / `high` / `xhigh` / `max` | 200 |
| `none`、`probe_sentinel_deadbeef…`、`randomword1234567890` | **200（被放过）** |
| `off`、`banana` | **400** |

400 报文：

```
litellm.BadRequestError: Custom_raccoonException - 该模型始终思考，不支持关闭思考；请使用 low、high 或 max。
```

**结论（`UPSTREAM:176-184`）**：

> 「网关做的是**部分**校验——它拦住"关闭思考"一类的值，但对无意义字符串照单全收。因此"某个档位返回 200"**不能证明**这个档位真被模型执行：垃圾值同样 200。」

**这条的后果很实际**：`low`/`medium`/`high`/`xhigh`/`max` 全部 200，而 `banana` 也……不，`banana` 是 400。但 `randomword1234567890` 是 200 —— **所以「200」不能作为「该档位生效」的证据**。

**推荐的探测协议**（`CONNECT/src/probe.ts:5-20`，顺序即协议）：

```
1. baseline  — 不传 reasoning_effort。失败 ⇒ unknown，什么都不用测了。
2. sentinel  — 发一个不可能存在的值 probe_sentinel_<24 hex>。
               被接受(200 且开始流式) ⇒ 判定 non-validating，**不给档位控件**。
3. 逐个候选档位发；只有 sentinel 被拒（validating）时，逐档的 200 才有意义。
```

`sentinel` 生成（`CONNECT/src/probe.ts:72-73`）：

```ts
export function sentinelValue(randomHex) { return `probe_sentinel_${randomHex()}` }
// 24 hex 随机，保证永不与真实值碰撞
```

**判定谓词**（`CONNECT/src/probe.ts:66`）：「200 **and** streaming began」才算 accepted —— 光看状态码不够。

**拒绝识别**（`CONNECT/src/probe.ts:56`）：

```ts
const REFUSAL_PHRASES = ['params_invalid', 'invalid_reasoning_effort', 'reasoning_effort']
```

**探针必须省钱**（`CONNECT/src/upstream.ts:424-431`）：

> 「`max_tokens` is kept at the gateway's floor and the reader hangs up on the first SSE event, because **a probe that waits for a full answer is a paid completion wearing a lab coat**.」

`max_tokens` 默认 **1**（`upstream.ts:440`），并且**读完首事件就 cancel**、不 drain（`upstream.ts:185-188`：`// Cancel rather than drain: the upstream bills for what it generates.`）。

**400 文案不可解析**（`UPSTREAM:182-183`）：「请使用 low、high 或 max」是给人看的散文，不是结构化字段。「解析它属于脆弱的猜测，插件不解析」。

**`off` / `minimal` 永不探测**，也不进档位映射（`UPSTREAM:184`）。

**另一条正交事实**（`UPSTREAM:124-126`）：目录里的 `reasoning` **标签**不能当作「支持 `reasoning_effort`」或「会输出思考」的依据 —— `sn-glm-5-3-flash` 没有该标签，实测照样输出 `reasoning_content`。标签描述的是 **App 侧的路由预设**。

`LOCAL` 的做法不同（`raccoon.ts:547-557`）：它不发档位探测，改用 `extra_body.thinking.type` 开关 + OpenRouter 元数据给的档位：

```ts
if (effort === RACCOON_EFFORT_OFF || effort === 'none') {
  body.extra_body = { thinking: { type: 'disabled' } }
  if (effort === 'none') body.reasoning_effort = 'none'
} else {
  body.extra_body = { thinking: { type: 'enabled' } }
  if (effort !== RACCOON_EFFORT_ON) body.reasoning_effort = effort
}
```

- `RACCOON_EFFORT_ON = 'on'`、`RACCOON_EFFORT_OFF = 'off'`（`LOCAL/src/catalog.ts:57-58`）。
- **`extra_body.thinking` 是否被小浣熊网关接受：未验证。** 这是 OpenAI/OpenRouter 风格的扩展字段，`UPSTREAM` 的实测只覆盖 `reasoning_effort`。**不要假设它生效。**

### 5.4 流式 SSE 与 `[DONE]`

**标准 SSE**，`Content-Type: text/event-stream`，帧形如 `data: {...}\n\n`，结束帧 `data: [DONE]`。

- `CONNECT/src/upstream.ts:181` 判流式开始：`/data:\s*(\[DONE\]|.{1,})/u`。
- `LOCAL/src/wire.ts:528`：`if (event.data.trim() === '[DONE]')` 结束。
- `MAGPIE:353`：`if (!data || data === "[DONE]") return text`（原样透传结束帧）。
**空 `content` 是正常现象**：思考阶段 `delta.content` 为空串，正文在思考结束后才来（`UPSTREAM:117-120`）。

**`max_tokens` 太小会得到「只有思考、没有正文」的空回复** —— `UPSTREAM:127` 实测 16 tokens 即如此。**实现不应主动设小档位**，输出上限取目录的 `params.max_tokens`。

**个别实现有非流式兜底**（`LOCAL/src/wire.ts:616`）：「Non-streaming fallback for a gateway that ignores `stream: true`」—— 说明**存在上游忽略 `stream:true` 的可能**，建议实现方准备兜底路径。

### 5.5 思考内容字段

**思考文本走非标准字段 `choices[].delta.reasoning_content`**，而 `delta.content` 在思考阶段为空串。

`UPSTREAM:117-120`：

> 「思考文本走**非标准字段** `choices[].delta.reasoning_content`，而 `delta.content` 在思考阶段为空串。pi-ai 的 `openai-completions` 已经按 `reasoning_content → reasoning → reasoning_text` 顺序识别该字段并转成 `thinking_delta`。」

识别顺序（`LOCAL/src/wire.ts:418-423`）：

```ts
function deltaReasoning(delta) {
  for (const key of ['reasoning_content', 'reasoning', 'reasoning_text']) {
    if (typeof delta[key] === 'string') return delta[key]
  }
}
```

**非流式**响应里同一字段出现在 `message.reasoning_content`（`LOCAL/src/wire.ts:624-626`，同样有 `reasoning` 回退）。

**实现建议**：按上述三键顺序取，**优先 `reasoning_content`**；三者都没有就是没有思考内容，不要凭空造。

### 5.6 错误码表

**信封**：`{code, message, details}`。**HTTP 200 也可能是业务失败** —— `CONNECT/src/upstream.ts:282-289`：

> 「A non-zero code is a failure even on HTTP 200」

**实测到的码**（本机 + `UPSTREAM` + 同事侦察）：

| code | message | HTTP | 含义 | 处理 |
| --- | --- | --- | --- | --- |
| `0` / `"OK"` | success | 200 | 成功 | — |
| `200001` | `authorization_empty_error` | 401 | 漏传凭据 | 编程错误 |
| `200003` | `authorization_verify_error` | 401 | Bearer 校验失败 / 登录态失效 | 触发刷新；再 401 则重新登录 |
| `200035` | `authorization_code_not_found_error` | 400 | 授权码已用/过期/不存在 | **不可恢复，重新发起登录** |
| `200822` | `refresh_conflict` | 400 | refresh token 冲突或已复用 | 先重读桌面文件（§2.4） |
| `100002` | `params_invalid_error` | 400 | 参数名/格式错（`param token…`、`param payload iss invalid`） | 编程错误 |
| `200402` / `200429` / `100402` | — | — | 积分不足（`CONNECT/src/upstream.ts:47`） | 终止，提示充值 |
| `user_model_rate_limited` | `您的模型请求频率超限` | 429 或 200 流内错误帧 | **令牌吞吐墙**，非请求频率 | 退避重试 |

**分类映射**（`CONNECT/src/upstream.ts:34-41, 74-95`）—— **顺序很重要**：

```ts
const KIND_STATUS = { hard_credit:402, soft_rate:429, session_dead:401,
                      not_found:502, server:502, client:400 }

const SESSION_DEAD_CODES = new Set(['200003','200822'])
const CREDIT_CODES       = new Set(['200402','200429','100402'])
const CREDIT_PHRASES     = ['积分不足','余额不足','点数不足','quota exceeded',
                            'insufficient balance','insufficient points','payment required']
const RATE_PHRASES       = ['频繁','too many requests','rate limit']

// classifyUpstreamError(): 先读 code/message，再让 status 决定
if (SESSION_DEAD_CODES.has(code)) return 'session_dead'
if (CREDIT_CODES.has(code) || CREDIT_PHRASES.some(p => lower.includes(p))) return 'hard_credit'
if (status === 429 || RATE_PHRASES.some(p => lower.includes(p))) return 'soft_rate'
if (status === 401 || status === 403) return 'session_dead'
if (status === 404) return 'not_found'
if (status === 0 || status >= 500) return 'server'
return 'client'
```

为什么要先看 code：`upstream.ts:71-73` ——「the gateway answers most failures with HTTP 400 plus a business code, so **the code and message have to be read before the status decides**」。

**429 的真实语义**（`LOCAL/src/raccoon.ts:104-113`，实测得来，容易误判）：

```ts
export const RACCOON_RATE_LIMIT_CODE = 'user_model_rate_limited'
```

> 「It reads like a request-rate complaint (`您的模型请求频率超限`) and is **not** one: measured on a live account, **ten large requests in ten seconds hit it while fifty small ones did not**, and the window refills by **throughput** rather than by request count. The gateway sends **no `Retry-After` and no `x-ratelimit-*` header**, so nothing here can compute a wait either.」

**所以：拿不到等待时间，只能指数退避。**

同一条件会以**两种形态**出现（`LOCAL/src/raccoon.ts:120-128`）：HTTP 429，**或 200 流内的一帧 `error`**。两者都要识别。

**流内错误帧结构**（`LOCAL/src/raccoon.ts:160-173`）：`frame.error` 可能是字符串或 `{code, message}` 对象。

---

## 6. 积分与签到

### 6.1 余额

```http
GET https://xiaohuanxiong.com/api/web/points/v1/balance
Authorization: Bearer <access_token>          # 企业版另加 X-Org-Code
```

返回 `{code, data:{...}}`。**字段名有多个历史形态，必须按顺序回退**：

`LOCAL/src/raccoon.ts:439-450`：

```ts
const available = numeric(data.available_points)
  ?? numeric(data.total_chargeable_points)
  ?? numeric(data.total)
  ?? numeric(data.balance)
  ?? numeric(data.points)
if (available === undefined) throw new Error('小浣熊额度响应格式无法识别。')
// snapshot: { total, available, permanent: reward_points, daily: daily_points }
```

- **主字段是 `available_points`**（注释：「Raccoon reports `available_points`; the other keys are legacy shapes」）。
- 另可取 `reward_points`（永久积分）与 `daily_points`（每日积分）。
- `CONNECT/src/upstream.ts:376-378` 的回退列表更长：`total/available/available_points/balance/remain/points/remain_points`，套餐取 `plan/plan_name/package/package_name/type`。
- 前端默认值里还有 `enterprise_topup_points`、`user_category:"toc"` 等（`FE-WORK` 的余额初始对象），说明**企业账号有独立字段**。

**企业版要带 `X-Org-Code`**：`FE-WORK` 的 `getBalance()` —— `headers: e ? {"X-Org-Code":(0,n.Wb)()} : void 0`，`e = (0,n.IJ)()` 即「是否企业版」。

### 6.2 签到：**没有签到端点**，是按天幂等发放

**这是最容易误解的一点。**

`LOCAL/src/raccoon.ts:465-471` 逐字：

> 「Raccoon has **no standalone check-in endpoint**. The daily points are issued by the server on the **first authenticated web visit** and announced through `point_grant_popups` on `setting_info`; the bills list is the durable proof.」

**触发方式**：`GET /api/web/office/v3/setting_info`（带桌面端身份头）→ 服务端按天幂等发放 → 响应里出现 `point_grant_popups`。

第一方证据（`FE-WORK` 逐字）：

```js
V.getUserSettingInfo = async () => {
  let t = (0,a.IJ)(),
      r = await o.nC.fetchWithAuth(
        t ? `${(0,o.fb)()}/office/${(0,o.$_)()}/setting_info` : `${(0,o.e9)()}/setting_info`,
        { method:"GET", headers: t ? {"X-Org-Code":(0,a.Wb)()} : void 0 }),
      n = r.data?.point_grant_popups;
  if(n?.length) F.B.emit(O.R.SHOW_POINT_GRANT_POPUPS, n);
  if(r.data && "point_grant_popups" in r.data){ let {point_grant_popups:e, ...t} = r.data; r.data = t }
  return r
}
```

注意两点：
1. **`point_grant_popups` 是响应字段**（弹窗内容），前端还把它从 `data` 里剥掉再往下传。
2. **企业版带 `X-Org-Code`，个人版不带** —— 与 §3.1 一致。

`MAGPIE:438-442` 用桌面端头触发：

```js
await getJSON(`${mainOrigin()}/api/web/office/v3/setting_info`, token, 20_000, {
  "X-Client-Platform":"desktop-windows",
  "X-Client-Version":"v1.0.0",
  "X-Raccoon-Language":"zh",
})
```

**核对是否到账**：查账单，不查签到状态。

```http
GET /api/web/points/v2/bills?paging.limit=50&type=all
```

`LOCAL/src/raccoon.ts:472-503` 的 `dailyGrant()` 判据：

```ts
if (item?.biz_type !== 'daily_grant') continue
// grant_at 是积分所属日；created_at 是实际发放时刻。两者都必须是今天
const day = item.grant_at ?? item.created_at
if (raccoonDay(day) !== today) continue      // today 按 Asia/Shanghai 算
```

- **`biz_type === 'daily_grant'`** 是流水类型。
- **必须按北京时间（`Asia/Shanghai`）比对日期**，双字段同时校验（防止「昨天发的昨天的份」被算成今天的）。
- `LOCAL/src/raccoon.ts:85-92` 用 `Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Shanghai', ...})` 得到 `YYYY-MM-DD`。

`MAGPIE:450-459` 更宽松：不做 `biz_type` 过滤，直接累加今天所有 `points > 0` 的流水。

**是否有「领了没到账」的中间态：未验证。** 两个实现都在触发后**再查一次账单**才敢报 `claimed`，这个「触发+核对」的两步结构建议照抄。

**`LOCAL` 刻意只读不触发**（`raccoon.ts:506-514`）：

> 「Read today's grant. **Read-only on purpose.** ... Replaying that visit (`setting_info`) can trigger the grant from here, but doing so takes a state-changing action on the account without the user asking for it in that moment, so the plugin only reports.」

**这是一个产品决策，不是技术限制** —— 如果你要做「一键签到」，`setting_info` 是可行手段（服务端按天幂等，重复调用安全）。

`CONNECT` **完全不做签到**（只有余额读取，`upstream.ts:365-384`），`RACCOON_CHECKIN_URL = 'https://xiaohuanxiong.com/work/home'` 只是给用户点过去的链接。

### 6.3 新手奖励：两条 grant

**两个独立端点，各领一次，各 3000 分。**

`MAGPIE:395-401` 逐字：

```js
const ONBOARDING_TASKS = [
  { key:"desktop_login_grant", title:"首次电脑端登录奖励",
    path:"/api/web/desktop/v1/login/points/grant", mobile:false },
  { key:"mobile_login_grant",  title:"首次手机端登录奖励",
    path:"/api/web/mobile/v1/login/points/grant",  mobile:true  },
]
const ONBOARDING_POINTS = 3000
const desktopHeaders = { "X-Client-Platform":"desktop-windows", "X-Client-Version":"v1.0.0" }
const mobileHeaders  = { "X-Client-Platform":"app-android",      "X-Client-Version":"v1.0.3" }
```

**响应**（`MAGPIE:411-422`）：

```json
{"granted": true|false, "popup": {"points": 3000}}
```

- `getJSON` 已解 `{code,data}` 信封，拿到的是 `{granted, popup?}` 本体。
- `granted === true` 才算领到；`popup.points` 缺省按 `ONBOARDING_POINTS`(3000) 计。

**上游没有「领没领过」的只读端点**（`MAGPIE:388-394`）：

> 「The vendor has **no read-only "did this account already claim its first login reward" endpoint**, so the only source of truth is this account's own ledger」

**本地台账语义**（`MAGPIE:462-473` + `ADR2:36`）：

- 一次请求**无论 `granted` 真假都算该条落定** ——「either answer means the reward is decided」。
- 落定后**永不再发请求**。
- 老账号奖励早被官方客户端领掉 → 首次请求回 `granted:false` → 同样落定。
- 单条失败**不阻断**另一条，下一轮再试（重复调用上游安全）。

**关键约束**：`app-android` 与 `desktop-windows` **两端认同一把 Bearer token**（`MAGPIE:22` README）。不需要两个账号。

### 6.4 企业 / 教育账号差异

**已确认有的差异**：

| 项 | 个人 | 企业 | 证据 |
| --- | --- | --- | --- |
| `X-Org-Code` | 空（不发） | 必带 | `FE-WORK` 各 `getXxx` 的 `t ? {"X-Org-Code":...} : void 0` |
| 业务前缀 | `/api/web/office/v3` | `/api/web/org` 系列 | `FE-WORK` `prefixes.org:"/api/web/org"` |
| 组织信息 | `office_org_name`/`office_org_role` 为空 | 有值 | `auth.json` 字段语义 |
| 余额字段 | — | `enterprise_topup_points` | `FE-WORK` 余额初始对象 |

**已确认为「存在但未实现」的域**（`FE-WORK` 出现的端点，本协议不展开）：

```
/api/web/enterprise/v1/enterprises/sensetime/join_office_org
/api/web/enterprise/v1/enterprises/sensetime/email_code
/api/web/education/v1/...
/api/web/org/user
/api/web/org/org/v1/info
/api/web/org/setting/v1/settings
```

> **教育账号**：`/api/web/education/v1` 确实存在，但**具体协议未侦察**（不在本次范围）。若有教育账号需求，这是唯一的线索。

**`office_identity` 的取值**：`UPSTREAM:104` 实测个人账号为 `personal`；`owner_type` 为 `users`。企业取值**未验证**（无企业账号）。

---

## 7. 账户池相关

### 7.1 同一账号是否允许多端 / 多刷新

**结论：技术上允许多端并发使用同一 access token；但 refresh token 的单次轮转使「多处各自刷新」必然互相作废。**

证据链：

1. **access token 是普通 Bearer JWT，服务端无设备绑定证据。** 三份实现都在不同机器上复用同一个 token，未见 401。
2. **refresh 是单次使用**（`UPSTREAM:36-38`）：旧 token 再用 → `200822 refresh_conflict`。**所以 N 个持有同一 refresh token 的客户端，只有一个能成功刷新，其余全部作废。**
3. `CONNECT` 因此设计了「先重读桌面文件」—— 因为**客户端和插件共享同一个文件**，客户端刷新会写文件，插件重读就能跟上。
4. `MAGPIE` 因此明确警告**不要与 agent2api 并存**（`README:26`）：

> 「小浣熊的 refresh token 可能在每次刷新时轮换。**同一账号同时由本插件与 agent2api 刷新，会互相作废对方保存的 token**——导入后建议在 agent2api 面板里停用小浣熊账号」

**所以「多端」可以，但必须满足其一**：

- 所有客户端**共享同一份凭据文件**（桌面场景，靠重读协调）；或
- 只有一个刷新者，其余只读 access token（但 access 3 小时就过期，不刷新活不下去）。

### 7.2 多账号在上游是否可能

**结论：上游支持多账号，但「一个桌面客户端 = 一个账号」；账户池必须由插件自己维护。**

**上游层面**：`/api/iam/v1` 与 `/api/web/auth/v1` 是标准账号体系，**没有「一个用户只能一个登录态」的证据**。多账号 = 多个独立 token 对，服务端不阻止。

**桌面客户端层面**：**只承载一个账号**。

- `auth.json` 是**扁平单账号**结构，没有 `accounts[]` / `profiles[]` 容器（`CONNECT/src/auth.ts:94` 的 5 键列表）。
- `CONNECT` 的 variant 里 Raccoon 只有**一个** `ownFilename`（`.raccoon-auth.json`），对比它对其他产品有按区域分槽的设计。
- 同事 `DESKTOP-CREDS.md` §4 三条独立证据得出同结论。

**可行的账户池来源**：

| 来源 | 可行性 | 说明 |
| --- | --- | --- |
| 桌面端 | 1 个 | 一份 `auth.json` 一个账号 |
| 多个 `BOX_AGENT_CONFIG_DIR` 目录 | 技术上可行 | 等于「装了几套互不相干的登录态」；App UI 无切换入口，需用户手工准备 |
| 网页登录（授权码/扫码）另行登录 | **每个账号独立** | 与桌面凭据互不依赖，可叠加 |
| `~/.agent2api/agent2api.db` 一次性导入 | 取决于存量 | `MAGPIE:480-520` 只读导入；本机不存在 |

**关键**：`CONNECT` 的 `accountId` 机制证明「插件自己的多账号台账」是可行且必要的（`auth.ts:169-209` 用 JWT claims + token 摘要算账号键），但它**同时只激活一个**（`ownFilename` 单文件）。

**要做真账户池，实现必须自己存 N 份凭据**，并解决 §7.1 的刷新互斥。

### 7.3 并发刷新会不会互相作废 token

**会。这是确定的，不是猜测。**

- refresh 单次使用（`UPSTREAM:36-38` 的 `200822` 实测）。
- `CONNECT/src/auth.ts:356-358` 明确把「single-flight」列为必须：

> 「**Single-flight**, so parallel requests share one refresh — which matters more here than in a read-only design, because **two concurrent refreshes would burn one single-use refresh token and strand the other caller**.」

- `CONNECT/src/auth.ts:369`：`this.inflight ??= this.refreshNow(credential)`。
- `MAGPIE:293-306` 用**串行锁 + 已花费令牌的记忆表**：

```js
let lock = Promise.resolve()
const locked = (fn) => { const run = lock.then(fn, fn); lock = run.catch(()=>{}); return run }
const given = new Map()
const renewOf = async (a) => {
  if (given.has(a.refresh)) return given.get(a.refresh)   // 该令牌已刷过 → 复用结果
  const got = await renewToken(a.refresh)
  if (given.size > 32) given.delete(given.keys().next().value)
  given.set(a.refresh, got)
  return got
}
```

  **「按被花费的 refresh token 记住结果」是关键设计** —— 持有旧快照的调用方不会再去烧一次。

- `AGENT2API` 把它做成独立模块 `refresh_flight.rs`（12 KB），用指纹做 key、`Arc<Flight>` 单飞、leader RAII 守卫防取消泄漏。其文件头注释记录了**两个真实踩过的坑**：

> 「1. **旧结果不能留在表里当缓存**。旧实现把「刚落地的结果」写回进程级表并长期保留，于是 `force = true`（401 之后的强制刷新）会命中那条旧记录，拿回**同一个被拒的坏 token**……
> 2. **取消（future 被 drop）必须释放占位并唤醒等待者**。旧实现里 leader 的 future 一被 drop，占位就永久留在表里 —— 后续请求全部走进等待循环，直到 30 秒超时才拿到 409，而且**再也刷不了**。」

**实现要求（照抄这三条即可避坑）**：

1. **单飞**：同一凭据同时只发一个 refresh，其余 await 同一个 Promise。
2. **结果不缓存**：单飞结束即移除，`force` 刷新必须真发新请求（否则 401 后重试会用同一个坏 token）。
3. **取消要清理**：leader 失败/中断必须移除占位并唤醒等待者，否则后续刷新会永久卡住。

### 7.4 写回桌面端 `auth.json` 的必要性与原子写

**必要性：如果你的凭据来自桌面文件，写回是强制的。**

`CONNECT/src/auth.ts:6-11`：

> 「Unlike the WorkBuddy-style "read the desktop file, never write it" design, 小浣熊's refresh token is **single-use**: refreshing rotates both tokens server-side, so **a client that refreshes without writing the pair back would log the desktop app out at its next refresh**.」

**具体后果**：插件刷新后不写回 → 客户端文件里还是旧 refresh token → 客户端下次刷新撞 `200822` → **用户被登出客户端**。

**原子写要求**（§2.2 已给代码，这里给完整性要求）：

```ts
const temp = `${path}.${process.pid}.tmp`
await writeFile(temp, payload, { encoding:'utf8', mode:0o600 })
await rename(temp, path)
```

**四个必须照做的细节**：

1. **保留未知字段**：不要重写整个文档。`CONNECT/src/auth.ts:498-505` 先 `{...existing}`，再删 5 个已知键，再写回新值。
2. **保持键序**：`CONNECT/src/auth.ts:517-527` 的 `orderedDesktop()` 把 `DESKTOP_TOKEN_KEYS` 排前、用户原有其他键排后 —— 注释说是「The app's key order first」。
3. **`mode: 0o600`**，与 App 自己的写法一致。
4. **首次写回前备份**：`CONNECT/src/auth.ts:484-492` —— 把被替换的原文存到 `$DSH_HOME/.raccoon-auth.json-desktop-backup`，「if a write-back ever strands the app's session, that file is the rollback」。

**写回失败不致命**（`auth.ts:509-513`）：catch 后只 `return`，因为「An unwritable desktop file (read-only mount, another user's profile) is not fatal: the plugin's own copy carries the session」。

**必须用文件锁串行化写回**（`auth.ts:476` 的 `withFileLock`）—— 与客户端进程可能同时写同一个文件。

**退出登录只删自己的副本**（同事 `DESKTOP-CREDS.md` §5.4）：**绝不动 App 的 `auth.json`** —— 删了等于把用户从客户端登出。

---

## 8. 现有实现对照表

### 8.1 能力矩阵

| 能力 | `CONNECT`<br>dsh-raccoon-connect | `LOCAL`<br>dsh-llm-adapters | `MAGPIE`<br>magpie-raccoon-auth | `AGENT2API` |
| --- | --- | --- | --- | --- |
| **凭据来源** | 桌面 `auth.json`（唯一） | 桌面 `auth.json` + 扫码 IAM + accounts.json | agent2api 导入 / 网页授权码 / 手动粘贴 | 桌面导入 / 文件 / 网页登录 |
| **网页登录** | ❌ | ✅ 扫码（`/api/iam/v1/auth/mp/qrcode`） | ✅ 授权码 + 手粘回调 | ✅ 授权码（内置 webview 拦截回调） |
| **多账号** | ❌ 单槽 | ✅ `accounts.json` 多账号 | ✅ magpie 账号体系 | ✅ 账号池 + 选路 |
| **refresh** | ✅ 单飞 + 冲突重读 | ✅ 单飞 | ✅ 串行锁 + 令牌记忆 + 429 冷却 | ✅ `refresh_flight.rs` 单飞 |
| **写回桌面** | ✅ 原子写 + 备份 + 文件锁 | ✅ 原子写（未验证） | ❌ 不写回 | ✅ 比较-再写 |
| **模型目录** | ✅ 全字段 + 倍率 + 促销 | ✅ 全字段 + OpenRouter 增强 | ✅ 基础字段 | ✅ `parse_catalog` |
| **对话流式** | ✅ 透传 | ✅ 透传 + `reasoning_content` | ✅ 透传 + `model` 名回写 | ✅ 透传 + `model` 名回写 |
| **工具调用** | ✅ 透传 | ✅ 透传 + 分片累加 | ✅ 透传 | ✅ 透传 |
| **余额** | ✅ | ✅ | ✅ + `entitlement_info` | ✅ |
| **签到** | ❌（只给链接） | ✅ 只读核对（不触发） | ✅ 触发 + 核对 | ✅ `claim_daily_grant` |
| **新手奖励** | ❌ | ❌ | ✅ 两条 grant + 本地台账 | ✅ `onboarding.rs` |
| **档位探测** | ✅ 哨兵协议 | ❌（用 OpenRouter 元数据） | ❌ | ❌ |
| **识图判定** | ✅ 逐模型实测表 | ✅ 标签 + 配置 + OpenRouter | ✅ 标签 | ❌ |
| **OpenAI façade** | ✅ 回环 shim | ❌（直接注册 adapter） | ❌（magpie loader） | ✅ 网关 |

### 8.2 各自发什么头

| 实现 | `Authorization` | `X-Org-Code` | `X-Raccoon-Language` | `X-Client-Platform` | `X-Client-Version` | `X-Client-Device-ID` | `x-raccoon-session-id` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `CONNECT` | ✅ Bearer | `''`（空串） | `zh` | `desktop`（默认） | 读到才发 | 读到才发 | ❌ |
| `LOCAL` | ✅ Bearer | `''`（空串） | `zh` | `desktop-windows`/`-macos`/`-linux` | `v1.0.35` | ❌ | ✅ 仅 chat |
| `MAGPIE` | ✅ Bearer | ❌ | `zh`（仅 `setting_info`） | `desktop-windows`/`app-android` | `v1.0.0`/`v1.0.3` | ❌ | ❌ |
| `AGENT2API` | ✅ Bearer | 企业版带 | — | `desktop-windows`（签到） | `v1.0.0` | — | — |

**分歧点**：`X-Client-Platform` 有 `desktop` / `desktop-windows` 两种值；`X-Org-Code` 有「发明文空串」与「不发」两种；`x-raccoon-session-id` 只有 `LOCAL` 发。**三者都未验证服务端是否校验。**

### 8.3 各自用哪条登录路径

| 实现 | 主路径 | 备选 | 拿到 refresh？ |
| --- | --- | --- | --- |
| `CONNECT` | **读桌面 `auth.json`**（零配置） | — | ✅（文件里有） |
| `LOCAL` | **读桌面 `auth.json`** | **微信扫码**（`/api/iam/v1`） | 文件✅ / 扫码❌ |
| `MAGPIE` | **agent2api 导入**（只读 sqlite） | **网页授权码 + 手粘回调**；手动粘贴 token | 导入✅ / 授权码✅ / 手动可选 |
| `AGENT2API` | 桌面端导入 / 文件 | **授权码 + 内置 webview 拦截回调**（`src-tauri/src/login.rs` `on_navigation`） | ✅ |

**没有一份实现用过 loopback 回调** —— 这是本次侦察发现的**新增可行路径**（§2.5 路径 A），第一方代码支持，且不需要 DevTools、不需要桌面客户端。

> `MAGPIE:155-158` 明确说它做手粘是因为「a magpie plugin has no browser shell, so there is nothing to intercept」。**loopback 没有这个限制** —— 任何能起本地 HTTP 服务器的进程都能用。

---

## 9. 未验证项与最大不确定点

### 9.1 三处最大的不确定点

| # | 不确定点 | 为什么不确定 | 怎么消除 |
| --- | --- | --- | --- |
| **1** | **桌面凭据的真实字段形态与是否加密** | 本机**未安装**桌面端，`~/.box-agent/config/auth.json` 不存在。全部结论来自 `UPSTREAM`（他机实测）+ 代码，非本机复核 | 在装了客户端的机器上跑同事的 `tools/probe-desktop-creds.mjs` |
| **2** | **refresh 请求到底能不能带 `Authorization`** | `CONNECT/src/upstream.ts:318-319` 注释断言「带 Authorization 会被拒」，但**第一方渲染端代码（`FE-WORK`）刷新时恰恰带了** `...v.createHeaders()`（内含 Authorization）。两说直接矛盾 | 拿真实 refresh token 各试一次（带/不带 header）。**在此之前：不带 Authorization**（`CONNECT` 与 `MAGPIE` 都不带，且都不带时能工作） |
| **3** | **授权码 loopback 路径的端到端可行性** | 第一方**代码**证明机制存在（正则、投递逻辑逐字可读），但**没有真人在浏览器完整跑过一遍** —— 需要真实登录（短信 captcha / 微信扫码），我方无凭据 | 真人跑一次：授权页 → 扫码/短信登录 → 本地 `127.0.0.1` 收 `GET /auth/callback?code=` → `login_with_authorization_code`。**这是最早应该做的验证** |

### 9.2 其余未验证项（诚实清单）

| 项 | 状态 | 尝试过什么 |
| --- | --- | --- |
| access 3h / refresh 30d | 有证据（他机） | 本机无凭据，无法复解 JWT |
| `auth.json` 明文无加密 | 有证据（他机 + 代码） | 本机该文件不存在 |
| 扫码成功返回 `access_token` | 部分（代码证据） | 需真人扫码；`LOCAL` 只取 access |
| 扫码是否有 `refresh_token` | 倾向「没有」 | 同上 |
| `iam/confirm` 下发 `xhx_token` | 未验证 | 假 Bearer → 401 且无该 cookie |
| cookie 能否直调 LLM 网关 | 未验证 | 无可信 cookie |
| `reasoning_effort` 的「有效档位」 | **不可判定** | 网关部分校验：哨兵值也 200（`UPSTREAM:167`）。**只能靠探测协议判定是否 non-validating** |
| `extra_body.thinking` 是否被接受 | 未验证 | `LOCAL` 用它，但 `UPSTREAM` 只实测了 `reasoning_effort` |
| `tool_choice` 的接受范围 | 未验证 | 只观察到 `'auto'` 被使用 |
| `X-Client-Version` 是否被校验 | **判否（弱）** | 本机所有探针用 curl 默认 UA、无该头，全部得到正常业务响应 |
| 企业账号的 `X-Org-Code` 取值 | 未验证 | 无企业账号 |
| `office_identity` 的企业取值 | 未验证 | 只实测到 `personal` |
| 教育账号协议 | **未侦察** | 只知道 `/api/web/education/v1` 存在 |
| 上游是否忽略 `stream:true` | 未验证 | `LOCAL/src/wire.ts:616` 有兜底，说明遇到过 |

### 9.3 上游改版时优先复核的地方

`UPSTREAM:186-192` 列了 5 条，本次侦察**补充 3 条**：

1. `auth.json` 的字段名与 `BOX_AGENT_CONFIG_DIR` 语义
2. refresh 的单次使用语义与是否继续同时回写两份令牌
3. `model_catalog` 的 `categories[].type === "chat"` 与 `billing_*` 命名
4. 个人版 `X-Org-Code` 是否仍可为空
5. `tags` 里的 `vision` 与真实识图能力的对应关系
6. **（新）** 授权页 `desktop_callback=loopback` 的参数校验正则（`127.0.0.1` 硬编码、`state` 必须 64 hex）
7. **（新）** `/api/web/office/v3/setting_info` 的 `point_grant_popups` 字段
8. **（新）** refresh 的错误明细（本机观察到 `param payload iss invalid`，与 `UPSTREAM` 记录的 `100000 request_body_error` 不一致，说明已在改）

---

## 10. 实现清单（照做即可）

```
□ 基址常量：site = https://xiaohuanxiong.com
             llm  = {site}/api/web/llm/v2
             auth = {site}/api/web/auth/v1
             iam  = {site}/api/iam/v1
□ 凭据：优先读 BOX_AGENT_CONFIG_DIR ?? ~/.box-agent/config，文件名 auth.json
         字段 access_token / refresh_token / office_identity / office_org_name / office_org_role
         兼容别名 token / auth_token
□ 过期：只解 JWT exp，缺失 = "未知"而不是"已过期"
□ 刷新：POST {auth}/refresh，body {"refresh_token":...}，不带头
         单飞；结果不缓存；取消要清理占位
         撞 200822 → 先重读桌面文件一次，用新 refresh 重试
         成功后原子写回 auth.json（tmp+rename, 0600, 保留未知字段, 保键序, 先备份）
□ 头：Authorization / Content-Type / Accept
       X-Org-Code（个人版不发，不要发明文空串）
       X-Raccoon-Language: zh
       X-Client-Platform（有真实值才发）
□ 目录：GET {llm}/model_catalog，取 categories[type=chat]，过滤 visible=false 与 raccoon-work
       主名 description，描述 display_description，倍率优先 billing_effective_multiplier
       解析为空 = 失败，不要冒充空目录；不要截断响应体
□ 对话：POST {llm}/chat/completions，body 原样透传（OpenAI 形状）
       SSE 逐字节 pipe；识别 [DONE]
       思考内容按 reasoning_content → reasoning → reasoning_text 取
       max_tokens 取目录 params.max_tokens，不要设小
□ 错误：先解 {code,message} 再看 HTTP status
       200 也可能失败；200003/200822=登录失效；200035=授权码不可恢复
       user_model_rate_limited 是吞吐墙，无 Retry-After，只能指数退避
□ 余额：GET {points}/v1/balance，主字段 available_points，多键回退
□ 签到：GET {office}/v3/setting_info 触发（按天幂等）→ GET {points}/v2/bills 核对
       判据：biz_type=daily_grant 且 grant_at/created_at 均为北京时间今天
□ 新手：POST {site}/api/web/desktop/v1/login/points/grant  +X-Client-Platform: desktop-windows
       POST {site}/api/web/mobile/v1/login/points/grant   +X-Client-Platform: app-android
       无只读状态口 → 本地台账，granted 真假都落定
□ 登录：优先 loopback 授权码（§2.5 A）；桌面凭据其次；扫码作零粘贴备选
```

---

## 附录 A：本机实测命令与结果

全部经代理 `http://127.0.0.1:7897`。

```bash
# 端点存在性（401=存在，404=不存在）
curl -s -m 25 -x http://127.0.0.1:7897 -H "Authorization: Bearer bogus" \
  https://xiaohuanxiong.com/api/web/llm/v2/model_catalog
# → {"code":200003,"message":"authorization_verify_error","details":"authorization verify failed"}

curl -s -m 25 -x http://127.0.0.1:7897 \
  https://xiaohuanxiong.com/api/web/llm/v1/model_catalog
# → 404 page not found

# 对照组（证明 404 判据有效）
curl ... /api/web/llm/v2/bogus_xyz      # → 404 page not found
curl ... /api/web/points/v1/bogus_xyz   # → 404 page not found

# 扫码会话（无鉴权，真数据）
curl -s -m 25 -x http://127.0.0.1:7897 -X POST -H "Content-Type: application/json" -d '{}' \
  https://xiaohuanxiong.com/api/iam/v1/auth/mp/qrcode
# → {"code":"OK","data":{"expires_in":300,"poll_interval":2,
#      "qrcode_code":"qr-...","scan_path":"/login/mp","status":"pending"}}

# 刷新参数名
curl ... -X POST -d '{"refresh_token":"bogus"}' {auth}/refresh
# → 400 {"code":100002,"details":"param token invalid format invalid"}
curl ... -X POST -d '{"refreshToken":"eyJ..."}'  {auth}/refresh
# → 400 {"code":100002,"details":"param token invalid format invalid"}
curl ... -X POST -d '{"refresh_token":"eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjF9.x"}' {auth}/refresh
# → 400 {"code":100002,"details":"param payload iss invalid invalid"}

# 授权页
curl ... -D - -o /dev/null "https://xiaohuanxiong.com/code/authorize?login_source=desktop&appname=x&state=abc"
# → 307, location: /authorize?login_source=desktop&appname=x&state=abc
curl ... -o auth.html "https://xiaohuanxiong.com/authorize?login_source=desktop&appname=x&state=abc&desktop_callback=loopback"
# → 200, 31500 B
```

**本机环境**：Windows；`~/.box-agent/config/` 不存在；`~/AppData/Roaming/office-raccoon/` 不存在；`~/.agent2api/` 不存在。**未安装桌面客户端，无真实凭据，故所有需鉴权的响应体均未取得。**

## 附录 B：如何复跑本次侦察

```bash
export P=http://127.0.0.1:7897
# 1) 上游实测文档
curl -s -m 30 -x $P -o upstream-protocol.md \
  https://raw.githubusercontent.com/zhlcba/dsh-raccoon-connect/HEAD/docs/upstream-protocol.md
# 2) 四份参考实现
curl -s -x $P https://raw.githubusercontent.com/lin2670/magpie-plugins/HEAD/packages/raccoon-auth/index.mjs
curl -s -x $P https://raw.githubusercontent.com/aimod-cc/agent2api/HEAD/desktop-tauri/src-tauri/server/src/server/core/providers/refresh_flight.rs
# 3) 第一方前端（关键：授权页 chunk）
curl -s -x $P https://xiaohuanxiong.com/work/home -o work.html
curl -s -x $P "https://sta-volc.xiaohuanxiong.com/raccoon-website/prod/mime-v1/_next/static/chunks/app/(identity)/authorize/page-e3bacc9bca2bfe71.js"
grep -o "desktop_callback\|loopback\|127\.0\.0\.1" page-*.js
```

> 前端 chunk 文件名带 content hash，**上游改版后会变**。重新从 `work.html` / `/authorize?...` 的 HTML 里抓 `_next/static/chunks/...` 列表，不要硬编码上面的 hash。

---

## 模型目录：`visible:false` 的模型实测可用（2026-11-10 核对）

拿真实令牌打 `GET /api/web/llm/v2/model_catalog`，上游给 9 行，其中 3 行 `visible: false`：

| model_name | description | ability_level | billing | 实测对话 |
| --- | --- | --- | --- | --- |
| `raccoon-090dd3` | Raccoon-Work | 3 | normal ×1 | 200 |
| `raccoon-19b265` | Raccoon-Work-260817-A | 3 | normal ×1 | 200 |
| `raccoon-405a1c` | Raccoon-Work-260817-B | 2 | normal ×1 | 200 |

**它们不是占位符**：`POST /chat/completions` 返回 200 与真实 content，
`billing_category` 是 `normal`（照常扣积分），`ability_level` 甚至高于部分可见模型。

上游给 `visible:false` 的意图不明 —— 像未公开的测试通道。插件因此：

- **保留在目录里**（不再丢弃），打 `hidden: true`；
- **默认不展示**（`state.showHiddenModels` 默认 false），避免用户在日常使用里
  撞上一个明天可能消失的模型；
- 用户可在「模型」tab 里打开开关，开关旁写明「上游未公开、随时可能下线」。

同一族 id 的写法不统一（`sn-sensenova-6-8-flash` 用连字符，实测表写
`sensenova-6.8-flash-lite` 用点），比对前需归一 `.`/`_` → `-` 并剥 `sn-` 前缀。
