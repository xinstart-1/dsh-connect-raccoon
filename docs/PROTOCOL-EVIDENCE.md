# 协议取证：原始摘录

> 本文件是 [`PROTOCOL.md`](./PROTOCOL.md) 的证据附件，只放**原始摘录**，不做推断。
> 每条摘录都带来源定位（`文件:行` 或 URL + HTTP 状态码）。
>
> 取证时间：2026-11-10。代理 `http://127.0.0.1:7897`。
> 本机**未安装**桌面客户端，无真实凭据 —— 凡需鉴权的响应体均未取得，标为「未验证」。

---

## 目录

1. [上游实测文档全文定位](#1-上游实测文档)
2. [第一方前端：授权页 loopback 逻辑](#2-第一方前端授权页-loopback-逻辑)
3. [第一方前端：请求头与 token 存储](#3-第一方前端请求头与-token-存储)
4. [第一方前端：积分端点](#4-第一方前端积分端点)
5. [本机实测：端点存在性](#5-本机实测端点存在性)
6. [本机实测：扫码会话](#6-本机实测扫码会话)
7. [本机实测：refresh 参数语义](#7-本机实测refresh-参数语义)
8. [参考实现：凭据文件与原子写](#8-参考实现凭据文件与原子写)
9. [参考实现：刷新与冲突处理](#9-参考实现刷新与冲突处理)
10. [参考实现：客户端身份头](#10-参考实现客户端身份头)
11. [参考实现：目录解析](#11-参考实现目录解析)
12. [参考实现：签到与新手奖励](#12-参考实现签到与新手奖励)
13. [参考实现：错误分类与限流](#13-参考实现错误分类与限流)
14. [参考实现：SSE 与思考字段](#14-参考实现sse-与思考字段)
15. [参考实现：档位探测协议](#15-参考实现档位探测协议)
16. [参考实现：refresh 单飞（Rust）](#16-参考实现refresh-单飞rust)
17. [自相矛盾之处](#17-自相矛盾之处)

---

## 1. 上游实测文档

**URL**：`https://raw.githubusercontent.com/zhlcba/dsh-raccoon-connect/HEAD/docs/upstream-protocol.md`
**HTTP**：200，12 188 B，192 行。
**性质**：作者在**装了客户端的机器**上的实测记录（不是推测）。文档自述见 `:3-5`：

> 本文件记录 `dsh-raccoon-connect` 依赖的上游事实，全部来自本机安装（`D:\apps\raccoon-ai`，App 版本目录 `resources/app.asar`，2026-09-10 构建）与真实请求，不是推测。

### 1.1 凭据文件（`:7-19`）

```
## 1. 登录态来源：`~/.box-agent/config/auth.json`

小浣熊主进程把桌面登录态写成普通 JSON 文件，供其本地 agent（box-agent）使用：

- 路径解析：`process.env.BOX_AGENT_CONFIG_DIR ?? path.join(os.homedir(), '.box-agent', 'config')`，文件名固定 `auth.json`
  （见 asar 内 `build/electron/main/boxAgentAuthFile.js` 的 `getBoxAgentAuthPath`）
- 字段（全部可选，字符串）：`access_token`、`refresh_token`、`office_identity`、`office_org_name`、`office_org_role`
- 读取端还兼容 `token` / `auth_token` 作为 access token 的别名
- 写入方式：`JSON.stringify(payload, null, 2) + '\n'`，`0o600`，先写 `${path}.${pid}.tmp` 再 rename
- 主进程不缓存：`desktopAuthState.readDesktopAuthState()` 每次调用都重读该文件

JWT 载荷实测字段：`exp`、`nbf`、`iss`、`name`（昵称）、`nation_code`、`owner_type`（`users`）、`sid`（会话 id，登录来源前缀，如 `web…`）。
令牌有效期实测：access **3 小时**，refresh **30 天**。
```

### 1.2 刷新（`:21-39`）

```
## 2. 令牌刷新：`POST /api/web/auth/v1/refresh`

来自 asar 内渲染端鉴权类（`S.refreshTokenRequest`）：

POST https://xiaohuanxiong.com/api/web/auth/v1/refresh
Content-Type: application/json
body: {"refresh_token": "<jwt>"}
→ 200 {"code":0, "data": {"access_token": "...", "refresh_token": "..."}}

要点：

- 请求**不带** `Authorization`，令牌只在 body 里
- 响应把 access 与 refresh **一起轮转**，渲染端随后同时回写 localStorage 与桌面 auth 文件
- 轮转是**单次使用**语义：旧 refresh token 再用会返回
  `400 {"code":200822,"message":"refresh_conflict","details":"refresh token conflict or reused"}`
  因此插件刷新成功后必须把新令牌回写到 App 的 `auth.json`，否则下次打开小浣熊会掉登录
- 参数名写错（如 `refreshToken`）返回 `100002 params_invalid_error`；body 缺失返回 `100000 request_body_error`
```

### 1.3 请求头（`:41-55`）

```
| 头 | 值 | 说明 |
|---|---|---|
| `Authorization` | `Bearer <access_token>` | 必需 |
| `X-Org-Code` | `getOrgCode()`，个人版为空串 | 个人版留空即可 |
| `X-Raccoon-Language` | `zh` / `zh-CN` | 影响模型 description 语言 |
| `X-Client-Platform` | `web` / `desktop` | 客户端标识 |
| `X-Client-Version` | App 版本 | |
| `X-Client-Device-ID` | `desktop-device-identity.json` 的 `clientDeviceId`（uuid） | 设备绑定用 |
| `Content-Type` | `application/json` | |

鉴权失败统一返回 `401 {"code":200003,"message":"authorization_verify_error"}`。
```

> **注意**：`X-Client-Platform` 的官方取值是 `web` / `desktop`。`LOCAL` 用的 `desktop-windows` **不在这个列表里**，来源未注明。

### 1.4 模型目录（`:57-79`）

```
## 4. 模型目录：`GET /api/web/llm/v2/model_catalog`

解析器实测（asar chunk `28610`，模块 `2132`）：

{ code: 0, data: { categories: [
  { type: "chat", default_model: "<name>", models: [
    { name, description, display_description, visible,
      tags: [...],                    // "image" | "image-understanding" 归一为 "vision"
      ability_level: int>0,           // 缺省按 1
      params: { context_window, max_tokens },
      billing_multiplier,             // 倍率（>0）
      billing_effective_multiplier,   // 折后实际倍率（>=0）
      billing_status: "normal" | "discount" | "limited_free",
      billing_status_note,
      billing_discounts: [{ name, multiplier, daily_start, daily_end, start_at, end_at, active }]
    } ] } ] } }

- 只取 `categories` 里 `type === "chat"` 的那一组
- `visible === false` 不展示；名字/描述等于 `raccoon-work`（应用内建 agent 路由位）的行也过滤
- `default_model` 不在列表里时退回首行
- 解析后为空视为失败，不能用空列表冒充目录
```

### 1.5 对话（`:81-90`）

```
- 标准 OpenAI Chat Completions 形状，流式 SSE；本地 agent 就是按 `provider: "openai"` +
  `apiBase = https://xiaohuanxiong.com/api/web/llm/v2` 直连（`resources/default-llm-config.json`、
  `~/.box-agent/config/model-profiles.json`），因此插件不需要 WorkBuddy 那类私有报文改写
- App 内置默认档位 `raccoon-chat-ml-5-5`，`contextWindow` 180000 / `maxTokens` 80000；
  账号实际绑定的 hosted profile 见 `office-raccoon/default-session-model-binding.json`
  （如 `sn-glm-5-3-flash`，`contextWindow` 1000000，`maxTokens` 100000，`profileId` `hosted:<hash>`）
- `reasoning_effort`：App 自己**不发送**该参数（bundle 里的同名命中全部来自打包的 openai/ai-sdk 类型定义），
  上游是否校验未知 → 与 WorkBuddy 插件一致，采用用户手动触发的档位探测，不凭经验补齐
```

### 1.6 真机目录样本（`:102-115`）

```
## 7. 真机复核结果（2026-09-16，`node tools/live-check.mjs`）

个人账号（`office_identity: personal`，`owner_type: users`）实测：

GET /api/web/llm/v2/model_catalog → code=0
data.categories[type=chat].default_model = sn-sensenova-6-8-flash-lite
  sn-sensenova-6-8-flash-lite  SenseNova-6.8-Flash-Lite  ctx 256000  max 63999  rate 0     tags general,chat,rewrite,summary,fast,vision  promos 限免一个月
  sn-glm-5-3                   GLM-5-3                   ctx 1000000 max 100000 rate 0.75  tags general,office,code,vision,debug,analysis,html,reasoning
  sn-kimi-k3                   Kimi-K3                   ctx 1000000 max 100000 rate 1     tags general,office,code,vision,debug,analysis,html,reasoning
  sn-glm-5-3-flash             GLM-5-3-Flash             ctx 1000000 max 100000 rate 0.1   tags general,chat,rewrite,summary,fast            promos 限时折扣
  sn-deepseek-v4-pro           DeepSeek-V4-Pro-0813      ctx 1000000 max 100000 rate 0.5   tags general,code,html,analysis,reasoning,auto
GET /api/web/points/v1/balance → {"total":<余额>}
```

### 1.7 流式与思考字段（`:117-128`）

```
流式实测（`sn-glm-5-3-flash`，19 个 SSE 事件 / 3.2 秒）：思考文本走**非标准字段**
`choices[].delta.reasoning_content`，而 `delta.content` 在思考阶段为空串。pi-ai 的
`openai-completions` 已经按 `reasoning_content → reasoning → reasoning_text` 顺序识别该字段并转成
`thinking_delta`，所以插件不需要自己做字段改写。

两条由此而来的判定：

- 目录里的 `reasoning` 标签**不能**当作"上游支持 `reasoning_effort`"或"会输出思考"的依据：
  `sn-glm-5-3-flash` 没有该标签，实测照样输出 `reasoning_content`。它描述的是 App 侧的路由预设。
  推理档位仍只能靠探测，探测候选因此覆盖目录里全部模型。
- `max_tokens` 给得太小会得到"只有思考、没有正文"的空 `content` 回复（实测 16 tokens 即如此）。
  插件不主动设小档位，输出上限取目录的 `params.max_tokens`。
```

### 1.8 `reasoning_effort` 逐值实测（`:159-184`）

```
## 9. `reasoning_effort` 的真实校验语义（逐值实测）

对 `sn-glm-5-3-flash` 逐值发最小请求（`max_tokens: 8`，读到首个 SSE 事件即断开）：

| 值 | 结果 |
|---|---|
| 不传 | 200 |
| `low` / `medium` / `high` / `xhigh` / `max` | 200 |
| `none`、`probe_sentinel_deadbeef…`、`randomword1234567890` | **200（被放过）** |
| `off`、`banana` | 400 |

400 报文：

litellm.BadRequestError: Custom_raccoonException - 该模型始终思考，不支持关闭思考；请使用 low、high 或 max。

结论（决定了插件的行为，不是实现细节）：

- 网关做的是**部分**校验——它拦住"关闭思考"一类的值，但对无意义字符串照单全收。
  因此"某个档位返回 200"不能证明这个档位真被模型执行：垃圾值同样 200。
- 所以探测协议里"哨兵值被接受 ⇒ `non-validating` ⇒ 不给档位控件"这一步，正是对小浣熊
  网关的正确判定；逐档扫出来的 low/medium/high 全都不可信。
- 400 文案里"请使用 low、high 或 max"是网关自陈的档位词表，但它是给人看的散文而不是结构化字段，
  解析它属于脆弱的猜测，插件不解析，只在文档里留此记录。
- `off` / `minimal` 永不探测，也不进档位映射（与本仓库其他 provider 一致）。
```

### 1.9 识图标签不可靠（`:130-157`）

```
必须先实测而不能读状态码的原因：**网关对纯文本模型不报错**，它直接把 `image_url` 那段丢掉，HTTP 仍是 200，
模型侧收到的是「有一条提醒说你不能处理这张图」，于是回一句「抱歉，我看不到这张图片」。

model                            tag    measured   verdict    notes
sn-sensenova-6-8-flash-lite      yes    yes        reads images  紫红绿→紫色，红色，绿色 | 绿黄紫→绿色、黄色、紫色
sn-glm-5-3                       yes    no         text only  ≠tag  红绿紫→抱歉，我看不到这张图片——我目前无法处理图像输入 | 紫绿红→抱歉，我无法看到这张图片……
sn-kimi-k3                       yes    yes        reads images  红橙蓝→红、橙、蓝 | 黄紫绿→黄色、紫色、绿色
sn-glm-5-3-flash                 no     yes        reads images ≠tag  红橙紫→红色、橙色、紫色
sn-deepseek-v4-1-flash           no     yes        reads images ≠tag  橙黄绿→橙色、黄色、绿色 | 绿红黄→绿色、红色、黄色
```

> **两个方向都错**：标签说能、实测不能（`sn-glm-5-3`）；标签说不能、实测能（`sn-glm-5-3-flash`、`sn-deepseek-v4-1-flash`）。

---

## 2. 第一方前端：授权页 loopback 逻辑

**来源**：`https://sta-volc.xiaohuanxiong.com/raccoon-website/prod/mime-v1/_next/static/chunks/app/(identity)/authorize/page-e3bacc9bca2bfe71.js`
**HTTP**：200，20 695 B。
**获取方式**：从 `GET https://xiaohuanxiong.com/authorize?...`（200，31 500 B）的 HTML 里提取 `_next/static/chunks/...` 列表，再逐个下载。

**这是本次侦察最强的证据** —— 官方授权页自己的代码，逐字可读。

### 2.1 允许的 query 参数白名单

```js
let E=["login_source","appname","state","redirect","ide","org","lang","desktop_callback"];
```

任何**不在**这个列表里的参数、或同一参数出现多次，整个上下文被判定非法（`return null`）：

```js
function R(e){
  if([...e.keys()].some(t=>!E.includes(t) || 1!==e.getAll(t).length)
     || [...e.values()].some(e=>e.length>2048 || [...e].some(t=>32>e.charCodeAt(0) || 127===e.charCodeAt(0))))
    return null;
  ...
}
```

### 2.2 回环地址 + state 的联合校验（`v()`）

```js
function v(e,t){
  if(!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{3,4}\/auth\/callback$/.test(e)
     || !/^[a-f0-9]{64}$/.test(t))
    return false;
  try{ let t=new URL(e); return Number(t.port)>=1024 && 65535>=Number(t.port) }catch{ return false }
}
```

**四条硬性要求**（违反任一即拒绝）：

| 要求 | 说明 |
| --- | --- |
| 正则 `^http://127.0.0.1:[port]/auth/callback$` | **只认 `127.0.0.1`**；路径必须**逐字**是 `/auth/callback`；必须 http 非 https |
| `^[a-f0-9]{64}$` | `state` 必须**恰好 64 位小写十六进制**（`randomUUID().replace(/-/g,'')` = 32 位，**不够**） |
| `port >= 1024 && port <= 65535` | 不能占特权端口 |
| 空 `password` / `hash` / 无 `\` 空白字符 | URL 必须干净 |

对比：**非 desktop 分支的 `C()` 反而接受 `localhost` 和 `[::1]`**：

```js
return "http:"===t.protocol
  && ["127.0.0.1","localhost","[::1]"].includes(t.hostname) && !!t.port
  || ["vscode:","vscode-insiders:"].includes(t.protocol) && "sensetime.raccoon"===t.hostname.toLowerCase()
  || N(e)
```

即 **desktop + loopback 这条路更严**。

### 2.3 `desktop_callback` 的合法性门槛

```js
let t=e.get("login_source"), r="desktop"===t;
if(t && !r) return null;                                   // login_source 只能是 desktop
let n=e.get("redirect")||"", o=(e.get("ide")||"").toLowerCase();
if(!r && !C(n) || !r && "idea"===o && !n.startsWith("http:")) return null;
let a=e.get("appname")||"", i=e.get("state")||"";
if(!r && N(n) && !i.trim()) return null;
let s=e.get("desktop_callback");
if(e.has("desktop_callback") && ("loopback"!==s || !r || o || !v(n,i))) return null;
//                                                    ↑ 不能带 ide
```

要求：`desktop_callback` 的值**只能**是 `loopback`；必须 `login_source=desktop`；**不能同时带 `ide`**；且必须通过 2.2 的 `v(redirect, state)`。

其它长度约束：

```js
let l=e.get("org")||"";
return a.length>100 || i.length>512 || l&&!/^[a-zA-Z0-9_-]{1,128}$/.test(l) ? null : {...}
```

即 `appname` ≤100 字符、`state` ≤512 字符、`org` 只能 `[a-zA-Z0-9_-]` 且 ≤128。

### 2.4 回调 URL 的构造（参数名分叉）

```js
let g=function(e,t){
  if(!t || t.length>4096) throw Error("Invalid authorization code");
  if(!e.desktop && !C(e.redirect)) throw Error("Invalid callback");
  if(e.desktopCallback && (!e.desktop || !v(e.redirect,e.state))) throw Error("Invalid desktop callback");
  let r=new URL(e.desktop && !e.desktopCallback
        ? "office-raccoon://auth/callback"     // 有客户端、无 desktop_callback → 深链
        : e.redirect);                          // 有 desktop_callback → 回环地址
  r.searchParams.set(e.desktop ? "code" : "authorization_code", t);
  e.state && r.searchParams.set("state", e.state);
  return r.href
}(c,o.code);
```

**关键**：参数名由 `e.desktop` 决定。

| 场景 | 参数名 |
| --- | --- |
| `login_source=desktop`（深链 / loopback） | **`code`** |
| 非 desktop（`home.51cto.com` 等） | `authorization_code` |

### 2.5 投递方式（`desktop` 一律 `location.assign`）

```js
async function T(e,t,r){
  if((0,y.T)(r.signal),!r.current()) return !1;
  if(e.desktop || "idea"!==e.ide) r.navigate(t);        // ← desktop 走这个
  else { /* idea 分支：fetch(...) 而不是导航 */ }
}
...
let x={ signal:l.signal, current:u, navigate:e=>window.location.assign(e) };
await n.deliver(g,x);
```

`navigate` 就是 **`window.location.assign(url)`** —— 一次普通的顶层导航。本地 HTTP 服务器能直接收到这个 GET。

`idea` 分支反而是 `fetch(t, {method:"GET", credentials:"omit", redirect:"error"})`（`T()` 的 else 分支）。

### 2.6 授权码有效期

```js
if(m=Date.now()+1e3*o.expiresIn, !u()) throw new f.i("IAM_SESSION_EXPIRED",401)
...
if(!o) return;
if(Date.now()>=m) throw new f.i("AUTHORIZATION_CODE_EXPIRED",400);
```

授权码有 `expiresIn` 秒有效期，过期抛 `AUTHORIZATION_CODE_EXPIRED`。

---

## 3. 第一方前端：请求头与 token 存储

**来源**：`https://sta-volc.xiaohuanxiong.com/raccoon-lab/office/_next/static/chunks/main-app-12246bf347090427.js`（482 038 B）
**获取方式**：从 `GET https://xiaohuanxiong.com/work/home`（200，32 533 B）提取 chunk 列表，32 个 chunk 共 6.2 MB 全量下载。

### 3.1 `createHeaders()` —— 身份头构造

```js
static createHeaders(){
  var e,t,r,n,a,o,i,s,l,c,d,u,h,f,p,g;
  null==(t=(r=v.config.tokenAdapter).getRequestSession)||null==(e=t.call(r))||e.assertCurrent();
  let m={"Content-Type":"application/json"},
      w=v.config.tokenAdapter.getToken?.();
  w && (m.Authorization="Bearer ".concat(w));
  let C=v.config.runtimeAdapter.getOrgCode?.();
  if(C && (m["X-Org-Code"]=C), null==(s=(l=v.config.runtimeAdapter).isInApp)||null==s.call(l))
    try{ null==(f=(p=v.config.runtimeAdapter).initFromUA)||f.call(p) }catch(e){}
  let x=v.config.runtimeAdapter.getClientInfo?.();
  return x?.platform && (m["X-Client-Platform"]=x.platform),
         x?.version  && (m["X-Client-Version"]=x.version),
         x?.deviceId && (m["X-Client-Device-ID"]=x.deviceId),
         v.config.headerAdapter.getHeaders?.({headers:m}) ?? m
}
```

**三条要点**：

1. 全部身份头都是**条件添加**（`&&`），拿不到就**不发**，不发明文空值。
2. `X-Org-Code` 来自 `getOrgCode()`，空则整个头不出现。
3. 平台/版本/设备号来自 `initFromUA()`（UA 解析）。

### 3.2 URL 前缀与前缀模式

```js
n.nC.configure({
  baseURL:(()=>{ let e=(0,b.hj)(); return "string"==typeof e?e:"" })(),
  prefixes:{ api:"/api/web/office/v3", basic:"/api/web", org:"/api/web/org", auth:"/api/web/auth/v1" },
  enableBusinessCodeCheck:!1,
  ...
})
```

```js
static resolveUrl(e){ let t=arguments.length>1&&void 0!==arguments[1]?arguments[1]:"api"; return ... }
// prefixMode: "api" | "basic" | "org" | "auth" | "full"
```

### 3.3 站点源与主题判断

```js
let i = () => (0,a.Yw)() ? (0,n.Ri)("office_home")||""
       : window.location.host.includes("office-stage") ? "https://code-stage.xiaohuanxiong.com"
       : "https://xiaohuanxiong.com";
function s(){ let e=(0,n.IJ)(); return i()+((e?"/api/web/org":"/api/web/office/v3")||"") }   // e9
function l(){ return i()+"/api/web/office/v3" }                                              // fb
function c(){ return i()+"/api/web/auth/v1" }                                                // aU
function d(){ return i()+"/api/web/org/user" }                                               // $_
```

> `(0,n.IJ)()` 是「是否企业版」判断：**企业版走 `/api/web/org`，个人版走 `/api/web/office/v3`**。

### 3.4 token 存储键名

```js
var l=r(47303), c=r(37811);
let d = c.env.NEXT_PUBLIC_STORAGE_TYPE || "cookie",      // 可切 "localstorage"
    u = e=>"".concat("").concat(e),
    h = u("raccoon_token"),
    f = u("xhx_token"),
    p = u("raccoon_refresh_token"),
    g = u("user_id"),
    m = u("user_name"),
    v = u("office_identity");
u("visitor_token");
```

键名清单：`raccoon_token` / `xhx_token` / `raccoon_refresh_token` / `user_id` / `user_name` / `office_identity` / `visitor_token`。

### 3.5 `refreshTokenRequest()` —— 官方刷新实现

```js
static async refreshTokenRequest(e){
  let o=v.config.tokenAdapter.getRequestSession?.call(r),
      i=v.resolveUrl(v.config.refreshEndpoint||"/refresh","auth"),
      s=await fetch(i,{
        signal:o?.signal, method:"POST", credentials:"include",
        headers:{"Content-Type":"application/json", ...v.createHeaders()},   // ← 带了 Authorization！
        body:JSON.stringify({refresh_token:e})
      });
  if(!s.ok) throw u({type:"http",code:s.status, i18nKey:"errors.auth.refreshFailed", message:"Failed to refresh"});
  let l=await s.json(); o?.assertCurrent();
  let c=l?.data;
  if(!c?.access_token) throw u({type:"validation",code:"INVALID_REFRESH_RESPONSE",...});
  v.config.tokenAdapter.setTokens?.call(a,{accessToken:c.access_token, refreshToken:c.refresh_token});
  return c.access_token
}
```

**这条与 `CONNECT` 的注释直接矛盾** —— 见 §17。

刷新前的 `exp` 预检：

```js
let{exp:n}=(0,l.A)(r), a=Math.floor(Date.now()/1e3);
if(!n||n<=a) throw await v.handleLogout(), u({type:"business",code:"REFRESH_TOKEN_EXPIRED",...});
return await v.refreshTokenRequest(r)
```

### 3.6 401 重试与并发保护

```js
let p=!1,g=null;   // p = refreshing flag, g = inflight promise
...
finally{ p=!1, g=null }
```

官方也用「`refreshing` 标志 + `inflight` promise」做单飞，语义与 §16 一致。

---

## 4. 第一方前端：积分端点

**来源**：同 §3 的 `main-app-12246bf347090427.js`，模块 `67384`。

### 4.1 余额与账单

```js
class i extends a.nC {
  static get baseUrl(){ return "".concat((0,a.hj)()).concat("/api/web","/points") }
  static get billsUrl(){ return "".concat((0,a.hj)()).concat("/api/web","/points/v2/bills") }
  static async getBalance(){
    let e=(0,n.IJ)();
    return (await a.nC.fetchWithAuth("".concat(this.baseUrl,"/v1/balance"),
      { method:"GET", headers: e?{"X-Org-Code":(0,n.Wb)()}:void 0 })).data
  }
  static async getBills(){
    let{limit:d=20,cursor:u,type:h="all"}=arguments.length>0&&void 0!==arguments[0]?arguments[0]:{},
        f=(0,n.IJ)(),
        p=new URLSearchParams({"paging.limit":String(d),type:h});
    u && p.set("cursor",u);
    let g=(await a.nC.fetchWithAuth("".concat(this.billsUrl,"?").concat(p.toString()...)));
  }
}
```

- **余额 `/points/v1/balance`，账单 `/points/v2/bills`** —— v1/v2 混用是上游原本如此。
- 企业版（`(0,n.IJ)()` 为真）才带 `X-Org-Code`。
- 账单支持 `cursor` 分页（除了 `paging.limit`）。

### 4.2 `point_grant_popups` —— 每日发放的通知字段

```js
V.getUserSettingInfo = async () => {
  var e;
  let t=(0,a.IJ)(),
      r=await o.nC.fetchWithAuth(
        t ? "".concat((0,o.fb)(),"/office/").concat((0,o.$_)(),"/setting_info")
          : "".concat((0,o.e9)(),"/setting_info"),
        { method:"GET", headers: t ? {"X-Org-Code":(0,a.Wb)()} : void 0 }),
      n=r.data?.point_grant_popups;
  if(n?.length) F.B.emit(O.R.SHOW_POINT_GRANT_POPUPS,n);
  if(r.data && "point_grant_popups" in r.data){
    let {point_grant_popups:e, ...t}=r.data; r.data=t
  }
  return r
}
```

- 端点是 `/setting_info`（个人版经 `e9()` 得到 `/api/web/office/v3/setting_info`）。
- **`point_grant_popups` 是响应里的字段**；前端把它**从 `data` 里剥掉**再继续用。
- 触发是「读设置页」这个动作的副作用 —— 没有独立签到端点。

### 4.3 余额对象里的企业字段

```js
let y={ available_points:0, enterprise_topup_points:0, user_category:"toc",
        pro_office_expired_time:"", pro_reset_date:"",
        total_space_mb:0, used_space_mb:0, ... daily_question_count:0, daily_question_limit:0, ... }
```

`available_points` 是主字段（与 `LOCAL` 注释「Raccoon reports `available_points`」一致）；`enterprise_topup_points` 与 `user_category` 是企业相关字段。

---

## 5. 本机实测：端点存在性

**方法**：该站对不存在的路径返回**纯文本** `404 page not found`；对存在但未鉴权的路径返回 **JSON `401 {code:200003}`**。两者可区分。

### 5.1 对照组（证明判据有效）

```bash
curl -s -m 20 -x http://127.0.0.1:7897 -H "Authorization: Bearer bogus" \
  https://xiaohuanxiong.com/api/web/llm/v2/bogus_xyz
# → 404 page not found          [HTTP:404]

curl -s -m 20 -x http://127.0.0.1:7897 -H "Authorization: Bearer bogus" \
  https://xiaohuanxiong.com/api/web/points/v1/bogus_xyz
# → 404 page not found          [HTTP:404]
```

### 5.2 网关版本判定

```bash
curl ... https://xiaohuanxiong.com/api/web/llm/v2/model_catalog
# → {"code":200003,"message":"authorization_verify_error","details":"authorization verify failed"}  [HTTP:401]

curl ... https://xiaohuanxiong.com/api/web/llm/v1/model_catalog
# → 404 page not found          [HTTP:404]
```

**结论：v1 不存在，v2 正确。** 连测 3 次，v2 稳定 401（排除偶发）。

### 5.3 其余端点

| 请求 | 结果 | 结论 |
| --- | --- | --- |
| `GET /api/web/llm/v2/model_catalog` | 401 `{code:200003}` | 存在 |
| `POST /api/web/llm/v2/chat/completions` | 401 `{code:200003}` | 存在 |
| `POST /api/web/llm/v2/images/gen` | 401 `{code:200003}` | 存在 |
| `GET /api/web/points/v1/balance` | 401 `{code:200003}` | 存在 |
| `GET /api/web/points/v1/bills` | 401 `{code:200003}` | 存在（`MAGPIE` 用的就是这个） |
| `GET /api/web/points/v2/bills` | 401 `{code:200003}` | 存在（前端与 `LOCAL` 用这个） |
| `GET /api/web/office/v3/setting_info` | 401 `{code:200003}` | 存在 |
| `POST /api/web/auth/v1/iam/confirm` | 401 `{code:200003}` | 存在 |
| `GET /api/web/auth/v1/entitlement_info` | 401 `{code:200003}` | 存在 |
| `POST /api/web/desktop/v1/login/points/grant` | 401 `{code:200003}` | 存在 |
| `POST /api/web/mobile/v1/login/points/grant` | 401 `{code:200003}` | 存在 |

### 5.4 站点页面

```bash
curl ... -D - -o /dev/null "https://xiaohuanxiong.com/code/authorize?login_source=desktop&appname=x&state=abc"
# → HTTP/1.1 307 Temporary Redirect
#   location: /authorize?login_source=desktop&appname=x&state=abc      ← 保留全部 query

curl ... -o auth.html "https://xiaohuanxiong.com/authorize?login_source=desktop&appname=x&state=abc&desktop_callback=loopback"
# → HTTP:200  size:31500  （官方 SPA HTML）

curl ... https://xiaohuanxiong.com/work/home     # → 200, text/html, 32533 B
curl ... https://xiaohuanxiong.com/              # → 200, 468936 B
```

---

## 6. 本机实测：扫码会话

**这组端点不鉴权，返回真实数据。**

```bash
curl -s -m 25 -x http://127.0.0.1:7897 -X POST -H "Content-Type: application/json" -d '{}' \
  https://xiaohuanxiong.com/api/iam/v1/auth/mp/qrcode
```

```json
HTTP 200
{"code":"OK","message":"success","request_id":"reqiam-01a1c358-97e8-75ff-8d01-eb78b428aa95",
 "data":{"expires_in":300,"poll_interval":2,
         "qrcode_code":"qr-01a1c358-97e8-7b93-b2d7-8389ad710c3e",
         "scan_path":"/login/mp","status":"pending"}}
```

轮询（假码）：

```bash
curl ... -X POST -d '{"qrcode_code":"qr-bogus"}' https://xiaohuanxiong.com/api/iam/v1/auth/mp/qrcode/login
```

```json
HTTP 401
{"code":"AUTH_QRCODE_INVALID","message":"mini-program QR code invalid",
 "request_id":"reqiam-01a1c358-f2d1-7e17-a138-ab2345f427fa","details":{}}
```

**注意信封不同**：IAM 用 `code:"OK"`（**字符串**），`/api/web/*` 用 `code:0`（数字）。

`LOCAL/src/raccoon-login.ts:119-120` 的判据与之吻合：

```ts
const code = stringField(root.code) ?? ''
if (!response.ok || code !== 'OK') { ... }
```

---

## 7. 本机实测：refresh 参数语义

```bash
# 1) 非 JWT 值
curl ... -X POST -d '{"refresh_token":"bogus"}' https://xiaohuanxiong.com/api/web/auth/v1/refresh
# → 400 {"code":100002,"message":"params_invalid_error","details":"param token invalid format invalid"}

# 2) 驼峰参数名（错误）
curl ... -X POST -d '{"refreshToken":"eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjF9.x"}' .../refresh
# → 400 {"code":100002,"message":"params_invalid_error","details":"param token invalid format invalid"}

# 3) JWT 形状正确但 iss 非法
curl ... -X POST -d '{"refresh_token":"eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjF9.x"}' .../refresh
# → 400 {"code":100002,"message":"params_invalid_error","details":"param payload iss invalid invalid"}

# 4) 空体
curl ... -X POST -d '{}' .../refresh
# → 400 {"code":100002,"message":"params_invalid_error","details":"param token invalid format invalid"}
```

**两条新事实**（`UPSTREAM` 未记录）：

1. **服务端会验 `iss`** —— JWT 可解析但 `iss` 不对时，错误明细是 `param payload iss invalid`，与格式错（`param token invalid format invalid`）明确区分。
2. **空体返回的是 `param token invalid format invalid`，不是 `UPSTREAM:39` 说的 `100000 request_body_error`** —— 上游已改，**以实测为准**。

授权码换 token（假码）：

```bash
curl ... -X POST -d '{"authorization_code":"bogus"}' .../api/web/auth/v1/login_with_authorization_code
# → 400 {"code":200035,"message":"authorization_code_not_found_error","details":"authorization code not found"}
```

> 服务端对任意假值都返回 `200035`，**无法用探针区分字段名**。字段名证据只来自 `MAGPIE:200`。

---

## 8. 参考实现：凭据文件与原子写

### 8.1 字段常量与路径解析

`CONNECT/src/auth.ts:93-94`：

```ts
/** The keys the desktop app itself writes, in its own order. */
const DESKTOP_TOKEN_KEYS = ['access_token', 'refresh_token', 'office_identity', 'office_org_name', 'office_org_role'] as const
```

`CONNECT/src/auth.ts:113-129`：

```ts
/**
 * Candidate locations for the desktop credential file, in probe order.
 *
 * The app resolves its own directory as `BOX_AGENT_CONFIG_DIR` or
 * `~/.box-agent/config`, so the plugin mirrors that rather than guessing at
 * per-platform application-data roots. ...
 */
export function desktopAuthCandidatesFor(variant: RaccoonVariant): string[] {
  const fromEnv = process.env[variant.env]?.trim()
  if (fromEnv !== undefined && fromEnv !== '') return [fromEnv]
  const configured = process.env[variant.configDirEnv]?.trim()
  const dir = configured !== undefined && configured !== ''
    ? configured
    : join(homedir(), ...variant.configDirRel.split('/'))
  return [join(dir, variant.desktopFilename)]
}
```

`CONNECT/src/variants.ts:59-74`：

```ts
export const RACCOON_PRIMARY: RaccoonVariant = {
  id: 'raccoon',
  displayName: '商汤小浣熊',
  appName: '商汤小浣熊',
  llmBase: 'https://xiaohuanxiong.com/api/web/llm/v2',
  siteOrigin: 'https://xiaohuanxiong.com',
  env: 'RACCOON_AUTH_FILE',
  configDirEnv: 'BOX_AGENT_CONFIG_DIR',
  configDirRel: '.box-agent/config',
  desktopFilename: 'auth.json',
  ownFilename: '.raccoon-auth.json',
  ...
}
```

### 8.2 解析（含别名兼容）

`CONNECT/src/auth.ts:211-238`：

```ts
/**
 * Parse the desktop app's credential document.
 *
 * Accepts the app's own key set and the two aliases its reader accepts for the
 * access token (`token`, `auth_token`), so an older or alternate build's file
 * still works. Returns undefined when the document carries no access token.
 */
export function parseDesktopAuth(text: string): RaccoonCredential | undefined {
  ...
  const accessToken = optionalString(document['access_token'])
    ?? optionalString(document['token'])
    ?? optionalString(document['auth_token']) ?? ''
  const identity = optionalString(document['office_identity'])
  ...
}
```

### 8.3 JWT 不验签

`CONNECT/src/auth.ts:131-139`：

```
 * The desktop document stores no expiry field of its own, so lifetime and
 * identity come from the tokens themselves: `exp`, `name`, `sid`, `iss`.
 * Signature verification is not the plugin's job — it forwards the token and the
 * upstream decides. Malformed or non-JWT values yield an empty claim set, which
 * callers treat as "expiry unknown" rather than "expired".
```

### 8.4 原子写与备份

`CONNECT/src/auth.ts:540-550`：

```ts
private async writeAtomically(path: string, payload: string): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`
  try {
    await (this.fs?.writeFile ?? writeFile)(temp, payload, { encoding: 'utf8', mode: 0o600 })
    const { rename } = await import('node:fs/promises')
    await rename(temp, path)
  } catch (error: unknown) {
    await this.remove(temp)
    throw error
  }
}
```

`CONNECT/src/auth.ts:484-515` 写回策略：

```ts
/**
 * Write the rotated pair back where the app reads it.
 *
 * The rewrite keeps the document's other fields and the app's own key order,
 * and mirrors its atomic temp-file-plus-rename write with mode 0600, so the
 * app cannot observe a half-written file. The first overwrite in a process
 * also leaves a backup of the replaced document next to the plugin's copy:
 * if a write-back ever strands the app's session, that file is the rollback.
 */
private async saveDesktop(credential: RaccoonCredential): Promise<void> {
  for (const path of this.candidates()) {
    const existing = this.desktopDocument ?? undefined
    try {
      if (!this.backedUp) await this.backupDesktop(path)
      const document: Record<string, unknown> = { ...(existing ?? {}) }
      for (const key of DESKTOP_TOKEN_KEYS) delete document[key]
      document['access_token'] = credential.accessToken
      document['refresh_token'] = credential.refreshToken
      ...
      const payload = `${JSON.stringify(this.orderedDesktop(document), null, 2)}\n`
      await this.writeAtomically(path, payload)
      this.desktopDocument = document
      return
    } catch {
      // An unwritable desktop file (read-only mount, another user's profile)
      // is not fatal: the plugin's own copy carries the session.
      return
    }
  }
}
```

键序保持 `CONNECT/src/auth.ts:517-527`：

```ts
/** The app's key order first, anything the user's file had afterwards. */
private orderedDesktop(document: Record<string, unknown>): Record<string, unknown> {
  const ordered: Record<string, unknown> = {}
  for (const key of DESKTOP_TOKEN_KEYS) {
    if (key in document) ordered[key] = document[key]
  }
  ...
}
```

---

## 9. 参考实现：刷新与冲突处理

### 9.1 为什么必须写回（模块头注释）

`CONNECT/src/auth.ts:5-13`：

```
 * for its own local agent: `~/.box-agent/config/auth.json` (relocatable through
 * `BOX_AGENT_CONFIG_DIR`). Unlike the WorkBuddy-style "read the desktop file,
 * never write it" design, 小浣熊's refresh token is **single-use**: refreshing
 * rotates both tokens server-side, so a client that refreshes without writing
 * the pair back would log the desktop app out at its next refresh. This store
 * therefore (a) prefers re-reading the desktop file over refreshing whenever it
 * still holds a live token, and (b) when it does have to refresh, writes the
```

### 9.2 单飞

`CONNECT/src/auth.ts:355-372`：

```ts
/**
 * The credential to send upstream: {@link current}, refreshed on demand.
 * Single-flight, so parallel requests share one refresh — which matters more
 * here than in a read-only design, because two concurrent refreshes would burn
 * one single-use refresh token and strand the other caller.
 */
```

`CONNECT/src/auth.ts:369`：`this.inflight ??= this.refreshNow(credential)`

### 9.3 冲突 → 重读文件

`CONNECT/src/auth.ts:417-464`：

```ts
private async refreshNow(credential: RaccoonCredential): Promise<RaccoonCredential> {
  if (credential.refreshToken === '') {
    if (credential.expiresAtMs > Date.now() + 30_000) return credential
    throw new Error(
      'raccoon: access token expired and no refresh token is stored;'
      + ` sign in again in the ${this.variant.appName} desktop app`,
    )
  }
  try {
    return await this.refreshOnce(credential)
  } catch (error: unknown) {
    // A single-use token refused as "reused" usually means the desktop app
    // refreshed after we read the file. Re-read once and use what it left.
    if (this.isConflict(error)) {
      const reread = await this.readDesktop()
      if (reread !== undefined && reread.accessToken !== credential.accessToken && !this.needsRefresh(reread)) {
        return reread                                   // ← 分支 1：文件里已有新鲜 access，直接用
      }
      if (reread !== undefined && reread.refreshToken !== '' && reread.refreshToken !== credential.refreshToken) {
        return await this.refreshOnce(reread)           // ← 分支 2：文件里是新 refresh，再刷一次
      }
    }
    if (credential.expiresAtMs > Date.now() + 30_000) return credential   // 还没过期就先用着
    throw new Error(
      `raccoon: token refresh failed and the access token is expired (${this.redact(error, credential)});`
      + ` open the ${this.variant.appName} desktop app once to sign in again`,
    )
  }
}
```

### 9.4 刷新请求本身不带 Authorization

`CONNECT/src/upstream.ts:316-331`：

```ts
/**
 * Deliberately unauthenticated: the refresh token is the credential, and the
 * gateway rejects a request that also carries an `Authorization` header.
 * The desktop app's failure text is reproduced here so a caller that sees the
 * error knows which leg broke.
 */
async refresh(refreshToken: string): Promise<RaccoonRefreshOutcome> {
  if (refreshToken === '') throw new Error('raccoon: no refresh token to exchange')
  ...
  response = await this.request(`${this.authBase}/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  }, this.timeoutMs)
```

### 9.5 MAGPIE 的做法（不同，因为凭据来源不同）

`MAGPIE:106-113`：

```js
// one renewal of the token pair: POST {authBase}/refresh with the refresh
// token. The reply's data.access_token (any Bearer prefix stripped) is the
// new access token, and an empty data.refresh_token keeps the old one
// (agent2api call_refresh_api). A 429 starts a cooldown: the rate-limited
// refresh endpoint is left alone until it passes (agent2api cools the
// account; here a single shared flag is enough since renewals serialize).
let refreshCooldownUntil = 0
const REFRESH_COOLDOWN_MS = 10 * 60e3
```

`MAGPIE:118-138`：

```js
const res = await fetch(`${authBase()}/refresh`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },      // 不带 Authorization
  body: JSON.stringify({ refresh_token: refreshToken }),
  signal: AbortSignal.timeout(30_000),
})
if (res.status === 429) { refreshCooldownUntil = Date.now()+REFRESH_COOLDOWN_MS; throw ... }
...
return {
  access,
  refresh: String(data?.refresh_token ?? "").trim() || refreshToken,   // 空则沿用旧值
  expires: jwtEnd(access) || Date.now() + 3600e3,
}
```

### 9.6 MAGPIE 的串行锁 + 令牌记忆

`MAGPIE:290-306`：

```js
// a refresh token is spent once: renewals serialize, and what a renewal
// gave is remembered by the token it spent, so a caller holding an older
// snapshot follows it instead of spending the token again
let lock = Promise.resolve()
const locked = (fn) => { const run = lock.then(fn, fn); lock = run.catch(() => {}); return run }
const given = new Map()
const renewOf = async (a) => {
  if (given.has(a.refresh)) return given.get(a.refresh)
  const got = await renewToken(a.refresh)
  if (given.size > 32) given.delete(given.keys().next().value)
  given.set(a.refresh, got)
  return got
}
```

`MAGPIE:308-318`：

```js
// fresh is the account with a live access token, renewed near its end and
// saved back
const fresh = (getAuth) =>
  locked(async () => {
    const a = await getAuth()
    if (a?.type !== "oauth" || !a.access) throw new SignedOut("小浣熊：未登录")
    if (a.expires && a.expires - Date.now() > REFRESH_LEAD) return a
    const next = { ...a, ...(await renewOf(a)) }
    await client.auth.set({ path: { id: ID }, body: next })
    return next
  })
```

`REFRESH_LEAD = 5 * 60_000`（`MAGPIE:45`）。

### 9.7 与 agent2api 并存的警告

`MAGPIE:24-26`（README）：

```
## 与 agent2api 并存的注意

小浣熊的 refresh token 可能在每次刷新时轮换。同一账号同时由本插件与 agent2api 刷新，会互相作废对方保存的 token——**导入后建议在 agent2api 面板里停用小浣熊账号**，待本插件验证稳定后再退役 agent2api。
```

---

## 10. 参考实现：客户端身份头

### 10.1 `LOCAL`（dsh-llm-adapters）

`LOCAL/src/raccoon.ts:29-39`：

```ts
export const RACCOON_BASE = 'https://xiaohuanxiong.com/api/web'
export const RACCOON_CLIENT_VERSION = 'v1.0.35'
/** The page whose first authenticated load carries the daily-points grant. */
export const RACCOON_CHECKIN_URL = 'https://xiaohuanxiong.com/work/home'

/** Desktop identity the official client sends; the gateway varies by platform. */
function raccoonClientPlatform(): string {
  if (process.platform === 'darwin') return 'desktop-macos'
  if (process.platform === 'linux') return 'desktop-linux'
  return 'desktop-windows'
}
```

`LOCAL/src/raccoon.ts:94-102`：

```ts
function raccoonHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    'x-org-code': '',
    'x-raccoon-language': 'zh',
    'x-client-platform': raccoonClientPlatform(),
    'x-client-version': RACCOON_CLIENT_VERSION,
  }
}
```

> 注释说「the official client sends」，但 `UPSTREAM:50` 记录的官方值是 `web`/`desktop`。`desktop-windows` 的来源**未注明**。

### 10.2 `CONNECT`（dsh-raccoon-connect）

`CONNECT/src/upstream.ts:220-239`：

```ts
/**
 * Headers every authenticated call carries.
 *
 * The identity headers are omitted rather than sent empty: the web client
 * only adds them when it could parse its own user agent, and an empty
 * `X-Client-Device-ID` is a different statement from no header.
 */
private headers(accessToken: string, identity = this.identity()): Record<string, string> {
  const out: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'X-Org-Code': '',
    'X-Raccoon-Language': 'zh',
    'X-Client-Platform': identity.platform,
  }
  if (identity.version !== undefined) out['X-Client-Version'] = identity.version
  if (identity.deviceId !== undefined) out['X-Client-Device-ID'] = identity.deviceId
  return out
}
```

> 注意：注释说「omitted rather than sent empty」，但 `X-Org-Code` 恰恰**发的是空串** —— 注释与代码不一致（`X-Org-Code` 不属于它说的「identity headers」三项）。

`CONNECT/src/client-identity.ts:89-115`（环境覆盖优先）：

```ts
/**
 * Resolve the identity headers to send, reading disk at most once per process.
 *
 * Environment overrides win so a user on a non-standard install (portable app,
 * different profile, WSL) can pin the values without code changes:
 * `RACCOON_CLIENT_PLATFORM`, `RACCOON_CLIENT_VERSION`, `RACCOON_CLIENT_DEVICE_ID`.
 */
export function resolveClientIdentity(): RaccoonClientIdentity {
  const platform = process.env['RACCOON_CLIENT_PLATFORM']?.trim() || 'desktop'
  ...
}
```

`CONNECT/src/client-identity.ts:29-54`（设备目录与设备号来源）：

```ts
export function userDataCandidates(): string[] {
  const home = homedir()
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA']?.trim()
    return [appData === undefined || appData === '' ? join(home, 'AppData', 'Roaming') : appData]
      .map(root => join(root, 'office-raccoon'))
  }
  if (process.platform === 'darwin') return [join(home, 'Library', 'Application Support', 'office-raccoon')]
  const xdg = process.env['XDG_CONFIG_HOME']?.trim()
  return [join(xdg !== undefined && xdg !== '' ? xdg : join(home, '.config'), 'office-raccoon')]
}

function readDeviceId(userDataDir: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(userDataDir, 'desktop-device-identity.json'), 'utf8'))
    ...
    const value = (parsed as Record<string, unknown>)['clientDeviceId']
    ...
}
```

`CONNECT/src/client-identity.ts:56-87`（版本读取，宁可不发）：

```
 * Windows keeps the Electron executable in a fixed install directory that is not
 * recorded in any config file, so the plugin reads `version` off the update
 * metadata the app itself maintains and gives up quietly otherwise — the header
 * is optional, and a wrong version is worse than no version at all.
```

### 10.3 `MAGPIE`

`MAGPIE:400-401`：

```js
const desktopHeaders = { "X-Client-Platform": "desktop-windows", "X-Client-Version": "v1.0.0" }
const mobileHeaders = { "X-Client-Platform": "app-android", "X-Client-Version": "v1.0.3" }
```

`MAGPIE:413-415`（按端点选头）：

```js
const data = await getJSON(`${mainOrigin()}${task.path}`, token, 20_000, {
  ...(task.mobile ? mobileHeaders : desktopHeaders),
})
```

`MAGPIE:438-442`（签到触发）：

```js
await getJSON(`${mainOrigin()}/api/web/office/v3/setting_info`, token, 20_000, {
  "X-Client-Platform": "desktop-windows",
  "X-Client-Version": "v1.0.0",
  "X-Raccoon-Language": "zh",
})
```

### 10.4 `x-raccoon-session-id`（只有 LOCAL 发）

`LOCAL/src/raccoon.ts:175-187`：

```
/**
 * One conversation's session id, stable across the turns of that conversation.
 *
 * The official client never opens a session per request — measured on its own
 * logs, 125 calls over 26 minutes all carried one `sess-0-53927d74` — while an
 * implementation that mints a fresh id per request tells the gateway that one
 * account opened hundreds of sessions within minutes.
 *
 * The id is a pure function of (account, model) rather than a random value, so a
 * restarted or hot-reloaded process continues the same conversation instead of
 * presenting a new session, and two models stay two conversations. The principal
 * itself never leaves the process — only a truncated digest of it does.
 */
```

`LOCAL/src/raccoon.ts:202-214`：

```
/**
 * `sess-<sequence>-<8 hex>`, the shape the official client sends.
 *
 * The sequence is the official client's process-local counter and is pinned to 0
 * here on purpose: an incrementing value would make one conversation look like a
 * different session after a restart, which is the one thing this id exists to
 * prevent. ...
 */
export function raccoonSessionId(principal: string, model: string): string {
  const digest = createHash('sha256').update(`${principal}\0${model}`).digest('hex').slice(0, 8)
  return `sess-0-${digest}`
}
```

`LOCAL/src/raccoon.ts:347-358`（仅 chat 带）：

```ts
/**
 * The chat headers, including the session id the gateway counts sessions by.
 *
 * Only chat carries it: the catalogue, quota and check-in routes are plain
 * business calls the official client sends outside any session, so leaving
 * them alone keeps this change to the one route it was measured on.
 */
private async chatHeaders(token: string, model: string): Promise<Record<string, string>> {
```

---

## 11. 参考实现：目录解析

### 11.1 字段名的三件套

`LOCAL/src/catalog.ts:286-292`：

```ts
/**
 * Parse Raccoon's `model_catalog` response.
 *
 * Only `categories[type=chat]` is relevant. The catalogue's `name` is both the
 * model id and the value the completion endpoint accepts; the human label comes
 * from `description` (the product name), while `display_description` is a
 * workload sentence shown as the description.
 */
```

`LOCAL/src/catalog.ts:315-323`：

```ts
const id = stringField(record, ['name', 'id', 'model'])
if (id === undefined || id === 'raccoon-work') continue
if (record.visible === false) continue
const params = recordOf(record.params)
const tags = stringArray(record.tags)
const rawName = stringField(record, ['description', 'display_name', 'model_name']) ?? id
const parsed = parseModelName(rawName)
const display = stringField(record, ['display_description', 'displayDescription'])
const description = display === undefined || display === parsed.name ? undefined : display
```

### 11.2 CONNECT 的行解析（更严格）

`CONNECT/src/catalog.ts:337-367`：

```ts
function parseModelRow(value: unknown): RaccoonCatalogModel | undefined {
  const row = asRecord(value)
  if (row === undefined) return undefined
  const id = trimmed(row['name'])
  if (id === '') return undefined
  const label = trimmed(row['description'])
  const displayDescription = trimmed(row['display_description'])
  const params = asRecord(row['params'])
  const contextWindow = positiveInt(params?.['context_window']) ?? positiveInt(row['context_window'])
  const maxTokens = positiveInt(params?.['max_tokens']) ?? positiveInt(row['max_tokens'])
  const billingMultiplier = positiveNumber(row['billing_multiplier'])
  const billingEffectiveMultiplier = nonNegativeNumber(row['billing_effective_multiplier'])
  const rawStatus = trimmed(row['billing_status'])
  const billingStatus = rawStatus === 'normal' || rawStatus === 'discount' || rawStatus === 'limited_free'
    ? rawStatus as RaccoonBillingStatus : undefined
  const note = trimmed(row['billing_status_note'])
  return {
    id, label,
    ...(displayDescription === '' ? {} : { displayDescription }),
    visible: row['visible'] !== false,
    tags: normalizeTags(row['tags']).slice(0, MAX_TAGS),
    abilityLevel: positiveInt(row['ability_level']) ?? 1,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...
    billingDiscounts: parseDiscounts(row['billing_discounts']),
  }
}
```

### 11.3 清洗规则

`CONNECT/src/catalog.ts:369-405`：

```ts
/**
 * Parse a `model_catalog` response body.
 *
 * Accepts both the `{code, data}` envelope and a bare document, because the
 * gateway has been observed to answer either way depending on the endpoint.
 * Rows the plugin cannot call correctly (no window, or the desktop app's own
 * internal agent routes) are dropped here rather than surfacing a model that
 * errors on first use. Returns undefined when nothing usable survives, so the
 * caller degrades to the saved or built-in catalog instead of publishing an
 * empty group.
 */
export function parseModelCatalog(document: unknown): RaccoonCatalogDocument | undefined {
  const root = asRecord(document)
  if (root === undefined) return undefined
  if (root['code'] !== undefined && root['code'] !== 0) return undefined
  const payload = asRecord(root['data']) ?? root
  const categories = (Array.isArray(payload['categories']) ? payload['categories'] : [])...
  const chat = categories.find(category => trimmed(category['type']) === 'chat')
  if (chat === undefined) return undefined
  const seen = new Set<string>()
  const models: RaccoonCatalogModel[] = []
  for (const entry of Array.isArray(chat['models']) ? chat['models'] : []) {
    const model = parseModelRow(entry)
    if (model === undefined || seen.has(model.id)) continue
    // `raccoon-work` is the app's own agent-routing row, not a chat model.
    const labels = [model.id, model.label].map(value => value.toLowerCase())
    if (!model.visible || labels.includes('raccoon-work')) continue
    seen.add(model.id)
    models.push(model)
  }
  if (models.length === 0) return undefined
  const declared = trimmed(chat['default_model'])
  const defaultModelId = models.some(model => model.id === declared) ? declared : models[0]!.id
  return { defaultModelId, models }
}
```

### 11.4 倍率语义（实测对照）

`CONNECT/src/catalog.ts:267-279`：

```ts
/**
 * Re-derive the time-boxed billing facts of one row.
 *
 * A catalog is fetched once and displayed for hours, so "currently discounted"
 * cannot be baked in at parse time. Measured against the live gateway, a
 * promotion's `multiplier` is a **factor on the list price**, not the resulting
 * price: `sn-glm-5-3-flash` carries list 0.2 with a 0.5 factor and the upstream
 * states 0.1 effective, while the free month carries list 0.5 with a 0 factor
 * and states 0. So the live derivation is `list × cheapest live factor`, and
 * once every window has closed the row returns to its list price — or, if it
 * never had one, to no stateable price at all, because advertising a figure
 * nobody is being charged is worse than admitting the price is unknown.
 */
```

`CONNECT/src/catalog.ts:280-311`：

```ts
export function modelWithCurrentBilling(model: RaccoonCatalogModel, now: Date): RaccoonCatalogModel {
  if (model.billingDiscounts.length === 0) return model
  const { billingEffectiveMultiplier: _stated, billingStatus: _statedStatus, billingDiscounts: _windows, ...rest } = model
  const live = model.billingDiscounts.filter(discount => discountIsLive(discount, now))
  if (live.length === 0) { ... return { ...rest, billingDiscounts: [] } }
  // A row with no list price cannot be scaled, so its stated effective figure is
  // kept rather than recomputed from a factor with nothing to multiply.
  if (model.billingMultiplier === undefined) return model
  // The cheapest live window is what the user actually pays.
  const best = live.reduce((acc, item) => item.multiplier < acc.multiplier ? item : acc)
  const effective = model.billingMultiplier * best.multiplier
  ...
}
```

`CONNECT/src/catalog.ts:330-333`：

```ts
/** Whether the row carries no stateable price (an expired promotion's leftover). */
export function isRateUnknown(model: RaccoonCatalogModel): boolean {
  return model.billingEffectiveMultiplier === undefined && model.billingMultiplier === undefined
    && model.billingDiscounts.length === 0 && model.billingStatusNote === undefined
}
```

### 11.5 不要截断响应体（踩过的坑）

`CONNECT/src/upstream.ts:259-280`：

```
/**
 * Read the whole response body, because `envelope` has to `JSON.parse` it.
 *
 * This used to return `(await response.text()).slice(0, 4096)`. That cap was
 * survivable while the gateway's `model_catalog` document fitted in 4 KiB, but
 * the roster is account-dependent and grows: once it crossed 4096 characters
 * the slice cut the document mid-string, `JSON.parse` threw, `envelope`
 * reported a failure, and the plugin silently degraded to the built-in
 * fallback roster — new models never appeared, and the card showed only the
 * unhelpful `[object Object]`.
 *
 * Bounding belongs at the sites that *display* a body (`failure`, or the
 * `slice(0, 512)` when a message is carried into an error), not here, where
 * the value is input to a parser.
 */
```

### 11.6 OpenAI `/v1/models` 形态（自己合成）

`CONNECT/src/shim.ts:44-48, 205-213`：

```ts
/** Serves `/v1/models`; may be absent until the first catalog lands. */
...
/** Model list in OpenAI's `/v1/models` shape. */
models(): { object: string, data: { id: string, object: string, owned_by?: string }[] }
...
return {
  object: 'list',
  data: (options.catalog?.().current() ?? []).map(model => ({ id: model.id, object: 'model' as const })),
}
```

`CONNECT/src/shim.ts:1-14`（设计意图）：

```
 * Loopback OpenAI-compatible façade in front of the 小浣熊 gateway.
 *
 * ... talk OpenAI-compatible HTTP to a server bound to 127.0.0.1 on a random port,
 * and everything that is *not* OpenAI-compatible about the upstream — resolving
 ...
 * - the upstream SSE body is piped through byte for byte, so usage accounting,
```

---

## 12. 参考实现：签到与新手奖励

### 12.1 没有签到端点

`LOCAL/src/raccoon.ts:465-471`：

```ts
/**
 * Today's daily-points bill, when the website has already granted it.
 *
 * Raccoon has no standalone check-in endpoint. The daily points are issued
 * by the server on the first authenticated web visit and announced through
 * `point_grant_popups` on `setting_info`; the bills list is the durable proof.
 */
```

`LOCAL/src/raccoon.ts:506-514`（只读的产品决策）：

```ts
/**
 * Read today's grant. **Read-only on purpose.**
 *
 * The gateway has no claim endpoint: points are issued on the day's first
 * website visit. Replaying that visit (`setting_info`) can trigger the grant
 * from here, but doing so takes a state-changing action on the account without
 * the user asking for it in that moment, so the plugin only reports. Claiming
 * is the website's job, and the card links there.
 */
```

### 12.2 到账判据

`LOCAL/src/raccoon.ts:472-503`：

```ts
private async dailyGrant(): Promise<{ points?: number, grantedAt?: number } | undefined> {
  const payload = await this.authorizedJson<unknown>('/points/v2/bills?paging.limit=50&type=all')
  ...
  const items = Array.isArray(data.items) ? data.items : []
  const today = raccoonDay(Date.now())
  for (const raw of items) {
    const item = record(raw)
    if (item?.biz_type !== 'daily_grant') continue
    // `grant_at` is the day the points belong to; `created_at` is when the
    // server actually issued them. Both have to name today, so a grant made
    // yesterday for yesterday can never be reported as today's.
    const day = item.grant_at ?? item.created_at
    if (typeof day !== 'string' && typeof day !== 'number') continue
    let label: string
    try { label = raccoonDay(day) } catch { continue }
    if (label !== today) continue
    const issued = epochOf(item.created_at) ?? epochOf(item.grant_at)
    const points = numeric(item.points)
    return { ...points === undefined ? {} : { points }, ...issued === undefined ? {} : { grantedAt: issued } }
  }
  return undefined
}
```

`LOCAL/src/raccoon.ts:84-92`（北京时间）：

```ts
/** The date label Raccoon uses for the daily grant (Beijing time). */
function raccoonDay(value: string | number | Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(typeof value === 'string' || typeof value === 'number' ? new Date(value) : value)
}
```

### 12.3 余额字段回退

`LOCAL/src/raccoon.ts:438-450`：

```ts
// Raccoon reports `available_points`; the other keys are legacy shapes.
const available = numeric(data.available_points)
  ?? numeric(data.total_chargeable_points)
  ?? numeric(data.total)
  ?? numeric(data.balance)
  ?? numeric(data.points)
if (available === undefined) throw new Error('小浣熊额度响应格式无法识别。')
const snapshot: QuotaSnapshot = {
  at: Date.now(), total: available, available,
  ...numeric(data.reward_points) === undefined ? {} : { permanent: numeric(data.reward_points)! },
  ...numeric(data.daily_points) === undefined ? {} : { daily: numeric(data.daily_points)! },
}
```

### 12.4 新手奖励两条 grant

`MAGPIE:386-401`：

```js
// the daily point grant: the desktop client's settings page triggers it
// ── the one-time first-login grants (the onboarding tasks) ────────────────
// The vendor has no read-only "did this account already claim its first
// login reward" endpoint, so the only source of truth is this account's
// own ledger (agent2api onboarding.rs): two grant endpoints, desktop and
// mobile, each paid exactly once per account (a repeat answers
// granted:false) — the ledger records a settle the moment one of the two
// answers, granted or not (both mean the reward is decided), and a settled
// key is never requested again.
const ONBOARDING_TASKS = [
  { key: "desktop_login_grant", title: "首次电脑端登录奖励", path: "/api/web/desktop/v1/login/points/grant", mobile: false },
  { key: "mobile_login_grant", title: "首次手机端登录奖励", path: "/api/web/mobile/v1/login/points/grant", mobile: true },
]
const ONBOARDING_POINTS = 3000
const desktopHeaders = { "X-Client-Platform": "desktop-windows", "X-Client-Version": "v1.0.0" }
const mobileHeaders = { "X-Client-Platform": "app-android", "X-Client-Version": "v1.0.3" }
```

`MAGPIE:403-429`（台账语义）：

```js
const claimOnboarding = async (a) => {
  const token = stripBearer(a.access)
  const ledger = { ...(a.onboardingGrants ?? {}) }
  let claimed = 0, points = 0
  for (const task of ONBOARDING_TASKS) {
    if (ledger[task.key]) continue
    try {
      // getJSON unwraps the {code, data} envelope: what comes back is
      // {granted, popup?} directly
      const data = await getJSON(`${mainOrigin()}${task.path}`, token, 20_000, {
        ...(task.mobile ? mobileHeaders : desktopHeaders),
      })
      const granted = data?.granted === true
      const popupPoints = toInt(data?.popup?.points)
      ledger[task.key] = Date.now()
      if (granted) { claimed++; points += popupPoints ?? ONBOARDING_POINTS }
    } catch {
      // the endpoint is unusable right now: leave the key unsettled and
      // let a later check-in try again (a repeat is safe upstream)
    }
  }
  return { ledger, claimed, points }
}
```

`MAGPIE:433-477`（签到两步 + 新手并入）：

```js
const checkin = async (getAuth) => {
  const a = await fresh(getAuth)
  const token = stripBearer(a.access)
  let triggerError = null
  try {
    await getJSON(`${mainOrigin()}/api/web/office/v3/setting_info`, token, 20_000, {
      "X-Client-Platform": "desktop-windows",
      "X-Client-Version": "v1.0.0",
      "X-Raccoon-Language": "zh",
    })
  } catch (e) { if (e?.signIn === "expired") throw e; triggerError = e?.message ?? String(e) }
  let bills = null, billsError = null
  try {
    bills = await getJSON(`${mainOrigin()}/api/web/points/v1/bills?paging.limit=20&paging.offset=0`, token, 25_000)
  } catch (e) { ... }
  const today = beijingToday()
  const granted = (Array.isArray(bills?.items) ? bills.items : [])
    .map((item) => ({ points: toInt(item?.points), at: String(item?.created_at ?? "") }))
    .filter((g) => g.points != null && g.points > 0 && g.at.slice(0, 10) === today)
    .reduce((sum, g) => sum + g.points, 0)
  ...
  if (granted > 0) return { outcome: "claimed", credit: granted + ..., message: `今日积分 +${granted}${onboardingMsg}` }
  ...
}
```

> **注意**：`MAGPIE:450` 用的是 **`/points/v1/bills`**，而 `LOCAL` 用 **`/points/v2/bills`**，前端用 **`/points/v2/bills`**。两个都实测返回 401（存在）。**v2 更可信**（第一方前端 + `LOCAL` 一致）。

---

## 13. 参考实现：错误分类与限流

### 13.1 分类表

`CONNECT/src/upstream.ts:24-51`：

```ts
export type RaccoonErrorKind = 'session_dead' | 'hard_credit' | 'soft_rate' | 'not_found' | 'server' | 'client'

/**
 * HTTP status the local shim re-exposes each kind as.
 *
 * The shim's caller is pi-ai's OpenAI client, which decides retry and error
 * presentation from the status code, so kinds are mapped back onto the codes an
 * OpenAI client already interprets correctly: 401/402/429 are terminal or
 * retryable in exactly the ways the plugin wants them to be.
 */
export const KIND_STATUS: Record<RaccoonErrorKind, number> = {
  hard_credit: 402, soft_rate: 429, session_dead: 401, not_found: 502, server: 502, client: 400,
}

/** Business codes meaning the session is gone and the app must sign in again. */
const SESSION_DEAD_CODES = new Set(['200003', '200822'])

/** Business codes and phrases meaning the account is out of credit. */
const CREDIT_CODES = new Set(['200402', '200429', '100402'])
const CREDIT_PHRASES = ['积分不足', '余额不足', '点数不足', 'quota exceeded', 'insufficient balance', 'insufficient points', 'payment required']

/** Business codes and phrases meaning "rate limited, try later". */
const RATE_PHRASES = ['频繁', 'too many requests', 'rate limit']
```

`CONNECT/src/upstream.ts:68-95`：

```ts
/**
 * Map an upstream failure onto a kind.
 *
 * Order matters: the gateway answers most failures with HTTP 400 plus a business
 * code, so the code and message have to be read before the status decides.
 */
export function classifyUpstreamError(status: number, body: string): RaccoonErrorKind {
  ...
  if (SESSION_DEAD_CODES.has(code)) return 'session_dead'
  if (CREDIT_CODES.has(code) || CREDIT_PHRASES.some(phrase => lower.includes(phrase.toLowerCase()))) return 'hard_credit'
  if (status === 429 || RATE_PHRASES.some(phrase => lower.includes(phrase.toLowerCase()))) return 'soft_rate'
  if (status === 401 || status === 403) return 'session_dead'
  if (status === 404) return 'not_found'
  if (status === 0 || status >= 500) return 'server'
  return 'client'
}
```

### 13.2 200 也可能是失败

`CONNECT/src/upstream.ts:282-310`：

```ts
/**
 * Unwrap the `{code, message, data}` envelope.
 *
 * A non-zero code is a failure even on HTTP 200, and the message is kept
 * because its business phrase is how `classifyUpstreamError` recognizes credit
 * exhaustion. A body with no envelope at all is returned as-is, since that is
 * how the gateway answers some endpoints.
 */
```

### 13.3 限流是「吞吐墙」不是「请求频率」

`LOCAL/src/raccoon.ts:104-128`：

```ts
/**
 * The upstream code for the account's token-throughput wall.
 *
 * It reads like a request-rate complaint (`您的模型请求频率超限`) and is not
 * one: measured on a live account, ten large requests in ten seconds hit it
 * while fifty small ones did not, and the window refills by throughput rather
 * than by request count. The gateway sends no `Retry-After` and no
 * `x-ratelimit-*` header, so nothing here can compute a wait either.
 */
export const RACCOON_RATE_LIMIT_CODE = 'user_model_rate_limited'

/** Wording the gateway has used alongside that code. */
const RATE_LIMIT_WORDS = ['user_model_rate_limited', 'rate_limit', '频率超限']

/**
 * Whether a rejection is the token wall rather than a generic failure.
 *
 * Matched on the status, the code and the wording, because the same condition
 * arrives as an HTTP 429 and as an error frame inside a 200 stream.
 */
export function isRaccoonRateLimited(status: number | undefined, text: string): boolean {
  if (status === 429) return true
  const lower = text.toLowerCase()
  return RATE_LIMIT_WORDS.some(word => lower.includes(word.toLowerCase()))
}
```

### 13.4 流内错误帧

`LOCAL/src/raccoon.ts:160-173`：

```ts
/** The `error` object a compatible gateway puts in an SSE frame. */
function frameFailure(frame: Record<string, unknown>): { code?: string, message?: string } | undefined {
  const error = frame.error
  if (error === undefined) return undefined
  if (typeof error === 'string') return { message: error }
  if (error === null || typeof error !== 'object') return undefined
  const record = error as Record<string, unknown>
  const code = typeof record.code === 'string' ? record.code : undefined
  const message = typeof record.message === 'string' ? record.message : undefined
  return { ...code === undefined ? {} : { code }, ...message === undefined ? {} : { message } }
}
```

---

## 14. 参考实现：SSE 与思考字段

### 14.1 思考字段识别顺序

`LOCAL/src/wire.ts:418-423`：

```ts
function deltaReasoning(delta: Record<string, unknown>): string {
  for (const key of ['reasoning_content', 'reasoning', 'reasoning_text']) {
    if (typeof delta[key] === 'string') return delta[key] as string
  }
  return ''
}
```

`LOCAL/src/wire.ts:411-416`（正文）：

```ts
function deltaText(delta: Record<string, unknown>): string {
  for (const key of ['content', 'text']) {
    if (typeof delta[key] === 'string') return delta[key] as string
  }
  return ''
}
```

非流式同一字段：`LOCAL/src/wire.ts:624-626`：

```ts
const reasoning = typeof message.reasoning_content === 'string'
  ? message.reasoning_content
  : typeof message.reasoning === 'string' ? message.reasoning : ''
```

### 14.2 `[DONE]` 处理

`LOCAL/src/wire.ts:528`：`if (event.data.trim() === '[DONE]') {`

`LOCAL/src/wire.ts:606-613`（裸 `[DONE]` 的告警）：

```
// A bare [DONE] without finish_reason is how Loomy truncates. Reporting
```

`CONNECT/src/upstream.ts:160-189`（探针版只读一个事件）：

```ts
/**
 * Read one SSE stream far enough to know whether it started.
 *
 * The probe must not wait for a full answer — that is what costs credit — so it
 * resolves on the first `data:` line and aborts the request immediately after.
 */
async function readFirstEvent(body, signal) {
  const reader = body.getReader()
  const chunks: string[] = []
  try {
    const read = await Promise.race([...])
    ...
    chunks.push(text)
    return { streamed: /data:\s*(\[DONE\]|.{1,})/u.test(chunks.join('')), body: chunks.join('').slice(0, 4096) }
  } catch { return { streamed: false, body: chunks.join('').slice(0, 4096) }
  } finally {
    // Cancel rather than drain: the upstream bills for what it generates.
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
```

### 14.3 非流式兜底

`LOCAL/src/wire.ts:616-617`：

```ts
/** Non-streaming fallback for a gateway that ignores `stream: true`. */
async function* nonStreaming(response: Response, signal?: AbortSignal): AsyncGenerator<StreamChunk> {
```

### 14.4 body 构造

`LOCAL/src/wire.ts:303-312`：

```ts
export function buildBody(options: GenerateOptions, model: string, messages: WireMessage[], tools: Record<string, unknown>[] | undefined): Record<string, unknown> {
  ...
  stream: true,
  ...
  ...options.maxTokens === undefined ? {} : { max_tokens: Math.floor(options.maxTokens) },
  ...options.temperature === undefined ? {} : { temperature: options.temperature },
  ...
  ...tools === undefined ? {} : { tools, tool_choice: 'auto' },
```

`MAGPIE:330-380`（`model` 名回写，非协议要求）：

```js
// the vendor's gateway writes its own model name into every reply; each is
// rewritten to the name the client asked by (agent2api pipeSseWithModelRewrite)
const rewriteModel = (res, model) => { ... }
```

---

## 15. 参考实现：档位探测协议

`CONNECT/src/probe.ts:1-26`（协议头，**顺序即协议**，逐字）：

```
/**
 * The reasoning-effort probe protocol: what a single sweep does, in what order,
 * and what each answer is allowed to mean.
 *
 * The upstream catalog declares no effort vocabulary for 小浣熊's models, and a
 * request returning HTTP 200 proves nothing about whether the gateway *honored*
 * `reasoning_effort` — a server that ignores an unknown value answers normally.
 * So capability is established by experiment, and the experiment has to rule out
 * being meaningless before its per-level answers count:
 *
 * 1. **baseline** — no `reasoning_effort` at all. If that fails, nothing was
 *    learned about the parameter and the whole run is `unknown`.
 * 2. **sentinel** — a value that cannot exist (`probe_sentinel_<24 hex>`). If the
 *    upstream *accepts* it, the upstream does not validate the field, so every
 *    per-level answer it could give would be a false positive: the run stops as
 *    `non-validating` and yields no picker control.
 * 3. **levels** — only once validation is proven, each canonical level is tested
 *    for acceptance.
 *
 * Any answer that is neither "accepted" nor "a decisive refusal" voids the run to
 * `unknown`: a sweep never guesses from silence. Probing spends credit, so it is
 * only ever started by an explicit user action, and a transient `unknown` must
 * not overwrite an earlier decisive record — that rule lives in the store.
 *
 * @module dsh-raccoon-connect/probe
 */
```

`CONNECT/src/probe.ts:56`（拒绝识别词表）：

```ts
const REFUSAL_PHRASES = ['params_invalid', 'invalid_reasoning_effort', 'reasoning_effort']
```

`CONNECT/src/probe.ts:66`：

```ts
/** Whether an attempt proves the value was accepted: 200 *and* streaming began. */
```

`CONNECT/src/probe.ts:71-73` + `:121-122`：

```ts
export function sentinelValue(randomHex: () => string): string {
  return `probe_sentinel_${randomHex()}`
}
...
/** 24 hex chars of randomness, so a sentinel can never collide with a real value. */
```

`CONNECT/src/probe.ts:87-119`（sweep 主流程）：

```ts
  const levels = options.levels ?? PROBE_LEVELS
  const stopped = options.isStopped ?? (() => false)

  const baseline = await send(undefined)
  if (!isAccepted(baseline)) return { validation: 'unknown', efforts: [] }

  const sentinel = await send(sentinelValue(() => randomHex()))
  if (stopped()) return { validation: 'unknown', efforts: [] }
  if (isAccepted(sentinel)) return { validation: 'non-validating', efforts: [] }
  if (!isRefusal(sentinel)) return { validation: 'unknown', efforts: [] }

  const efforts: string[] = []
  for (const level of levels) {
    const attempt = await send(level)
    if (stopped()) return { validation: 'unknown', efforts: [] }
    if (isAccepted(attempt)) { efforts.push(level); continue }
    // A decisive refusal is an answer ("this level is not offered"); anything
    // else is silence, and silence voids the run rather than skipping a level.
    if (!isRefusal(attempt)) return { validation: 'unknown', efforts: [] }
  }
  return { validation: 'validating', efforts }
}
```

`CONNECT/src/upstream.ts:424-450`（探针构造）：

```ts
/**
 * Spend the smallest possible request to learn whether one parameter value is
 * honored.
 *
 * `max_tokens` is kept at the gateway's floor and the reader hangs up on the
 * first SSE event, because a probe that waits for a full answer is a paid
 * completion wearing a lab coat.
 */
async probeEffort(accessToken, model, options = {}) {
  const messages = []
  if (options.systemPrefix !== undefined && options.systemPrefix !== '') messages.push({ role:'system', content: options.systemPrefix })
  messages.push({ role: 'user', content: 'ping' })
  const payload = { model, stream: true, messages, max_tokens: options.maxTokens ?? 1 }
  if (options.effort !== undefined) payload['reasoning_effort'] = options.effort
  ...
}
```

`LOCAL` 的替代做法（`LOCAL/src/raccoon.ts:547-557`）：

```ts
const effort = options.reasoningEffort
if (effort !== undefined) {
  // `thinking.type` is the on/off switch; `reasoning_effort` carries the
  // level that OpenRouter's live metadata says the model accepts.
  if (effort === RACCOON_EFFORT_OFF || effort === 'none') {
    body.extra_body = { thinking: { type: 'disabled' } }
    if (effort === 'none') body.reasoning_effort = 'none'
  } else {
    body.extra_body = { thinking: { type: 'enabled' } }
    if (effort !== RACCOON_EFFORT_ON) body.reasoning_effort = effort
  }
}
```

`LOCAL/src/catalog.ts:57-58`：

```ts
export const RACCOON_EFFORT_ON = 'on'
export const RACCOON_EFFORT_OFF = 'off'
```

> **`extra_body.thinking` 是否被小浣熊网关接受：未验证。** `UPSTREAM` 的实测只覆盖 `reasoning_effort`。

`CONNECT` 的 README 解释为何要探测（`README.md:166`）：

```
WorkBuddy 的上游在模型列表里**结构化地声明**了推理能力（`reasoning.supports` / `supportedEfforts[]` / `canDisableThinking`），插件照着填下拉就行，一次请求都不多花；探测只是它给"没声明的行"留的备用路径。小浣熊这边没有这个字段——目录行的全部字段是 `name / description / display_description / visible / model_name / tags / ability_level / params / billing_*`，没有任何一处提到档位，App 自己也从不发 `reasoning_effort`。所以档位只能实测，实测就要花积分，于是结论被缓存：按**账号 + 目录行指纹**（id、能力标签、上下文窗口、输出上限）存在 `~/.dsh/.raccoon-probe.json`，有效期 14 天，上游改了这一行就自动作废重测。
```

---

## 16. 参考实现：refresh 单飞（Rust）

**来源**：`aimod-cc/agent2api@HEAD/desktop-tauri/src-tauri/server/src/server/core/providers/refresh_flight.rs`
**HTTP**：200，12 265 B。这是 magpie 的移植来源。

`refresh_flight.rs:1-40`（模块头，记录了**两个真实踩过的坑**）：

```rust
//! 凭证刷新的**单飞原语**（Raccoon 与 AutoClaw 共用；刷新生命周期修复）。
//!
//! ── 它解决什么 ──────────────────────────────────────────────
//! 同一凭证的并发刷新只该发一次真实请求：后到者复用那一次的结果，而不是各自去
//! 打上游。但「单飞」在 Rust 里有两个必须一起关掉的坑，本模块把两者都关掉：
//!
//!   1. **旧结果不能留在表里当缓存**。旧实现把「刚落地的结果」写回进程级表并
//!      长期保留，于是 `force = true`（401 之后的强制刷新）会命中那条旧记录，
//!      拿回**同一个被拒的坏 token** —— 「刷新后重试一次」退化成「用同一个坏
//!      token 再打一次」。本模块**没有 Done 槽**：结果只经由 `Arc<Flight>`
//!      交给**已经加入这次 flight 的等待者**（他们手里有 `Arc`），表项在本轮
//!      结束（成功/失败/取消）时被移除。因此 `force = true` 在上一轮结束后一定
//!      发起新请求，失败也不会被无限缓存。
//!   2. **取消（future 被 drop）必须释放占位并唤醒等待者**。转发链路的 future
//!      随时可能被 drop（客户端断开、超时取消）。旧实现里 leader 的 future 一被
//!      drop，占位就永久留在表里 —— 后续请求全部走进等待循环，直到 30 秒超时
//!      才拿到 409，而且**再也刷不了**。本模块的 leader 持有一个 RAII 守卫
//!      （[`LeaderGuard`]）：无论正常结束、`?` 提前返回还是 future 被 drop，
//!      `Drop` 都会把这一格从表里移除并唤醒等待者（等待者拿到「已取消」，
//!      于是可以重试）。
//!
//! ── 锁与唤醒的纪律（踩过的坑）───────────────────────────────
//!   - **不在 await 点持有 `std::sync::MutexGuard`**：所有表操作都在同步函数里
//!     完成，锁在函数返回前释放 —— 否则 future 不是 `Send`（转发跑在多线程
//!     运行时上），而且会真的死锁。
//!   - **没有丢唤醒窗口**：等待者拿的是 join 时 `watch::Sender::subscribe()`
//!      得到的 `Receiver`，**订阅先于返回**；leader 结束时的信号一定发生在
//!      「表项移除」之后，因此「join 时表项还在」蕴含「订阅早于这次信号」，
//!      `changed()` 不会错过它。醒来后先查结果槽，再决定是否继续等。
//!   - **先移除表项、再写结果/发信号**：这样「结果可读」蕴含「表项已释放」，
//!      `force = true` 的下一轮不会撞上刚完成的那一格去误复用旧结果。
//!   - **表 key 绝不打印**：key 里含凭证指纹，只作为 `HashMap` 的键存在；
//!      日志只打账号 id 这种非敏感值。
//!
//! ── 为什么 key 由调用方构造 ─────────────────────────────────
//! 两家的凭证形态不同（Raccoon 的 `id` 是账号 id，AutoClaw 桌面来源的 `id` 是
//! 固定的 `desktop-auth`），key 必须带上「provider 内账号 / 凭证来源 + 该来源
//! 自己的版本语境」才不会被别的账号、或换号后的新凭证误复用。构造规则留在各自
//! 的 `credentials.rs`（那里才知道哪些字段参与身份判定，以及哪些字段只能以
//! 指纹形式进 key），本模块只保证「同 key 单飞、异 key 并行」。
```

`refresh_flight.rs:51-71`（超时与指纹）：

```rust
/// 等一次并发刷新的上限（150 × 200ms = 30 秒）。
///
/// 刷新请求自身的超时是 30 秒（两家的 `AUTH_REQUEST_TIMEOUT_MS` /
/// `REQUEST_TIMEOUT_MS`），leader 通常先于本上限结束；这里是「leader 卡住」时
/// 的兜底，超时后等待者拿到 409，由上层决定是否重试。
const WAIT_STEPS: usize = 150;
const WAIT_STEP_MS: u64 = 200;

/// 凭证指纹：截断的 SHA-256 十六进制（32 字符）。
///
/// 只用于单飞表的 key —— 既让「同一凭证」稳定命中同一格，又不在 key 里长期
/// 持有完整 token。它与 token 同等敏感：**绝不写进日志或错误文案**。
pub fn fingerprint(secret: &str) -> String {
```

`refresh_flight.rs:86-104`（Flight 结构）：

```rust
/// 一次进行中的刷新。
///
/// 只被 leader 与**已加入的等待者**持有（`Arc`），不进任何长期缓存：
/// 表项一移除，最后一个 `Arc` 的持有者释放它，结果随之消失。
struct Flight<T> {
    /// 结果槽：`None` = 仍在刷新；`Some` = 已落地（成功或失败）
    done: Mutex<Option<Result<T, GatewayError>>>,
    /// 完成信号的版本号（自增；只用于唤醒 `watch` 订阅者）
    ...
    /// 完成信号：`send` 唤醒所有订阅者
```

`refresh_flight.rs:139-143`（表大小受限于在飞数）：

```rust
/// 单飞表：key → 正在进行的刷新。
///
/// 表里**只有进行中的 flight**：结束（成功/失败/取消）即移除，因此表的大小受
/// 「同时在飞的刷新数」限制，不会随请求量增长，也不会跨轮次留下旧结果。
pub struct Table<T> {
```

`refresh_flight.rs:181-190`（leader/waiter）：

```rust
/// 加入（或发起）一次单飞刷新。
///
/// 返回 [`Join::Leader`] 时本调用抢到了刷新权：做完真实请求后**必须**调用
/// `guard.finish(result)`（成功与失败都要）；直接 drop 等价于「取消」，
/// 等待者会收到 [`CANCELLED_MESSAGE`]。
///
/// 返回 [`Join::Waiter`] 时已有同 key 的刷新在飞，`waiter.wait().await` 等它。
pub fn join(&self, key: &str) -> Join<'_, T> {
```

---

## 17. 自相矛盾之处

**这些矛盾是真实的，不是记录错误。实现时必须知道它们存在，并按「推荐取值」处理。**

### 17.1 refresh 请求能不能带 `Authorization`

| 来源 | 说法 |
| --- | --- |
| `CONNECT/src/upstream.ts:318-319` | 「the gateway **rejects** a request that also carries an `Authorization` header」 |
| `MAGPIE:118-123` | 不带 header（`headers: { "Content-Type": "application/json" }`） |
| **`FE-WORK` 官方渲染端** | **带 header**：`headers:{"Content-Type":"application/json", ...v.createHeaders()}` |

`createHeaders()` 里 `getToken()` 非空就一定加 `Authorization: Bearer`。

**判断**：官方渲染端在刷新时**是带着 Authorization 的**（它的 `getToken()` 此时通常非空），而 `CONNECT` 的注释说会被拒。**两者不可能同时为真。**

**推荐**：**不带** `Authorization`。理由：
- `CONNECT` 与 `MAGPIE` 两份独立实现都不带，且都报告刷新可用（`MAGPIE:27` README 说「响应 `refresh_token` 为空时沿用旧值」是实测过的）。
- 「少发一个头」的风险低于「多发一个头被拒」。
- 本机实测：不带 header + 假 token → 得到正常的业务错误 `100002`（**不是** 401「不该带 Authorization」类错误），**说明服务端在无 Authorization 时正常处理刷新请求**。

**未验证**：带 header 时是否真的被拒。**这是 §9.1 的三处最大不确定点之一。**

### 17.2 空 body 刷新的错误码

| 来源 | 说法 |
| --- | --- |
| `UPSTREAM:39` | 「body 缺失返回 `100000 request_body_error`」 |
| **本机实测** | `{}` → `400 {"code":100002,"details":"param token invalid format invalid"}` |

**判断**：上游已改（`UPSTREAM` 记录于 2026-09，本机实测 2026-11）。**以实测为准。**

### 17.3 `X-Client-Platform` 的取值

| 来源 | 值 |
| --- | --- |
| `UPSTREAM:50`（官方渲染端实测） | `web` / `desktop` |
| `CONNECT/src/client-identity.ts:97` | `desktop`（默认） |
| `LOCAL/src/raccoon.ts:36-39` | `desktop-windows` / `desktop-macos` / `desktop-linux` |
| `MAGPIE:400-401` | `desktop-windows` / `app-android` |

**判断**：`desktop` 与 `desktop-windows` 都被用过。**没有证据表明服务端校验此头**（本机探针完全不带该头，仍得到正常业务响应）。

**推荐**：有真实值才发；个人版不必强行造一个。若要发，`desktop` 有第一方依据（`UPSTREAM` 实测文档）。

### 17.4 `X-Org-Code` 空值该发还是不该发

| 来源 | 做法 |
| --- | --- |
| **`FE-WORK` 官方** | `if(C) m["X-Org-Code"]=C` —— **空则不发** |
| `CONNECT/src/upstream.ts:232` | `'X-Org-Code': ''` —— **发明文空串** |
| `LOCAL/src/raccoon.ts:97` | `'x-org-code': ''` —— **发明文空串** |
| `MAGPIE` | 不发 |
| `UPSTREAM:48` | 「个人版留空即可」 |

`CONNECT` 自己的注释（`upstream.ts:220-226`）说「identity headers are **omitted rather than sent empty** ... an empty `X-Client-Device-ID` is a different statement from no header」—— 但 `X-Org-Code` 恰恰发了空串，**注释与代码不一致**。

**判断**：第一方行为是「空则不发」。**推荐不发**（与官方一致）；发空串也没有证据会失败。

### 17.5 账单端点 v1 还是 v2

| 来源 | 端点 |
| --- | --- |
| **`FE-WORK` 官方** | `/api/web/points/v2/bills` |
| `LOCAL/src/raccoon.ts:473` | `/points/v2/bills` |
| `MAGPIE:450` | `/api/web/points/v1/bills` |

**判断**：`v1` 与 `v2` 都实测返回 401（都存在）。**推荐 `v2`**（第一方 + LOCAL 一致）。若 v2 返回字段结构不符，回退 v1。

### 17.6 签到：触发还是不触发

| 来源 | 做法 |
| --- | --- |
| `LOCAL/src/raccoon.ts:506-514` | **只读**，明确拒绝触发（产品决策） |
| `MAGPIE:438` | **触发** `setting_info` 再核对 |
| `CONNECT` | **完全不做**，只给链接 |

**判断**：不是技术分歧，是产品决策。**技术上触发是安全的**（服务端按天幂等）。若要「一键签到」，用 `MAGPIE` 的两步结构。

### 17.7 `reasoning_effort` 是否为有效参数

| 来源 | 结论 |
| --- | --- |
| `UPSTREAM:89-90` | App 自己**不发送**该参数；上游是否校验未知 |
| `UPSTREAM:159-184` | 逐值实测：部分校验，哨兵值被放过 |
| `LOCAL/src/raccoon.ts:547-557` | 发 `reasoning_effort` + `extra_body.thinking` |
| `CONNECT` | 只在用户授权后探测，且哨兵被接受就**不给档位控件** |

**判断**：**「200」不能证明档位生效**（垃圾值也 200）。`LOCAL` 的 `extra_body.thinking` **未验证**。

---

## 附：本机环境事实

```bash
$ ls ~/.box-agent/config/
ls: cannot access 'C:/Users/xingx/.box-agent/config/': No such file or directory

$ ls "$APPDATA/office-raccoon/"
ls: cannot access 'C:\Users\xingx\AppData\Roaming/office-raccoon/': No such file or directory
```

- 未安装桌面客户端 → 无 `auth.json`、无 `desktop-device-identity.json`
- `~/.agent2api/` 不存在 → 无 agent2api 数据库可导入
- 无真实凭据 → **所有需鉴权的响应体均未取得**

因此：**凡涉及真实账号返回的字段结构（余额、账单、目录、授权码换 token 成功体、扫码 success 体），本文件的证据均为参考实现代码或他机实测，不是本机实测。** 已在 `PROTOCOL.md` §9 逐条标注。
