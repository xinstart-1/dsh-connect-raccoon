# 桌面端凭据侦察：有客户端时如何自动拿到小浣熊账号

> 本文回答一个问题：**一台装了商汤小浣熊桌面端的 Windows 机器上，「零配置自动取号」这条路径的确切做法是什么。**
>
> 取证来源：参考实现 `dsh-raccoon-connect@0.2.4`（`lib/version-Bdhdp2uE.js` 解包阅读）与 `dsh-llm-adapters@1.2.7`（`src/auth.ts`、`src/account-store.ts`）；本机实测用 `tools/probe-desktop-creds.mjs`。
>
> **本文不含任何 token、cookie、手机号明文。** 字段一律只报名字、类型、长度与 JWT 声明名。

---

## 0. 结论速览（先看这个）

| 问题 | 结论 |
| --- | --- |
| 本机装了桌面端吗 | **没装**。注册表三处、文件系统、进程、协议处理器、下载目录全部无命中 |
| 凭据文件在不在 | **不在**。`C:\Users\xingx\.box-agent\config\auth.json` 不存在 |
| `agent2api.db` 在不在 | **不在**。`~/.agent2api/` 目录都不存在 |
| 凭据文件长什么样 | 扁平 JSON，5 个键：`access_token`、`refresh_token`、`office_identity`、`office_org_name`、`office_org_role`，**明文**（非加密信封） |
| 能读到期时间吗 | 能。文档自身**不存**过期时间，只能解 JWT 的 `exp`（access ≈3h，refresh ≈30d） |
| 桌面端能同时登多账号吗 | **不能**。一个 `auth.json` 一份登录态，账户池拿不到；要第二账号只能靠 `BOX_AGENT_CONFIG_DIR` 整体换 profile |
| 写回可行吗 | 可行，但**默认应当只读**；只在临近过期时刷新一次并原子写回，首次写回前备份到 `$DSH_HOME` |

本机实测完整输出：

```bash
node tools/probe-desktop-creds.mjs          # 人读
node tools/probe-desktop-creds.mjs --json   # 机器读
```

---

## 1. 凭据文件的确切位置

参考实现 `RACCOON_PRIMARY` 里把路径写死成三段，解析顺序如下（`desktopAuthCandidatesFor()`）：

| 优先级 | 来源 | 拼出的路径 |
| --- | --- | --- |
| 1 | 环境变量 `RACCOON_AUTH_FILE` | 直接当**文件**路径用，短路其余全部 |
| 2 | 环境变量 `BOX_AGENT_CONFIG_DIR` | `<该目录>/auth.json` |
| 3 | 默认 | `os.homedir()/.box-agent/config/auth.json` |

Windows 上的默认值就是 `C:\Users\<user>\.box-agent\config\auth.json`。

> **本机实测**：`HOME=C:/Users/xingx`（MSYS 风格）、`USERPROFILE=C:\Users\xingx`、`os.homedir()=C:\Users\xingx`，三者指向同一目录，无分歧；`RACCOON_AUTH_FILE` 与 `BOX_AGENT_CONFIG_DIR` 均未设置。
>
> 探针会把这个分歧显式报出来（`resolution.home` / `homeFromEnv` / `userProfile`），因为「文件明明在、插件却读不到」最常见的原因就是 `HOME` 与 `USERPROFILE` 指向不同目录。

### 1.1 目录里应该有什么

App 自己的目录结构（`BOX_AGENT_CONFIG_DIR` 可整体搬走）：

```
<configDir>/
└── auth.json        ← 唯一的登录态文件，登录时写、每次刷新令牌时重写
```

参考实现从不读同级其它文件，只认 `auth.json` 一个。探针会列出同级文件（`siblings`）、残留的 `*.tmp`、以及 App 可能留的 `*.lock`——这三样直接决定写回是否安全（见 §5）。

---

## 2. `auth.json` 的键结构

### 2.1 顶层 schema

文档是**扁平**的，没有嵌套对象：

```jsonc
{
  "access_token":     "<string>",   // 必填，JWT，约 3 小时过期
  "refresh_token":    "<string>",   // 必填，JWT，约 30 天过期；单次使用，刷新即轮转
  "office_identity":  "<string>",   // 身份，实测取值形如 "personal"
  "office_org_name":  "<string>",   // 企业名，个人账号时可能缺省
  "office_org_role":  "<string>"    // 企业内角色，个人账号时可能缺省
}
```

**App 自己的键序**就是上面这个顺序，参考实现用常量 `DESKTOP_TOKEN_KEYS` 固定住它：

```js
// 写回时必须保序，否则 App 侧 diff 会出现无意义变动
const DESKTOP_TOKEN_KEYS = [
  'access_token', 'refresh_token', 'office_identity', 'office_org_name', 'office_org_role',
]
```

### 2.2 读取时的兼容别名

App 自己的读取逻辑接受 access token 的三种写法，参考实现照抄了这个宽容度（`parseDesktopAuth()`）：

```js
const accessToken = optionalString(document['access_token'])
  ?? optionalString(document['token'])
  ?? optionalString(document['auth_token'])
  ?? ''
```

即 `access_token` → `token` → `auth_token`，取第一个非空字符串。`refresh_token` **没有**别名。探针会回报实际命中的是哪个别名（`accessTokenAlias`）。

### 2.3 明文还是加密信封

参考实现对 `auth.json` 的假设是**明文 JSON**：它直接 `JSON.parse` 后读字符串字段，没有解密分支。

但要防一手「未来版本改用 OS keychain 加密」。探针的 `detectEnvelope()` 识别两类形态：

```jsonc
// 形态 A：带 $ 前缀的标记键（Electron safeStorage 风格）
{ "access_token": { "$safeStorageEncrypted": 1, "envelope": "<base64>" } }

// 形态 B：无标记、但键名是密码学信封
{ "access_token": { "ciphertext": "...", "iv": "...", "tag": "..." } }
```

命中时 `structure.<field>.envelope.encrypted = true`，且 `accessTokenAlias` 为 `null`（因为不是字符串）。**这代表读路径失效，必须重新取证，不能想当然按明文读。**

### 2.4 token 是不是 JWT，能读出什么

两个 token 都是标准三段 JWT。参考实现的 `decodeJwtClaims()` 只做 base64url 解码、**不验签**——验签是上游的事，插件只负责转发。

从 access token 的 payload 能读到：

| 声明 | 用途 | 是否写进文档 |
| --- | --- | --- |
| `exp` | **过期时间**，凭据文件自身不存这个字段，只能从 token 取 | ✅ 写（ISO 时间） |
| `iat` | 签发时间 | ✅ 写 |
| `iss` | 签发方 | ⚠️ 只报「存在」 |
| `name` | 昵称 | ⚠️ 只报「存在」，**不写值** |
| `phone` | 手机号 | ⚠️ 只报「存在」，**不写值** |
| `sid` | 会话 id，账号稳定标识的来源 | ⚠️ 只报「存在」，**不写值** |
| `sub` | 网关侧账号 id | ⚠️ 只报「存在」，**不写值** |

探针的脱敏规则（`describeJwt()` + `describeNode()`）：

- JWT 只输出 `header.alg/typ/kidPresent`、`claimNames`（键名数组）、`exp`、`iat`，以及 `hasName`/`hasPhone`/`hasSid`/`hasSub`/`hasIss` 五个布尔。
- 非 JWT 字符串只输出 `length` + `shape`（`digits` / `base64ish` / `text`），**不输出前缀**；仅当键名不含 `token|secret|cookie|password|credential|session|jwk|key` 且值不是纯数字时，才给 6 字符前缀（如 `office_identity` 的 `person…`）。
- 纯数字串一律显示成 `digits(11)`，杜绝手机号泄漏。

> **实测校验**：用一份合成 fixture（塞入假的昵称、11 位手机号、`sid` 占位字符串）跑探针，输出中这三个值出现次数均为 **0**，而 `exp` 能正确算出 `expiresInSeconds=3599`。脱敏与取值两条路径同时生效。

---

## 3. 本机是否装了桌面端

### 3.1 扫描范围

| 面 | 具体位置 |
| --- | --- |
| 注册表 Uninstall | `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`、`HKLM\SOFTWARE\WOW6432Node\...\Uninstall`、`HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall` |
| 注册表 协议处理器 | `HKCU\SOFTWARE\Classes\{xiaohuanxiong,raccoon,sensetime,box-agent}` |
| 文件系统 | `%LOCALAPPDATA%`、`%APPDATA%`、`%LOCALAPPDATA%\Programs`（含下钻一层）、`Program Files`、`Program Files (x86)`、开始菜单（当前用户 + 全局） |
| 进程 | `tasklist` 全表匹配 |
| 下载目录 | `~/Downloads` 里的安装包残留 |

匹配关键词：`raccoon`、`xiaohuan`、`sensetime`、`商汤`、`小浣熊`、`box-agent`、`boxagent`、`raccoonwork`（大小写不敏感）。

### 3.2 本机实测结果

```
installed: false
verdict: not installed (no registry, filesystem or process evidence)
```

| 证据面 | 结果 |
| --- | --- |
| 注册表 Uninstall 三处 | 可读（HKLM 54 + WOW6432Node 102 + HKCU 16 个子键），**DisplayName 命中 0** |
| 协议处理器 | **0** 个 |
| 文件系统命中 | **0**（含下钻） |
| 运行进程 | **0** |
| `~/Downloads` 安装包 | **0** |
| `.box-agent` 目录（全盘 shallow） | **不存在** |

### 3.3 一条踩过的坑（必须记住）

本机 `%APPDATA%` 下有 `kdesk` 与 `kdesk_yyb` 两个目录，名字很像某个桌面端，且 `kdesk` 有 8KB 内容。**实测它们是金山壁纸 SDK 的日志目录**（`kdesk/log/kwallpapersdkdll.log`），与本项目无关。

> 这与项目记忆里「目录名找错了（是 `kdesk`，不是产品名）」是**相反**的教训：`kdesk` 在本机确实存在，但它是**另一个产品**。不能因为目录名像就认定装了客户端。
>
> 判定「装了」必须同时有：注册表 DisplayName / 协议处理器 / 文件系统目录 / 运行进程 **至少一项**，且路径内容能对上小浣熊（例如存在 `auth.json` 或 `box-agent` 字样）。探针把 `installed` 做成这五项的逻辑或，就是为了不让单个可疑目录名翻转结论。

---

## 4. 桌面端能否同时登录多个账号

**结论：不能。一个 `auth.json` 只承载一份登录态，账户池无法从客户端直接拿到多账号。**

三条独立证据：

1. **文件形态是单账号**：顶层是扁平 token 对，没有 `accounts[]`/`users[]`/`profiles[]` 这类容器。参考实现的 `parseDesktopAuth()` 解析出的是**单个** `RaccoonCredential`，不是数组。
2. **插件自留副本也是单账号**：`account-store.ts` 里 Raccoon 的字段是 `raccoon?: RaccoonAccountRecord`（**单值**），而 Trae 是 `trae?: Partial<Record<TraeRegion, TraeAccountRecord>>`（按区域分槽）。上游明确只给 Raccoon 留了一个槽，说明它按「一人一号」设计。
3. **换目录 ≠ 多账号**：`BOX_AGENT_CONFIG_DIR` 能整体搬走配置目录，理论上可以做多个 profile 目录，但那是「装了几套互不相干的登录态」，不是客户端本身支持多账号切换；App UI 里没有账号切换入口。

### 4.1 那账户池还能从哪来

| 来源 | 可行性 |
| --- | --- |
| 桌面端单账号 | ✅ 唯一稳的来源，但只有 1 个 |
| 多个 `BOX_AGENT_CONFIG_DIR` profile | ⚠️ 技术上可行，需要用户手工准备 N 份目录；不建议当作产品能力宣传 |
| `~/.agent2api/agent2api.db` 一次性导入 | ⚠️ 取决于存量，本机不存在（见 §6） |
| 网页扫码另行登录 | ✅ 与桌面端凭据**互不依赖**的另一条通道 |

> 参考实现的多账号实际上是**插件自己存的**，不是客户端给的：`dsh-llm-adapters` 有自己的 `accounts.json`（`FILE_NAME = 'accounts.json'`，落在 `$DSH_HOME` 下），Raccoon 只是其中一个单值槽位。所以「账户池」要自己维护，客户端不提供。

---

## 5. 写回策略的可行性

### 5.1 为什么必须考虑写回

刷新接口是**单次使用轮转**：换一次令牌，`access_token` 与 `refresh_token` **一起换新**，旧 refresh token 立刻失效。

于是有两条路，且只有两条：

- **只读不刷新**：安全，但 access token 约 3 小时就死，必须让用户重开 App 刷新。
- **刷新并写回**：能长期用，但**必须把新令牌原子写回 App 自己的 `auth.json`**；不写回，App 下次拿旧 refresh token 去换会撞 `refresh_conflict`，**用户被登出**。

参考实现的判断很明确（源码注释原文）：*"a client that refreshes without writing the pair back would log the desktop app out at its next refresh"*。

### 5.2 App 自己的写入方式

参考实现是**照着 App 的写法抄**的（`writeAtomically()`）：

```js
const temp = `${path}.${process.pid}.tmp`
await writeFile(temp, payload, { encoding: 'utf8', mode: 0o600 })  // 384 = 0o600
await rename(temp, path)                                          // 原子替换
```

即 **临时文件 + rename**，权限 `0600`。同目录 rename 在 NTFS 上是原子的，App 不可能观察到半写状态，因此**不会**触发「文件损坏」类校验。

### 5.3 会不会触发客户端校验

| 风险点 | 判断 |
| --- | --- |
| 半写文件 | ❌ 不会。临时文件 + 同目录 rename 是原子的 |
| 权限被改宽 | ❌ 不会。写回固定 `0600` |
| App 发现文件被外部改动 | ⚠️ 理论上可能。但参考实现每次解析前都**重新读盘**（App 自己不缓存），所以文件即真相，没有内存态比对 |
| **字段丢失** | ⚠️ **真实风险**。写回必须保留 App 原有的其它字段与键序，否则 App 读到缺失字段可能重置登录 |
| **并发刷新** | ⚠️ **最高风险**。两个进程同时刷新会烧掉唯一一次 refresh token，另一个直接失效 |

**结论：写回在文件层面是安全的（不会写坏、不会触发校验），风险集中在「保字段保序」和「并发单飞」两点。**

### 5.4 推荐策略（按优先级）

1. **默认只读**：token 未过期就直接用，**不发任何网络请求**。这是绝大多数时间的路径。
2. **只在余量内刷新**：参考实现用 `refreshMarginMs = 5 分钟`（300000ms）；进入余量才刷新。
3. **单飞（single-flight）**：`inflight` Promise 合流，并发请求共享同一次刷新。**这一条在小浣熊上比别处更重要**，因为并发刷新 = 烧掉唯一令牌。
4. **刷新后写回**：保留未知字段 + 保持 `DESKTOP_TOKEN_KEYS` 键序，`0600`，临时文件 + rename。
5. **首次写回前备份**：把被替换的文档原文存到 `$DSH_HOME`（参考实现落在 `join(dirname(ownPath), \`${ownFilename}-desktop-backup\`)`，即 `$DSH_HOME/.raccoon-auth.json-desktop-backup`），`0600`。这是唯一回滚材料。
6. **撞 `refresh_conflict` 先重读**：错误文本包含 `refresh_conflict` 或 **`200822`**（`isConflict()` 判据）。此时 App 很可能刚自己刷新过，**先重读 App 文件**，拿到有效令牌就继续；拿不到才报错并提示「打开一次小浣熊重新登录」。
7. **退出登录只删自己的**：`logout()` 只删插件自留副本、`.lock` 与备份，**绝不动 App 的 `auth.json`**——删了等于把用户从客户端登出。

### 5.5 本机可行性

本机 `writeBack.applicable = false`——没有凭据文件，没有可写回的对象。探针在这种情况下不臆测，直接说明「首次写回需要先建目录」。

一旦有文件，探针会回报 `mode`、`ownerWritable`、同级残留 `*.tmp` / `*.lock`。**有 `*.tmp` 残留说明上次写入被打断，写回前应先确认文件完整性；有 `*.lock` 说明 App 可能用文件锁，写回需要配合重试。**

---

## 6. `agent2api.db` 一次性导入源

第三方 `agent2api`（aimod-cc）把小浣熊账号存在 SQLite 里：

```
~/.agent2api/agent2api.db
表：accounts(provider, enabled, data JSON)
```

探针用 `node:sqlite` 的 `DatabaseSync(file, { readOnly: true })` 打开——**`readOnly: true` 是硬要求**，否则会创建 `-wal`/`-shm` 文件、甚至改写数据库。

读取内容（不含 provider 数据本体）：

| 字段 | 含义 |
| --- | --- |
| `tables[]` | 表/视图名、行数、列定义（名/类型/notnull） |
| `providerCounts` | 按 `provider` 分组的行数 |
| `enabledCounts` | 按 `enabled` 分组的行数 |
| `dataRowsMentioningRaccoon` | `data` 列里出现 raccoon/xiaohuan/sensetime 字样的行数 |

> **本机实测：不存在。** `~/.agent2api/` 目录本身就没有，另两个候选位置（`%APPDATA%\agent2api\`、`%LOCALAPPDATA%\agent2api\`）也没有。
>
> `node:sqlite` 在本机可用（Node **v24.21.0**，导出 `DatabaseSync, StatementSync, Session, constants, backup`），所以一旦有库就能直接读。

**注意**：本机 `node` 不在 PATH 上，运行时在
`C:\Users\xingx\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`。

---

## 7. 探针脚本

`tools/probe-desktop-creds.mjs` —— 纯 Node ESM，**零依赖**，Node 内置模块。

### 7.1 用法

```bash
# 人读报告
node tools/probe-desktop-creds.mjs

# 机器读
node tools/probe-desktop-creds.mjs --json

# 跳过注册表扫描（更快，用于非 Windows 或权限受限环境）
node tools/probe-desktop-creds.mjs --json --no-registry
```

本机因 node 不在 PATH，实际调用：

```bash
"C:/Users/xingx/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe" \
  tools/probe-desktop-creds.mjs --json
```

### 7.2 只读保证

| 保证 | 实现方式 |
| --- | --- |
| 不写任何文件 | 全程只调用 `readFile` / `readdir` / `stat` / `existsSync` / `readdirSync` |
| 不改权限 | 不调用 `chmod`；`mode` 只读来**报告**，不改 |
| 不发网络请求 | 不 import `fetch`/`http`/`https`/`dns`/`net`，零 socket |
| 不刷新 token | 纯读，不触碰刷新逻辑，不构造任何上游请求 |
| 不打印敏感值 | 见 §2.4 脱敏规则；token 只报长度与声明名 |
| SQLite 只读打开 | `new DatabaseSync(file, { readOnly: true })` |

### 7.3 输出结构（`--json`）

```jsonc
{
  "probedAt": "<ISO>",
  "platform": "win32",
  "nodeVersion": "v24.x",
  "nodeSqlite": true,                    // 能否用 node:sqlite
  "resolution": {
    "home": "...", "homeFromEnv": "...", "userProfile": "...",
    "explicitFile": null,                // RACCOON_AUTH_FILE
    "configDirEnv": null,                // BOX_AGENT_CONFIG_DIR
    "resolvedDir": "...",
    "candidates": [{ "file": "...", "via": "os.homedir()" }],
    "envOverridesActive": false
  },
  "credentials": {
    "candidates": [{
      "file": "...", "exists": false, "isFile": false,
      "size": 0, "mode": "0600", "siblings": ["auth.json"]
    }],
    "configDir": "...", "tree": []
  },
  "install": {
    "installed": false,
    "verdict": "not installed (no registry, filesystem or process evidence)",
    "registry": { "hives": [...], "hits": [], "protocols": [] },
    "installRoots": { "scanned": [...], "hits": [], "deepHits": [] },
    "processesAndDownloads": { "processes": [], "downloads": [] },
    "boxAgentElsewhere": []
  },
  "otherCredentialLocations": { "artefacts": [...], "multiAccount": [...] },
  "multiAccount": { "conclusion": "...", "singleAccountFileShape": true, ... },
  "writeBack": { "applicable": false, "note": "..." },
  "agent2api": { "exists": false, "sqliteAvailable": true, "searched": [...] }
}
```

文件存在且可解析时，`credentials.candidates[i]` 额外带：

| 字段 | 含义 |
| --- | --- |
| `parses` | 是否为合法 JSON |
| `topLevelKeys` | 顶层键名（**只有名字**） |
| `structure` | 脱敏结构树：per-key `type`/`length`/`jwt`/`envelope` |
| `accessTokenAlias` | 实际命中的别名（`access_token`/`token`/`auth_token`），信封加密时为 `null` |
| `accessTokenIsJwt` / `refreshTokenIsJwt` | 是否 JWT |
| `accessExpiresAt` / `accessExpiresInSeconds` / `accessExpired` | 从 `exp` 算出的过期信息 |
| `refreshExpiresAt` / `refreshExpiresInSeconds` | 同上（refresh token） |
| `missingExpectedKeys` / `unexpectedKeys` | 与 `DESKTOP_TOKEN_KEYS` 的差集 |
| `keyOrderMatchesApp` | 键序是否与 App 一致（写回保序的必要条件） |
| `siblings` | 同级文件/目录，用于发现 `*.tmp` / `*.lock` |

### 7.4 已验证

| 场景 | 验证方式 | 结果 |
| --- | --- | --- |
| 真实机器（无客户端） | 直接跑 | `installed=false`，exit 0，17KB JSON |
| 合成明文凭据 | 临时目录 fixture | 5 键全部识别，`keyOrderMatchesApp=true`，`expiresInSeconds=3599` |
| 合成加密信封 | fixture 含 `$safeStorageEncrypted` | `envelope.encrypted=true`，`accessTokenAlias=null` |
| **脱敏** | fixture 塞入假昵称/手机号/sid | 输出中三者出现 **0 次** |
| SQLite 只读 | `node:sqlite` 导入 | 可用，`readOnly:true` |
| 不写上游文件 | fixture 跑完后 `ls` | 文件仍在、内容未变 |

---

## 8. 落地建议

对「有客户端时自动获取小浣熊账号」这条路径，按下面的顺序实现：

1. **先探测，别假设**。用本探针（或等价逻辑）确认 `auth.json` 存在且键形匹配 `DESKTOP_TOKEN_KEYS`。不存在就干净地「不提供该 provider」，而不是挂一串必然失败的模型。
2. **默认只读**。token 未过期就用，不发请求。这覆盖 99% 的使用时长。
3. **只在余量内刷新，且单飞**。5 分钟余量，`inflight` 合流。
4. **刷新必须写回**，保字段、保键序、`0600`、临时文件 + rename。
5. **首次写回前备份到 `$DSH_HOME`**，`0600`。
6. **`refresh_conflict` / `200822` 先重读**，再决定报错。
7. **`logout` 不动 App 文件**。
8. **账户池不要指望客户端**。桌面端单账号；多账号自己维护，或走网页扫码通道。

### 8.1 本机的实际建议

由于本机**没装客户端、也没有 `agent2api.db`**，当前唯一可行的取号路径是：

- 装桌面端并登录一次，然后走上面的只读复用；或
- 让用户手工提供 token；或
- 走网页扫码登录通道（与桌面端凭据互不依赖）。

装完之后重跑 `node tools/probe-desktop-creds.mjs`，本文件 §0 的表格会随之更新为实测值。

---

## 附：文件与命令速查

| 项 | 值 |
| --- | --- |
| 凭据文件（默认） | `C:\Users\<user>\.box-agent\config\auth.json` |
| 目录覆盖 | `BOX_AGENT_CONFIG_DIR` |
| 文件覆盖 | `RACCOON_AUTH_FILE` |
| 插件自留副本 | `$DSH_HOME/.raccoon-auth.json` |
| 写回备份 | `$DSH_HOME/.raccoon-auth.json-desktop-backup` |
| 刷新冲突标记 | `refresh_conflict` / `200822` |
| 上游网关 | `https://xiaohuanxiong.com/api/web/llm/v2` |
| 探针 | `tools/probe-desktop-creds.mjs` |
