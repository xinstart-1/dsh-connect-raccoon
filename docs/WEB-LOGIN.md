# 网页登录取小浣熊凭据（无桌面客户端）

> 侦察时间：2026-11-10 · 探针经 `-x http://127.0.0.1:7897` 只读/无凭据发出
> 结论一句话：**用 `desktop_callback=loopback` 让官方授权页自己把授权码 GET 回 `http://127.0.0.1:<port>/auth/callback`，DSH 本地起服务器接住，无需 DevTools、无需客户端。**

---

## 0. 一句话结论与排序

| 排序 | 路径 | 用户步数 | 需要 DevTools | 可靠性 | 拿到 refresh_token |
| --- | --- | --- | --- | --- | --- |
| **① 推荐** | **授权页 + 本地回环回调**（`desktop_callback=loopback`） | 3 步 | 否 | 高（官方 SPA 一等公民参数） | 是 |
| ② 备选 | 微信小程序扫码（`/api/iam/v1/auth/mp/qrcode`） | 2 步 | 否 | 中（仅微信、无 refresh） | 否（未验证有） |
| ③ 兜底 | 授权页 + DevTools 手粘授权码 | 6 步 | **是** | 中（一次性码、易失效） | 是 |

路径 ① 之所以可行，是因为官方 SPA 的授权页**显式支持把授权码投递到本地回环地址**，这是给 IDE 插件（VSCode / JetBrains）用的，`desktop_callback` 只接受一个值：`loopback`。

---

## 1. 探针证据总表

所有请求均无凭据、空体或格式错误的假值，仅用于确认端点存在与字段名。

| # | 请求 | 状态码 | 响应片段 |
| --- | --- | --- | --- |
| 1 | `POST /api/iam/v1/auth/mp/qrcode` `{}` | **200** | `{"code":"OK","data":{"expires_in":300,"poll_interval":2,"qrcode_code":"qr-01a1c34b-...","scan_path":"/login/mp","status":"pending"}}` |
| 2 | `POST /api/iam/v1/auth/mp/qrcode/login` `{"qrcode_code":"<刚拿到的>"}` | **200** | `{"code":"OK","data":{"expires_in":300,"poll_interval":2,"status":"pending"}}` |
| 3 | `POST /api/iam/v1/auth/mp/qrcode/login` `{"qrcode_code":"qr-0000…"}` | 200 | `{"code":"AUTH_QRCODE_INVALID","message":"mini-program QR code invalid"}` |
| 4 | `POST /api/iam/v1/sms/send` `{}` | 200 | `{"code":"COMMON_INVALID_ARGUMENT","message":"nation_code required"}` |
| 5 | `POST /api/iam/v1/sms/send` `{nation_code,phone,scene:"login"}` | 200 | `{"code":"COMMON_INVALID_ARGUMENT","message":"captcha_token required"}` |
| 6 | `POST /api/iam/v1/auth/login/sms` `{}` | 200 | `{"code":"COMMON_INVALID_ARGUMENT","message":"verification_id invalid"}` |
| 7 | `POST /api/web/auth/v1/authorization_code` `{}` | 200 | `{"code":200001,"message":"authorization_empty_error","details":"authorization empty"}` |
| 8 | `POST /api/web/auth/v1/login_with_authorization_code` `{}` | 400 | `{"code":200035,"message":"authorization_code_not_found_error","details":"authorization code not found"}` |
| 9 | `POST /api/web/auth/v1/refresh` `{}` | 400 | `{"code":100002,"message":"params_invalid_error","details":"param token invalid format invalid"}` |
| 10 | `GET /code/authorize?...` | **307** | `location: /authorize?login_source=desktop&…`（保留全部 query） |
| 11 | `GET /authorize?…&desktop_callback=loopback` | **200** | 官方 SPA HTML（Next.js，`raccoon-website/prod/mime-v1`） |
| 12 | `POST /api/web/auth/v1/iam/confirm`（假 Bearer） | 401 | `{"code":200001,…}`；仅回 `INGRESSCOOKIE`，**未下发 `xhx_token`** |
| 13 | `GET /api/web/llm/v2/model_catalog`（假 Bearer） | 200 | `{"code":200003,"message":"authorization_verify_error"}` |
| 14 | `OPTIONS /api/web/auth/v1/login_with_authorization_code` | 200 | CORS 预检通过 |
| 15 | `GET /api/iam/v1/auth/mp/qrcode`（GET 而非 POST） | 404 | 该组端点为 POST-only，故 GET 枚举无效 |

**端点存在性判定说明**：`/api/web/auth/v1/*` 全部是 POST-only，GET 一律 404（见 #15），因此下表用 POST 空体判定。

---

## 2. 网页端登录方式盘点

站内 SPA 只实现了**两种**登录方式（依据 `/authorize` 页 chunk 的 i18n 字典，`qrTitle`/`qrHelp` 与 `smsLogin`）：

| 方式 | 端点 | 请求体 | 返回体 | 证据 |
| --- | --- | --- | --- | --- |
| **微信扫码** | `POST /api/iam/v1/auth/mp/qrcode` → 轮询 `/auth/mp/qrcode/login` | 创码：`{}` 或 `{"product_codes":["…"]}`；轮询：`{"qrcode_code":"qr-…"}` | 创码 `{qrcode_code,scan_path,expires_in,poll_interval,status}`；轮询 `{status,access_token?,token_type?}` | 探针 #1/#2；`raccoon-login.ts:146,185` |
| **手机短信** | `POST /api/iam/v1/sms/send` → `POST /api/iam/v1/auth/login/sms` | 发码：`{"nation_code","phone","captcha_token","scene":"login"}`；登录：`{"nation_code","phone","verification_id","verification_code","product_codes"?}` | 发码 `{verification_id,expires_in,retry_after}`；登录 `{access_token,token_type:"bearer"}` | 探针 #4/#5/#6；SPA chunk `c5.js`（见 §7 来源） |
| 邮箱 | —— | —— | —— | **不存在**：`/api/iam/v1/*` 无 email 端点（探测全 404） |
| 企业 SSO | —— | —— | —— | **不存在独立 SSO 端点**；`org` 只是授权页的可选参数（组织码，`^[a-zA-Z0-9_-]{1,128}$`），走同一套 IAM 登录后再带上 `X-Org-Code` |

要点：

- 短信发码**强制人机验证**：无 `captcha_token` 直接 `captcha_token required`（探针 #5）。这意味着短信通道**不能**由 DSH 后端脚本直接跑通，必须在一个真实浏览器里由用户完成。
- 扫码通道**完全无凭据、无 captcha**，纯 HTTP 即可创码与轮询（探针 #1/#2）——这是唯一能被 DSH 终端全额驱动的登录方式。
- `product_codes` 可省略，省略时服务端给默认产品集（探针 #1 空体即成功）。

---

## 3. 二维码登录：**可行**，且是唯一纯终端可展示的路径

这回答了「浏览器里扫码只给站点 cookie」的疑虑 —— **不是**。`/api/iam/v1/auth/mp/qrcode/login` 的 `success` 分支直接返回 `access_token`，它就是 Bearer 凭据本身，不是 cookie。

### 3.1 完整闭环（已探针验证前两步）

```
① POST /api/iam/v1/auth/mp/qrcode   body {}
   → {code:"OK", data:{expires_in:300, poll_interval:2,
                       qrcode_code:"qr-01a1c34b-...", scan_path:"/login/mp", status:"pending"}}
                                                     ↑ 探针实测，200

② 把下面这条 URL 渲染成二维码（这是官方 SPA 自己编码的内容）
   https://xiaohuanxiong.com/login/mp?code=<qrcode_code>&appname=商汤小浣熊&source=platform
                                                     ↑ 构造规则见 raccoon-login.ts:167-174

③ 每 poll_interval 秒轮询
   POST /api/iam/v1/auth/mp/qrcode/login  body {"qrcode_code":"qr-..."}
   → status: pending → logging（已扫码待确认） → success
   → success 时 data.access_token 即 Bearer token，data.token_type === "bearer"
                                                     ↑ 探针实测 pending，200
```

### 3.2 状态机与失败码

| `status` | 含义 | 处理 |
| --- | --- | --- |
| `pending` | 未扫码 | 继续轮询 |
| `logging` | 已扫码，手机待确认 | 提示「已扫码，请在手机上确认」 |
| `success` | 成功，取 `data.access_token` | 停止轮询 |
| `canceled` | 用户拒绝 | 终止，提示重新登录 |
| 其他值 | 视为 pending | 继续轮询 |

错误码（探针 #3 实测）：`AUTH_QRCODE_INVALID`（伪造/未知码）、`AUTH_QRCODE_EXPIRED`、`AUTH_QRCODE_NOT_FOUND`（后两者见 `raccoon-login.ts:215-217`）。

### 3.3 硬约束

1. **二维码必须服务端签发**。本地伪造的 `qrcode_code` 轮询会返回 `AUTH_QRCODE_INVALID`（探针 #3 已实证），不要试图生成假码。
2. **必须用微信扫**。`scan_path=/login/mp` 是**微信小程序内部路由**，用浏览器打开是 404（实测：普通 UA 与 MicroMessenger UA 均 404，约 6.7 KB 错误页）。扫码后由小程序完成确认，网页侧无感。
3. **有效期 300 秒，单次使用**；`expires_in` 由服务端给，客户端只做倒计时。
4. **`scan_path` 必须校验同源**：只接受 `/` 开头、非 `//`、无 `\`/空白/`#` 的相对路径，解析后必须 `https:` 且 origin 为 `https://xiaohuanxiong.com`（`raccoon-login.ts:132-140`）。
5. **未见 `refresh_token`**：轮询响应只有 `access_token` + `token_type`，参考实现也只取这两个（`raccoon-login.ts:200-212`）。扫码登录**大概率拿不到 refresh_token**，access_token 过期后只能重扫。这是选 ① 而非 ② 做主线的主要理由。

### 3.4 扫码后的第二步：换 `xhx_token` 业务 cookie

IAM 的 `access_token` 与网页业务的 `xhx_token` 是两个东西。官方网页在拿到 IAM token 后会再调一次：

```
POST https://xiaohuanxiong.com/api/web/auth/v1/iam/confirm
     Authorization: Bearer <access_token>
     x-raccoon-language: zh-CN
     body: {}
→ 200，Set-Cookie: xhx_token=<业务 token>
```

证据：`raccoon-login.ts:253-283`。**注意**：本机探针 #12 用假 Bearer 收到 401 且**没有** `xhx_token`，说明该 cookie 只在 IAM token 合法时下发——这条分支无法用无凭据探针验证，属于「按参考实现实现，未端到端验证」。

参考实现的容错策略值得照抄：**`iam/confirm` 失败不致命**，最终以 LLM 网关 `GET /model_catalog` 探针为准；`xhx_token` 拿不到就退回用 IAM `access_token` 直接当 Bearer（`raccoon-login.ts:353-365`）。

---

## 4. 凭据形态：Bearer token 对，cookie 只是副产物

| 形态 | 名称 | 域 | 属性 | 说明 |
| --- | --- | --- | --- | --- |
| Bearer | `access_token`（JWT，`eyJ…`） | 无（请求头） | —— | LLM 网关 `Authorization: Bearer` 认它 |
| Bearer | `refresh_token` | 无（请求头） | —— | 单次使用，轮转 |
| Cookie | `xhx_token` | `xiaohuanxiong.com` | 仅 `iam/confirm` 下发 | 业务 cookie，**不是** LLM 网关的凭据 |
| Cookie | `INGRESSCOOKIE` | `Path=/`、`Path=/api` | `Secure; HttpOnly` | 网关粘性会话，与登录无关，忽略 |

### 4.1 能否互换

- **cookie → Bearer：不能。** `xhx_token` 是给网页 `/api/web/*` 的会话 cookie，LLM 网关只读 `Authorization` 头。
- **Bearer → cookie：能，但单向。** 用 `/auth/v1/iam/confirm` 拿 `xhx_token`（§3.4）。
- **结论：DSH 插件只存 Bearer 对，不要存 cookie。** 存 `xhx_token` 毫无用处。

### 4.2 `/api/web/auth/v1/refresh` 认什么

```
POST https://xiaohuanxiong.com/api/web/auth/v1/refresh
Content-Type: application/json
body: {"refresh_token": "<refresh_token>"}
→ {code, data:{access_token, refresh_token}}
```

- **只认 `refresh_token` 字段**，不吃 cookie、不吃 `Authorization`（探针 #9：空体与非法值都回 `100002 params_invalid_error / param token invalid format invalid`，说明它在解析 `refresh_token` 的格式，而非缺参数）。
- 返回的 `data.access_token` 可能带 `Bearer ` 前缀，需 strip（`magpie index.mjs:58,132`）。
- **`data.refresh_token` 为空时保留旧值**（`magpie index.mjs:134-138`）——但用户任务书里说「单次使用轮转」，实测无法区分两者；**按「新值优先、空则沿用旧值」实现**即可兼容两种行为。
- **单次使用 + 轮转**：刷新必须序列化，不能并发。并发刷新会让其中一个必然失败。`magpie index.mjs:290-298` 用 Promise 链做锁，值得照抄。
- **429 要冷却**：命中 429 后 10 分钟内不再尝试（`magpie index.mjs:112-127`）。
- access_token 的过期时间从 JWT `exp` 读（`magpie index.mjs:61-68`），读不到就按 1 小时算。

---

## 5. 授权码路径完整闭环（推荐主线）

### 5.1 授权页 URL

```
https://xiaohuanxiong.com/authorize
  ?login_source=desktop
  &appname=<应用名，≤100 字符，URL 编码>
  &state=<64 位小写 hex>
  &redirect=http%3A%2F%2F127.0.0.1%3A<port>%2Fauth%2Fcallback
  &desktop_callback=loopback
```

旧路径 `https://xiaohuanxiong.com/code/authorize?...` 会 **307** 跳到 `/authorize?...` 并**保留全部 query**（探针 #10），两条都能用。

**参数规则（来自授权页 SPA 源码，逐条都是硬校验）：**

| 参数 | 要求 | 违反后果 |
| --- | --- | --- |
| 允许的参数集 | 仅 `login_source, appname, state, redirect, ide, org, lang, desktop_callback` | 其余参数被静默删除 |
| `login_source` | `desktop`（其他值会被删掉，且 `desktop` 只能出现一次） | 退化为普通网页登录，不会回调 |
| `appname` | 长度 ≤ 100 | 整个 context 判为非法 → 不回调 |
| `state` | **必须 `^[a-f0-9]{64}$`**（32 字节 hex），长度 ≤ 512 | `desktop_callback` 校验失败 → 不回调 |
| `redirect` | **必须匹配 `^http://127\.0\.0\.1:[1-9][0-9]{3,4}/auth/callback$`**，且端口 1024–65535 | 同上 |
| `desktop_callback` | **只能是字面量 `loopback`** | 且要求 `login_source=desktop`、`ide` 为空 |
| `ide` | 配合 `desktop_callback` 时必须为空 | 校验失败 |

> 关键：`state` 不是任意字符串，**必须是 32 字节随机数的 hex 小写**。生成方式：`crypto.randomBytes(32).toString('hex')` 或 `randomUUID().replace(/-/g,'')`。
> 参考实现用 UUID 去横线（`magpie index.mjs:165`），正好 32 hex 字符 = 128 位，**不满足 64 hex**，所以它走的是 `office-raccoon://` 分支而非 loopback 分支。**我们要生成 64 hex。**

### 5.2 无 DevTools 的关键机制

授权页 SPA 拿到授权码后，按 `desktop_callback` 分两条投递路线（授权页 chunk `c8.js`）：

```js
// 构造回调 URL
let r = new URL(
  e.desktop && !e.desktopCallback
    ? "office-raccoon://auth/callback"     // 有官方客户端：深链唤起
    : e.redirect                            // 有 desktop_callback：回环地址
);
r.searchParams.set(e.desktop ? "code" : "authorization_code", t);
e.state && r.searchParams.set("state", e.state);

// 投递
function T(e, t, r) {
  if (e.desktop || "idea" !== e.ide) return void r.navigate(t);  // window.location.assign(t)
  ...
}
```

也就是说：**`desktop_callback=loopback` 时，浏览器会 `window.location.assign` 到 `http://127.0.0.1:<port>/auth/callback?code=…&state=…`。** 这是一个普通的 GET，本机 HTTP 服务器直接收得到。

**这就是「不需要 DevTools、不需要客户端」的全部秘密。** 它本来是给 VSCode/JetBrains 插件用的官方通道。

### 5.3 回调响应字段名

| 场景 | 参数名 | 示例 |
| --- | --- | --- |
| `login_source=desktop` + 无 `desktop_callback`（深链） | `code` | `office-raccoon://auth/callback?code=…&state=…` |
| `login_source=desktop` + `desktop_callback=loopback` | **`code`** | `http://127.0.0.1:53682/auth/callback?code=…&state=…` |
| 普通网页 / 非 desktop（`home.51cto.com`） | `authorization_code` | `https://home.51cto.com/raccoon-auth/callback?authorization_code=…` |

**注意**：`code` 只在 `desktop` 分支用；非 desktop 用 `authorization_code`。我们的 loopback 属于 desktop 分支，所以**收 `code`**。

### 5.4 换 token

```
POST https://xiaohuanxiong.com/api/web/auth/v1/login_with_authorization_code
Content-Type: application/json
body: {"authorization_code": "<裸 code>"}
```

返回（`{code, message, data:{...}}`）：

```json
{
  "code": 0,
  "data": {
    "access_token": "eyJ…",
    "refresh_token": "…",
    "office_identity": "…",      // 可选
    "office_org_name": "…",      // 可选
    "office_org_role": "…"       // 可选
  }
}
```

证据：`magpie index.mjs:196-217`（字段名逐个从代码读出）。

- 请求体字段是 **`authorization_code`**。注意：`/authorization_code`（申请码）那个端点不吃这个字段名（它要 `{captcha_param}`），但 `login_with_authorization_code` 认它。
- 探针 #8 用任意假值都返回 `200035 authorization_code_not_found_error`，说明**服务端不校验格式、只查库**，无法用探针进一步区分字段名；字段名以参考实现代码为准。
- **`access_token` / `refresh_token` 可能带 `Bearer ` 前缀，必须 strip。**（`magpie index.mjs:58` 专门写了 stripBearer，说明真实遇到过。）

### 5.5 失败码

| code | message | 含义 | 处理 |
| --- | --- | --- | --- |
| **200035** | `authorization_code_not_found_error` | 码已用过 / 过期 / 不存在 | **重新发起登录**，不可重试 |
| 200001 | `authorization_empty_error` | 漏传码 | 编程错误 |
| 200003 | `authorization_verify_error` | Bearer 校验失败（token 类接口） | 重新登录 |
| 100002 | `params_invalid_error` | 刷新令牌格式非法 | 重新登录 |
| 200003 | `authorization_verify_error` | LLM 网关 401 等价 | 触发 refresh，再 401 就重新登录 |

**`200035` 是不可恢复的**：授权码一次性，任何重试都只会再得 200035。UI 必须直接引导「重新发起登录」，不要做自动重试。

### 5.6 申请授权码本身需要人机验证

申请授权码的端点是：

```
POST https://xiaohuanxiong.com/api/web/auth/v1/authorization_code
body: {"captcha_param": "<人机验证结果>"}
→ {code, data:{authorization_code, expires_in}}   // captcha_result !== true 则抛 CAPTCHA 错
```

证据：授权页 chunk `c8.js`，`U()` 函数。**这条我们不需要自己调**——用户是在真实浏览器里点授权按钮，captcha 由浏览器端完成。我们只是接回环回调。

### 5.7 用户手动粘一次授权码：可行，但已被 ① 淘汰

如果非要做手粘（兜底路径 ③）：

- **粘裸 code 或整条 `office-raccoon://auth/callback?code=…&state=…` 都可行。** 参考实现两种都支持（`magpie index.mjs:169-191`）。
- **`state` 必须逐字匹配**，否则拒绝（`magpie index.mjs:189`）。这是唯一的「这次登录确实由本机发起」的证明。
- 粘 `http://127.0.0.1:…` 形式的回调**也应接受**（我们的 loopback 形态），但参考实现只白名单了 `office-raccoon://auth+codename`，需要自己放宽校验。
- 校验规则：`protocol === "office-raccoon:"`、`hostname === "auth"`、`pathname === "/callback"`、`code` 非空、`state` 非空且等于期望值。

---

## 6. 其它路径评估

| 路径 | 结论 |
| --- | --- |
| **本地回环 + 官方页面**（即 ①） | ✅ 最省事。官方支持的通道，无需 DevTools。**推荐** |
| **OAuth 中间层（agent2api 那种）** | ⚠️ 本质是「读取本机 agent2api 已存的小浣熊登录态」，属于**导入别人的凭据**，不是新登录方式。可作为额外便利入口（`magpie index.mjs:501-520`），但不能当主线 |
| **抓官方客户端流量** | ❌ 用户场景就是「没有桌面客户端」，排除 |
| **纯 cookie 复用** | ❌ `xhx_token` 不是 Bearer，且需要用户从 DevTools 抄 cookie，比抄 code 更糟 |
| **短信接口直连** | ❌ 强制 `captcha_token`（探针 #5），后端脚本无法完成人机验证 |
| **微信网页扫码（非小程序）** | ❌ 站点未实现：`/api/web/auth/v1/wechat/*` 全 404。站点只有**小程序**扫码（`scan_path=/login/mp`） |

---

## 7. 来源与复现命令

### 7.1 授权页 SPA chunk

页面：`https://xiaohuanxiong.com/authorize?login_source=desktop&appname=x&state=<64hex>&redirect=http%3A%2F%2F127.0.0.1%3A53682%2Fauth%2Fcallback&desktop_callback=loopback`

关键 chunk（Next.js 产物，CDN 根 `https://sta-volc.xiaohuanxiong.com/raccoon-website/prod/mime-v1/`）：

- `_next/static/chunks/app/(identity)/authorize/page-e3bacc9bca2bfe71.js` — 授权流程、回调投递
- `_next/static/chunks/5*.js` — IAM client（`sendSms`/`smsLogin`/`createQr`/`pollQr`）
- 另有 `_next/static/chunks/{1287,162,1919,5348,6428,684,8750}-*.js`

> 这些是压缩产物，行号无意义；引用时用 chunk 名 + 函数名（`T()`、`U()`、`E` 数组、`v()`、`C()`、`N()`）定位。

### 7.2 参考实现（已解包的原始 TypeScript）

| 文件 | 用途 |
| --- | --- |
| `dsh-llm-adapters_1.2.7/package/src/raccoon-login.ts` | 扫码全流程（146/185/253/132/167 行） |
| `.../src/login-page.ts` | 本地登录页 + 轮询骨架（79 行超时） |
| `.../src/qr.ts` | 纯 SVG 二维码生成，无依赖 |
| `magpie-raccoon-auth_0.3.2/package/index.mjs` | 授权码路径（160/163/169/196/114/290 行） |

路径前缀：`X:\Agent\deepseek插件\.tmp\raccoon\`

### 7.3 复现探针

```bash
P="-x http://127.0.0.1:7897 -sS --max-time 25"

# 确认扫码通道无凭据可用
curl $P -X POST -H "content-type: application/json" -d '{}' \
  https://xiaohuanxiong.com/api/iam/v1/auth/mp/qrcode

# 确认刷新端点字段名
curl $P -X POST -H "content-type: application/json" -d '{}' \
  https://xiaohuanxiong.com/api/web/auth/v1/refresh

# 确认授权页接受 loopback 参数（期望 200）
curl $P -o /dev/null -w "%{http_code}\n" \
  "https://xiaohuanxiong.com/code/authorize?login_source=desktop&appname=x&state=$(python -c 'import secrets;print(secrets.token_hex(32))')&redirect=http%3A%2F%2F127.0.0.1%3A53682%2Fauth%2Fcallback&desktop_callback=loopback"
```

---

## 8. 对 DSH 插件的接口建议

### 8.1 `startWebLogin()`

```ts
interface WebLoginHandle {
  /** 让用户在浏览器打开的授权页 URL。 */
  url: string
  /** 本地回环端口（已监听），用于诊断。 */
  port: number
  /** 轮询状态；terminal 后不再变化。 */
  status(): WebLoginStatus
  /** 用户主动取消（关本地服务器）。 */
  cancel(): Promise<void>
}

type WebLoginPhase =
  | 'waiting'      // 等用户在浏览器里登录
  | 'exchanging'   // 已收到 code，正在换 token
  | 'validating'   // 换到了 token，正在探 /model_catalog
  | 'done'         // 成功，已保存
  | 'expired'      // 超过 timeoutMs 未完成
  | 'cancelled'    // 用户取消
  | 'error'

interface WebLoginStatus {
  phase: WebLoginPhase
  /** 面向用户的中文进度文案，直接显示在设置页。 */
  message: string
  /** 仅 error 时有。 */
  error?: { code: string; message: string }
  /** 完成时的时间戳。 */
  finishedAt?: number
}
```

**关键设计：**

1. **`url` 在 `startWebLogin()` 返回前就必须可打开**，不能等用户点第二次。本地服务器要先 `listen(0,'127.0.0.1')` 拿到端口，再拼 `redirect`，再拼授权页 URL。
2. **`state` 用 `crypto.randomBytes(32).toString('hex')`**（64 hex，硬要求，见 §5.1），存进闭包，回调时逐字比对。
3. **本地服务器只监听 `127.0.0.1` 随机端口**，路径固定 `/auth/callback`，只接受 `GET`，只读 `code`/`state` 两个 query。收到后**立即回一个静态 HTML**（「登录成功，请关闭此页」），然后关服务器。不要在这个端口上暴露任何其它能力。
4. **回调必须立即响应**。浏览器在等页面，晚 3 秒用户就会以为挂了。
5. **`cancel()` 要关服务器**，用 `ctx.effect(() => async () => …)` 收尾，防止插件卸载后端口泄漏。
6. **超时默认 5 分钟**（对齐 `login-page.ts:79` 的 `DEFAULT_TIMEOUT_MS`）。授权码 / 二维码本身 300 秒，留出换 token 的余量。

### 8.2 建议的错误码映射

```ts
const WEB_LOGIN_ERRORS = {
  // 授权码
  '200035': { code: 'CODE_EXPIRED',  message: '授权码已失效，请重新发起登录' },
  '200001': { code: 'CODE_MISSING',  message: '没有收到授权码，请重新发起登录' },
  // 刷新
  '100002': { code: 'TOKEN_INVALID', message: '登录态已失效，请重新登录' },
  // 通用
  '200003': { code: 'TOKEN_REJECTED',message: '登录令牌被网关拒绝，请重新登录' },
  // 本地
  'STATE_MISMATCH':   { code: 'STATE_MISMATCH',   message: '回调 state 不匹配，已拒绝这次登录' },
  'TIMEOUT':          { code: 'TIMEOUT',          message: '登录超时，请重新发起' },
  'NETWORK_ERROR':    { code: 'NETWORK_ERROR',    message: '无法连接小浣熊服务' },
  'INVALID_RESPONSE': { code: 'INVALID_RESPONSE', message: '小浣熊返回了无法解析的内容' },
}
```

**铁律：`200035` 永远不可重试。** 一次性码，重试只会再得 200035。

### 8.3 最小交互：一条命令让用户把 code 粘回来（兜底）

只在回环回调不可用时启用（例如用户在公司代理后面、或浏览器拦了 `127.0.0.1`）。

```
1. 插件输出授权页 URL（state 已内嵌）
2. 用户在浏览器登录 → F12 → Network → 找 authorization_code 请求 → 复制响应里的 authorization_code
3. 插件提示：
   把整条 office-raccoon://auth/callback?code=<码>&state=<state> 粘进来
   （也可只粘裸码）
4. 插件接受两种形态：
   - 含 "://" → 按 URL 解析，校验 protocol/host/pathname，取 code，state 逐字比对
   - 不含 "://" → 整串当裸 code
5. 换 token
```

**放宽点**：除了 `office-raccoon://auth/callback`，还应接受 `http://127.0.0.1:<port>/auth/callback`（我们的 loopback 形态），以及整条粘进来的 `?code=…` 片段。

### 8.4 保存什么

```ts
interface RaccoonCredential {
  accessToken: string          // strip 掉 "Bearer " 前缀
  refreshToken: string         // 可能为空（扫码路径）
  expiresAt: number            // JWT exp * 1000，读不到则 now + 3600e3
  officeIdentity?: string      // 换 token 时顺带返回，可用于显示
  officeOrgName?: string
  officeOrgRole?: string
}
```

**不要存 `xhx_token`**（见 §4.1）。**不要存 cookie jar**。

### 8.5 刷新实现要点

1. **序列化**：Promise 链当锁，并发请求共享同一次刷新（`magpie index.mjs:290-298`）。
2. **按「消耗掉的 refresh_token」记忆**：谁花掉了它，就记住花掉后得到的新对，后到的调用者直接跟随，不要重复花。
3. **429 冷却 10 分钟**（`magpie index.mjs:112-127`）。
4. **网关 401 强制刷新一次**，再 401 才判「登录态过期」。
5. **`data.refresh_token` 为空则沿用旧值**。

---

## 9. 未验证项（诚实清单）

| 项 | 状态 | 原因 |
| --- | --- | --- |
| 扫码 `success` 分支的完整响应体 | **未验证** | 需真实微信扫码确认，我不能替你扫 |
| 扫码路径是否返回 `refresh_token` | **未验证**（倾向「没有」） | 同上；参考实现只取 `access_token` |
| `iam/confirm` 成功时的 `xhx_token` 值形态 | **未验证** | 需合法 IAM token；假 Bearer 得 401 且不下发 cookie |
| loopback 回调端到端跑通 | **未验证** | 需真人在浏览器里完成登录（短信 captcha / 微信扫码），我方无凭据 |
| 短信通道是否可绕过 captcha | **判否** | 探针 #5 明确 `captcha_token required`；未尝试绕过（也不应绕过） |
| `login_with_authorization_code` 的请求体字段名 | **仅代码证据** | 服务端对任意值都回 200035，探针无法区分字段名；以 `magpie index.mjs:200` 为准 |
| `refresh` 是「轮转」还是「可重用」 | **未验证** | 两种行为都按「新值优先、空则沿用」实现可兼容 |
| 企业 SSO 是否存在独立入口 | **判否（弱）** | `/api/iam/v1/*` 与 `/api/web/auth/v1/*` 无 sso/oauth/saml 端点；`org` 参数只是组织码，不构成 SSO |
| `/login/mp` 在小程序内的最终行为 | **未验证** | 浏览器打开 404 是预期的（小程序内部路由） |

---

## 10. 最终建议

**主线走 §5 的 loopback 授权码路径。** 理由：

1. **不需要 DevTools** —— 这是相对现有方案最大的改进，用户操作从 6 步降到 3 步。
2. **不需要桌面客户端** —— 正是用户场景。
3. **拿到完整 token 对**（access + refresh），可以自动续期。
4. **官方一等公民** —— `desktop_callback=loopback` 是给 IDE 插件设计的，不是我们硬凑的野路子。
5. **兼容两种登录方式** —— 用户在授权页里用短信或微信扫码都行，我们只等回调。

**二维码作为可选的「零粘贴」快路径**（§3），适合用户手边只有微信、不想开浏览器的场景；但要接受「无 refresh_token、过期需重扫」。

**DevTools 手粘授权码降级为兜底**，只在回环地址被网络策略拦截时提示。
