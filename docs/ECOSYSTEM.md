# 生态调研：小浣熊（Raccoon）方向 DSH 插件清单 + 能力对照

> 调研对象：`dsh-connect-raccoon`（本仓库，待实现）
> 数据时间：**2026-11-10 10:29 – 10:52（+08:00）**
> 纪律：本文所有 star / 推送时间 / 版本 / 能力均来自下面附录里的 URL；取不到的写「未取到」并注明状态码，**不猜**。

## 0. 三句话结论

1. **小浣熊方向的 DSH 原生 provider 已有 4 个独立实现 + 1 个 magpie 插件 + 4 个「渠道包」式聚合插件**，但它们全部是**单账号**：没有任何一个提供账号池。
2. **账号池在生态里已经成熟，但在别的产品线上**（WorkBuddy / Trae / Qoder），其中 `dingminhua/dsh-connect-workbuddy` 的池设计是现有最完整的规格书，可直接照抄语义。
3. **「桌面端凭据」与「网页/扫码登录」在现有实现里是二选一或兜底关系，从未作为账号池里的两类成员并存** ——这正是本插件最清晰的空白。

---

## 1. 参照物：`dingminhua/dsh-connect-workbuddy` 的账号池

- 仓库：<https://github.com/dingminhua/dsh-connect-workbuddy> · **1385 ★** / 148 fork · 最后推送 `2026-11-09T14:32:50Z`
- npm：`dsh-connect-workbuddy@5.21.3`（2026-11-09）· 近 30 天下载 **101,724**
- 内核：`@deepseek-ai/dsh-llm >=0.1.7-rc.1 <0.3.0-0`

### 1.1 池的语义（可逐条复用的契约）

| # | 规则 | 原文要点 |
|---|---|---|
| P1 | **成员显式勾选，默认空** | 「本机有登录」≠「要拿它去签到和花积分」；空池**绝不**退化成「对全部账号执行」 |
| P2 | **开关只控制「插件是否替你做决定」** | 关掉池 = 手动选号 + 失败如实报错；但**签到 / 测试仍然可用**（早期版本把按钮绑在开关上，关掉就再也没法签到） |
| P3 | **开启即自动换号** | 每次请求发给排序最靠前的可用账号；失败**依次**换池内其他可用账号，全失败才报错（错误里注明试过几个账号） |
| P4 | **哪些失败换号** | 429 限流、402 无积分、401 凭据失效、502 网关/网络 = 账号态，换；**HTTP 400 不换**（同一请求体换谁都 400）；**流中途断开不重试**（会拼出两段回答） |
| P5 | **排序键（全序、可复现）** | ① 可用优先 → ② 快过期先花（3 天内到期者优先，先到期先排、临期多的优先）→ ③ 积分高 → ④ 凭据更晚过期 → ⑤ 账号 id 收尾 |
| P6 | **排序不写回用户保存的选择** | 池走运行时 override；关掉池，你选定的账号立刻完全生效；卡片显示「当前使用」因为它可能不是你选的那个 |
| P7 | **失败要记账** | 失败写成该账号的测量（含上游给的重置时间），下一个请求直接从可用账号开始；400 不记（会白闲置一个好账号）；未勾选的账号不记 |
| P8 | **积分只在有新鲜读数时参与排序**（10 分钟内），请求路径不为排序打上游 | 否则一页对话 = N 个额外请求 |
| P9 | **出池与回池** | 限流 → 按上游重置时间回池（没说就 30 分钟兜底，不编倒计时）；积分耗尽 → 按月包刷新回池；凭据被拒 / 模型不存在 → **只能手动「测试」回池**；「账号被上游限制使用」→ 停权，自动换号**会**绕开它 |
| P10 | **两个批量动作** | 「签到勾选的账号」（先查当天状态，已签不发写请求，单账号失败不中断整批）、「测试勾选的账号 × 指定模型」（默认挑倍率为 0 的免费模型，不写死名字；指定模型已离开目录则明确拒绝） |

### 1.2 凭据与登录

| # | 事实 |
|---|---|
| C1 | 凭据库：`$DSH_HOME/workbuddy-vault/<region>/<accountId>.json`，**一账号一文件** |
| C2 | **桌面 App 的认证文件始终只读、永不被改动**；插件自己刷新得到的 token 只写自己的库 |
| C3 | 区域隔离：`workbuddy` / `workbuddy-global` 两个 provider，**各一套凭据 store、catalog、回环 shim、adapter**，按凭据域名分流 |
| C4 | 扫码 / 网页登录可**不装客户端**添加账号；桌面 App 装则自动发现 |
| C5 | 导出 / 导入：多选导出 JSON → 导入前**脱敏预览**（只显示字段与「是否有 token」）→ 勾选导入；按账号去重覆盖；**只有确认属于该区域**的记录才入库，认不出域名的跳过并计数 |
| C6 | 每行「测试」「删除」：删除只删插件自己那份并**暂时隐藏**（点「重新检测账号」可找回），**不动 App 登录** |
| C7 | 安全：每区域一个随机端口 loopback shim + 进程内随机 secret，**真实 token 不交给 pi-ai** |
| C8 | 已知短板（写进 README 的诚实项）：vault 存**明文 token**；Windows 上 `mode 0600` 不生效，改用 `icacls` 收敛 DACL，`doctor` 回读 `protected/exposed/unverified` |

### 1.3 同作者其它池实现（同一套语义的变体）

| 插件 | 池差异 | 值得抄的独有设计 |
|---|---|---|
| `dsh-connect-trae@4.18.0`（217 ★） | 三面板各一池（CN / 企业 / 国际），「真实请求失败换下一个，**最多 3 个**」 | 导入导出格式与 workbuddy **互通**；企业版「不回落」——被拒就如实报错，不偷偷改用个人额度 |
| `@dmh2002/dsh-connect-qoder@1.23.0`（52 ★，dl 13,813） | **PAT 多账号池** + 每日签到 + 自动换号 | 区分「这个账号领了」和「这台设备领过了」；签到回 `9095` 立刻停整批 |
| `dsh-workbuddy-account-care@0.0.9` | 无池，是**刹车片**：上游客户端版本 ≠ 基线就停用主插件并软结束会话 | 「客户端升级即失效」这件事被当成一等公民处理；仓库在 `eeetechen/`，**不是** `dingminhua/`（后者 404） |

---

## 2. 小浣熊方向的既有实现（逐个档案）

### 2.1 `zhlcba/dsh-raccoon-connect@0.2.4` —— 事实标准，但入口已死

- 仓库 <https://github.com/zhlcba/dsh-raccoon-connect> · **1 ★** · 推送 `2026-10-30T02:45:18Z` · 1 open issue
- npm `dsh-raccoon-connect@0.2.4`（2026-10-30）· 近 30 天 **2,137** 下载 · 维护者 `zoolup`
- fork 自 <https://github.com/liudapeng0311/dsh-raccoon-work>（0 ★，推送 2026-09-18，**未发 npm**，README 为空描述）
- 内核：`>=0.2.1-rc.1 <0.2.2-0 || … || >=0.2.9-rc.1 <0.3`（逐段预发布并集，**必须照抄这种写法**，不能写 `>=0.2.1-rc.1 <0.3`）
- 结构：`lib/index.js` + `lib/client.js`(1637 行) + `lib/bin.js` + 一个被 split 出来的 `lib/version-*.js` chunk（分包教训：loader 里多一次相对路径 `import()`，路径一错整个插件起不来）

**它的资产（值得继承）**

| 做法 | 依据 |
|---|---|
| 凭据位于 `~/.box-agent/config/auth.json`（`BOX_AGENT_CONFIG_DIR` 可改） | README「令牌是怎么复用的」 |
| access token **3 小时**、refresh token **30 天**；refresh **单次使用**，新旧一起轮转 | 同上 |
| 刷新后**必须写回 App 自己的 `auth.json`**（沿用其原子写：临时文件 + rename），否则 App 下次撞 `refresh_conflict` 会被登出 | 同上——这是「只读复用」与「必须写回」的分水岭 |
| 撞 `refresh_conflict` 先重读 App 文件，拿不到才报错 | 同上 |
| `logout` 只删插件自留的副本与备份，**不动 App 登录文件** | 同上 |
| 识图按**逐模型实测**判定，不信目录 `vision` 标签（5 个模型错 2 个，两个方向都错） | README「图片输入」；`visionModelIds` / `textOnlyModelIds` 可手工纠正 |
| 首字节超时 `streamFirstByteTimeoutMs` 默认 60s，只覆盖「发出→响应头」 | CHANGELOG 0.2.4；实测首字节中位 1–2s，高峰 60s+ 无响应 |
| 推理档位探测用**哨兵值**判网关是否真在校验；小浣熊被骗过 → 结论 `non-validating`，**不给下拉** | README 专门一节 |
| 探测结论按「账号 + 目录行指纹」缓存 14 天于 `~/.dsh/.raccoon-probe.json` | 同上 |
| 单账号：`store.current()` 一个凭据 + `adoptIdentity` 切账号时清运行时 | `lib/index.js:383/423/469` |

**它的短板**：**没有账号池**（README 全文 0 处「多账号/账号池」）；凭据路径写死 `~/.box-agent`，而这条路在本机**无法验证**——本仓库 `docs/DESKTOP-CREDS.md` 实测：本机**根本没装小浣熊桌面端**（注册表三处 + 文件系统 + 进程 + 协议处理器全无命中，`installed: false`），`C:\Users\xingx\.box-agent\config\auth.json` 自然不存在。另一个仓库 `dsh-raccoon-web` 在他们装了客户端的机器上测得 profile 已迁到 `~/.office-raccoon`，并据此判定四个旧插件同时失效。**两个事实指向同一结论：`~/.box-agent` 不能作为唯一入口**，但「迁到 `~/.office-raccoon`」这一条在本机是**二手证据、待验证**（安装客户端后须自己复跑）。

### 2.2 `xiuchuan666/dsh-raccoon-web@0.1.0`（未发 npm）—— 调研最深、双通道

- 仓库 <https://github.com/xiuchuan666/dsh-raccoon-web> · **0 ★** · 推送 `2026-11-06T09:02:27Z` · `private: true`，无 npm 包
- 内核：`>=0.2.1-rc.1 <0.2.2-0 || … || >=0.2.9-rc.1 <0.3.0-0`
- 结构：`packages/dsh-raccoon-web/{src/protocol,src/provider,src/host,client.js}`，168 个单测，`docs/` 里 7 篇设计 + 9 个 ADR + 实测记录 E-001~E-035

**它的独有事实（作者实测，本机未复跑 → 按「二手证据」对待）**

| 事实 | 出处 |
|---|---|
| **凭据入口换了**：桌面端 profile 从 `~/.box-agent` 迁到 `~/.office-raccoon/agent/config/auth.json`（E-030） | README + `docs/01-research/02-prior-raccoon-plugins.md` |
| 旧四插件全死在「读一个已经不存在的文件」，不是不维护 | 同上 |
| 桌面端凭据**只读**（不写、不搬、不缓存副本），扫码兜底；用户可强制只用一条 | ADR-0008 |
| 扫码用官方桌面端 Web auth 协议：code 本地生成（13 位时间戳 + 32 hex）、`appname=小浣熊官网`、`POST /api/web/auth/v1/login_with_qrcode_code` | ADR-0009 |
| **自实现二维码编码器**（不引 `qrcode` 依赖，避免与 Electron 版本打架），byte 模式 + 纠错 M + 版本 1–10 | 设计取舍 3 |
| 思考通道走 `extra_body.thinking`，由 pi-ai 原生解析 `delta.reasoning_content` | ADR-0007 |
| **绝不替用户领每日积分**：重放 `setting_info` 能骗到发放，但那是替用户改变账号状态；只读积分与流水 | 设计取舍 5 |
| 限流是按**账号 token 吞吐**算的，撞到后额度缓慢回血，上游不给恢复时间 | 「风险与边界」 |
| 实测：`login.source:"desktop"`、6 模型、余额 11682、首字节 1637ms | README 状态表 |

**短板**：单账号（凭据或扫码二选一，不是池）；扫码登录状态还停在「二维码已下发、待人工确认一次」；识图探测 🟡 待真实请求。

### 2.3 `uia040808-design/dsh-connect-sensetime` —— 面板 + OpenAI 兼容端点

- 仓库 <https://github.com/uia040808-design/dsh-connect-sensetime> · **0 ★** · 推送 `2026-11-08T10:40:18Z`
- 包名 `@local/dsh-raccoon@0.1.0`（**private，不发布 npm**），安装方式 `dsh plugin add github:…`
- 内核：**未声明 peerDependencies**；README 写「在 0.2.2-rc.1 上开发」
- 结构：`index.js` + `client.js`(36 KB) + `cordis.patch.yml` + `locale/{zh,en}.json` + `tools/asar.mjs`

**独有设计**：不做 provider 适配，而是**暴露一个 OpenAI 兼容端点**（`/raccoon/v1/models`、`/raccoon/v1/chat/completions`、SSE + `tools` 透传、vision `image_url` base64），并额外在 **`127.0.0.1:8787` 起固定端口代理**——因为桌面版 DSH 每次启动都换 Web 端口，Base URL 会失效。用户走 DSH「自定义模型 API」接入。

- 凭据：`%USERPROFILE%\.box-agent\config\auth.json` **只读**；本地 API Key 落在 `$DSH_HOME/raccoon-connect/secret.json`（`rcc_` 前缀，首次生成）
- UI：`sidebar.panellist` + `main` 面板 + `conversation.input.right` 积分胶囊
- **它自己承认的关键限制**：「小浣熊下发的 IAM token **没有 refresh 授权**，过期后需要打开客户端重新登录」——与 2.1 的「refresh token 30 天 + 必须写回」是两条不同的凭据世代，实现前必须实测择一
- **没有账号池**；README 0 处「多账号」

### 2.4 `lin2670/magpie-plugins` → `packages/raccoon-auth` —— 协议最干净的参考

- 仓库 <https://github.com/lin2670/magpie-plugins> · **1 ★** · 推送 `2026-11-01T09:15:59Z`
- npm `magpie-raccoon-auth@0.3.2`（2026-10-26）· 近 30 天 **1,114** 下载 · 维护者 `an0119`
- **不是 DSH 插件**：magpie 框架插件，单文件 `index.mjs`（721 行），无 peerDependencies
- 移植自 `aimod-cc/agent2api`（只取逻辑，按 magpie 规范重写）；同仓另有 catpaw / loomy / autoclaw-cn

**它的价值与坑**

| 项 | 事实 |
|---|---|
| 多账号 | **框架层支持**：agent2api / magpie 的 accounts 表按 `provider` 取 `enabled=1` 的行，`fresh()` 取「有活 token 的那个」并就地续期。这是**一个活跃账号 + 多份库**，不是池轮转 |
| 签到 | **真实现**：`GET /api/web/office/v3/setting_info`（带 `X-Client-Platform: desktop-windows` / `X-Client-Version` / `X-Raccoon-Language`）触发按天幂等发放 → 再读 `points/v1/bills` 核对当天 `daily_grant` 是否到账 |
| 新手奖励 | 两个一次性 grant：`/api/web/desktop/v1/login/points/grant`、`/api/web/mobile/v1/login/points/grant`，落在 `onboardingGrants` 账本里，`granted:false` 也算已结算 |
| 登录 | 三条：从 agent2api 导入（Bun 宿主读 `bun:sqlite`）、手机验证码、手动粘贴 |
| 识图 | 目录 `tags` 含 `vision`/`image`/`image-understanding` → `modalities.input: ['text','image']`（**信标签，不实测**） |
| 模型 | 未知模型**不报错，静默回落默认模型并回 200** —— 调用方必须本地校验模型名 |

> 现成却被打断的一条线：`Ckarefulon/dsh-providers-hub-enhance` 把「raccoon 没有签到端点」判为**漏查**，指出触发器在**办公端** `GET /api/web/office/v3/setting_info`，并且旧实现用 `/points/v1/bills`（混着消耗记录）判断登录奖励会被挤出窗口，应改走 `/points/v2/bills?type=income`。这条纠错对我们是净收益。

### 2.5 `k1-h2/dsh-llm-adapters@1.2.7` —— 协议逆向最全，网页扫码

- 仓库 <https://github.com/k1-h2/dsh-llm-adapters> · **2 ★** · 推送 `2026-11-08T12:37:05Z`
- npm 1.2.7（2026-11-08）· 近 30 天 **1,546** 下载 · 维护者 `watercat`
- 内核：`@deepseek-ai/dsh-llm ^0.1.7-rc.1 || ^0.2.0-rc.1`
- 一个包塞四个 provider：Loomy / 小浣熊 / Trae / CodeArts（`lib/index.js` 9,046 行 + `client.js` 1,802 行）

**小浣熊相关事实**

| 项 | 事实 |
|---|---|
| 凭据来源 | **网页微信扫码**（宿主起本地登录页，二维码由官方服务端一次性签发），**不依赖桌面端**；token 存插件自己的 `accounts.json`，`RaccoonAccountRecord` 只有 `accessToken / phone / name / ownerType / loginAt` |
| 多账号 | **单账号**：`store.raccoon()` 一个 `raccoon?:` 字段，`saveRaccoon` 覆盖写 |
| 签到 | **只检测不领取**：读 `points/v2/bills` 里今天 `biz_type === 'daily_grant'` 的记录，按钮叫「检测今日积分」；另给「打开网页签到」链接（`https://xiaohuanxiong.com/work/home`）。理由：积分由服务端在当天首次打开网页时发放，重放 `setting_info` 是副作用 |
| 积分 | `GET /points/v1/balance` → `available_points` / `reward_points` / `daily_points` |
| 识图 | 能力解析顺序：**OpenRouter 实时表 > 上游声明（`input_modalities`/`vision`/tags）> 两者都没有则两种模态全开**；另有 `raccoonVisionModelIds` / `raccoonTextOnlyModelIds` 手改（`textOnly` 优先级最高） |
| 思考 | `extra_body.thinking` + `reasoning_effort`，自己写的 `openAiStream()` 才能塞任意字段 |
| 限流 | `isRaccoonRateLimited`：429 或正文含 `user_model_rate_limited`/`rate_limit`/`频率超限`；**200 的 SSE 流里也会有 error frame** |
| 会话 id | `sess-0-<sha256(principal+"\0"+model)[:8]>` 稳定化（官方客户端 26 分钟 125 次调用用同一个 `sess-0-53927d74`） |
| 登录校验 | 只认 `GET /llm/v2/model_catalog` 返回 `data.categories` 是数组；`iam/confirm` 失败不致命 |
| 扫码轮询 | `NETWORK_ERROR`/`TIMEOUT` 继续 `pending`；只有 `AUTH_QRCODE_EXPIRED`/`NOT_FOUND` 判过期；每次轮询按新 `expires_in` 重置 deadline |

### 2.6 渠道包式聚合插件（把 raccoon 当十几家渠道之一）

| 插件 | raccoon 能力 | 账号池 | 与我们的关系 |
|---|---|---|---|
| `hulibuld/dsh-get-it-for-free@3.0.9`（6 ★，推送 2026-11-10，dl 3,211；仓库 package 已 3.0.23 未发布） | 浏览器授权登录；**每天可领 300 积分**（先查当天账单，没有就模拟网页端请求头打几条只读办公接口，再看账单确认到账）+ 一次性桌面端首登 3,000 | 有（按渠道）；多个腾讯账号「各算各的，请求在它们之间轮流走」 | 签到实现的事实参考；它把「签到」做成**有副作用但幂等**的动作 |
| `Stopning/dsh-free-model@3.0.1`（0 ★，fork `Ebony-Vinyl/dsh-our-free-model`，推送 2026-10-31，dl 2,484；仓库分支包 0.5.2） | 十五张渠道卡，raccoon 走 vendored `channel-pack` | 有（渠道包通用池） | 证明「多账号池」在这一层是**渠道包能力**，不是 raccoon 专属设计 |
| `Alex663028/dsh-credit-hub@0.2.2`（0 ★，推送 2026-11-10；**npm 404 未发布**） | vendored channel-pack：登录、账号池、积分领取；模型以 `pk/<provider>/<model>` 桥接进汇通目录；本地 8330 网关 + 降级链（fallback / round-robin） | 有 | 同样是渠道包池；`accountPack: auto` 检测到已装同源包会跳过，避免双份注册与双重签到——**双装互踩是真实存在的坑** |
| `anye-99/dsh-codearts-auth@2.21.261109` / npm `dsh-providers-hub@2.20.261109`（18 ★，仓库与 gitee `iJetLi/deepseek-harness-codearts` 同源；npm 两个名字，dl 5,865 / 9,495） | `raccoon` 是第 9 个 provider，**零客户端依赖**（不读 `%APPDATA%\office-raccoon`、不读 `~/.box-agent`、不碰 leveldb）；能力矩阵 `{balance:true, onboardingTasks:true}`，**故意不登记 `dailyCheckin`** | 有（CodeArts 侧「只支持账号池」） | **「零客户端依赖」是可选的架构分叉**：单靠扫码也能跑，代价是拿不到桌面端的 refresh 轮转 |
| `Ckarefulon/dsh-providers-hub-enhance@1.2.1`（0 ★，推送 2026-11-09；npm 404） | **给 `dsh-providers-hub` 的 `node_modules` 打补丁**：加 Raccoon 每日签到 + 手机端首登 3,000 + 限流中断「解禁后自动继续」 | 复用上游池 | 生命周期 = 上游下一次发版。**我们不要走这条路**，但它纠正的两条协议事实要收下 |

### 2.7 邻域参考：`dsh-connect-sensenova-token-plan@0.8.7`（另一条商汤通道）

- 仓库 <https://github.com/eghrhegpe/dsh-connect-sensenova-token-plan> · **8 ★** · 推送 `2026-11-05T18:53:09Z` · npm 0.8.7（2026-11-06）· dl **4,443** · 内核 `>=0.1.5 <0.3`
- 三个 tab：**积分额度**（商汤 Token Plan，账号密码登录 + 令牌自动续期）、**接入 API**（`sk-` Key → OpenAI 兼容 provider + `sensenova_draw_image` 工具）、**小浣熊**（微信扫码 `xiaohuanxiong.com`，默认关）

**与「小浣熊桌面端凭据」的区别（必须讲清，否则会写出两套互相打架的 token 语义）**

| 维度 | Token Plan 通道 | 小浣熊桌面端凭据通道 |
|---|---|---|
| 账号体系 | 商汤控制台账号（账号密码 + 手机绑定） | 小浣熊 App 登录态（`auth.json` 里一对 access/refresh） |
| 计费 | **Token Plan 套餐额度**（5 小时 / 每周滚动窗口）+ 返赠余额 | 小浣熊**积分**（`available_points` 等五个钱包字段） |
| 模型 id | 商汤模型名 + `sn-` 前缀（本插件侧） | 网关目录名（`sn-glm-5-3` 等），倍率由上游声明 |
| 凭据寿命 | 令牌自动续期，用户无需介入 | access ≈ 3 小时（JWT `exp`，本机已实测）、refresh ≈ 30 天且**单次使用轮换** |
| 依赖 | 不依赖任何客户端 | 依赖客户端曾登录过；**且必须处理写回**，否则 App 会被 `refresh_conflict` 登出 |
| 上文 | 额度池可算百分比（有窗口上限） | 网关未声明积分上限，只能给绝对值 |

> 该插件内建的小浣熊实现被 `dsh-raccoon-web` 点评了两个缺陷：请求头缺 `x-client-platform` / `x-client-version`（另一实现 `dsh-llm-adapters` 是带的），以及 `reasoning: false` 直接放弃思考通道。**两条都要在我们这边修正并实测。**

---

## 3. 生态侧写：多账号池的既有形态与共同坑

### 3.1 三种形态

| 形态 | 代表 | 池从哪儿来 | 换号粒度 |
|---|---|---|---|
| **A. 自动发现快照** | `dsh-connect-trae-models@0.1.6`（扫 4 edition × 3 平台 + CLI home）、`dsh-connect-workbuddy-models@0.1.4`（`CodeBuddyExtension\Data\Public\auth\` 两处都探，`*.info` 历史快照每个都能解析成一个账号） | 客户端留下的历史登录文件 | 同一请求内换号重试（`shim` 层），429 不以「对话失败」到达用户 |
| **B. 显式池 + 显式勾选** | `dsh-connect-workbuddy`、`dsh-connect-trae`、`@dmh2002/dsh-connect-qoder`、`dsh-codearts-auth` | 客户端凭据 + 扫码/网页/粘贴导入 | 请求级：排序选号 + 失败依次换 |
| **C. 渠道包池** | `dsh-free-model`、`dsh-credit-hub`、`dsh-providers-hub` | vendored channel-pack 自己管 | 渠道内轮转 |

`trae-models` / `workbuddy-models` 的**五种派活策略**是形态 A 里最成熟的一组：`优先 / 轮换 / 均衡（按闲置时长加权）/ 粘性（保 prompt 缓存）/ 到期优先`。其中「**粘性**」的理由值得抄进我们的设计考虑：**上游 prompt 缓存按账号隔离，对话中途换号会整段作废**。

### 3.2 共同坑（每条都在这批仓库里真实出现过）

| # | 坑 | 实证 |
|---|---|---|
| K1 | **凭据写回** | `dsh-raccoon-connect`：不写回 → App 下次拿旧 refresh 换 → `refresh_conflict` → 用户被登出。而 `dsh-connect-workbuddy` / `dsh-connect-trae` 反着来：**桌面端文件只读，自己刷新只写自己的 vault**（因为那些客户端不是单次使用轮转）。**小浣熊属于前者**，不能照抄 WorkBuddy 的只读策略 |
| K2 | **刷新单次使用** | 小浣熊 `POST /api{,/electron}/auth/v1/refresh` 的 `refresh_token` **每刷必换**，响应里的新值必须落盘；落盘失败要在日志里点名（新票只在内存里，重启需重登）。`magpie`、`misakano` 都点名了这条 |
| K3 | **400 不换号** | 三个 WorkBuddy 系实现口径一致：请求本身不合法（400）换谁都 400；流中途断开也不重试 |
| K4 | **区域隔离** | WorkBuddy 国内/国际按凭据域名分流，两套运行时共用一个进程；Trae CN/企业/国际三 tab 各一池；导入时认不出区域就跳过。小浣熊若将来扩到企业版（`X-Org-Code`），池必须按区域/组织隔离，否则会「拿 A 组织的积分为 B 组织扣费」 |
| K5 | **积分只在有新鲜读数时参与排序** | 否则一页对话变成 N 次额外请求（workbuddy 的 10 分钟窗口、5 档刷新间隔 1/5/10/30/60 分钟都是为这件事让步） |
| K6 | **空的池不许退化成全量** | 唯一会花掉「没授权过的积分」的解读 |
| K7 | **设备级 vs 账号级签到** | Trae：`9295`/`9095` 一类回码说明「这台机器今天用掉了名额」；把设备级当成账号级写会误报「今日已签」。小浣熊的每日 300 是**服务端按天自动发**，只有「检测」没有「领取」，所以这条在我们这里变形为：**别为了签到去重放 `setting_info`** |
| K8 | **补丁器不可持续** | `dsh-providers-hub-enhance` 明说「只改本机 node_modules 构建产物」；`dsh-raccoon-checkin` 同类。上游一发版就碎 |
| K9 | **双装互踩** | `credit-hub` 检测到同源渠道包已装就跳过，否则双份注册 + 双重签到 |
| K10 | **客户端升级即失效** | `dsh-raccoon-web` 报告小浣熊把 profile 从 `~/.box-agent` 迁到 `~/.office-raccoon`，据此判定四个旧插件同时失效（该报告来自装了客户端的机器；本机未装客户端，**无法复跑**，见 `docs/DESKTOP-CREDS.md` §3）。WorkBuddy 系则专门做了 `account-care` 这种刹车片来兜这件事 |
| K11 | **桌面端凭据可能被加密** | WorkBuddy 新版把 `accessToken`/`refreshToken`/`nickname` 改成 `{"$wbEncrypted":1,"envelope":…}` AES-256-GCM，插件要靠 `ELECTRON_RUN_AS_NODE` 问 App 自己的原生绑定取密钥。小浣熊目前是明文，但**结构要先按「可能加信封」设计**（本地 `tools/probe-desktop-creds.mjs` 已经在查这一点） |

---

## 4. 能力对照表

> 一行一个插件。「账号池/自动换号」列是本表的核心分歧点。
> `—` = 该插件不涉及此项；`无` = 涉及但未实现；`未取到` = 拿不到事实（附录给 URL 与状态码）。

| 仓库 / npm | 版本 | DSH 内核范围 | 凭据来源 | 多账号 | 账号池 / 自动换号 | 签到 | 积分读数 | 模型目录来源 | 识图判定 | 浏览器半边 UI | 维护状态 | 我们该复用 / 该避开 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `dingminhua/dsh-connect-workbuddy`<br>npm 同名 | 5.21.3 | `>=0.1.7-rc.1 <0.3.0-0` | 桌面端文件（只读）+ 扫码 / 网页登录 | 有 | **有**（显式勾选池，开启即换号，5 键全序排序） | 有（勾选批量 + 每日自动，默认关） | 有（卡片 + 输入框胶囊，只读） | 上游 `/v3/config`（App 身份读，CLI 身份是子集） | 核验表两档证据（厂商文档 / 目录自述），未核实的**不猜** | 有（卡三栏 + 输入框面板 + 侧栏） | 活跃（1,385 ★，2026-11-09） | **复用**池的全部语义 P1–P10、C1–C8；**避开**其「桌面端只读」，小浣熊必须写回 |
| `dingminhua/dsh-connect-trae`<br>npm 同名 | 4.18.0 | `>=0.1.7-rc.1 <0.3.0-0` | 桌面端文件（多 edition）+ 自建 UWP | 有 | **有**（三面板各一池，最多换 3 个） | 有（逐账号，区分账号级/设备级） | 有（Work/通用积分、企业租户额度） | 上游实时目录 | 跟随上游 `multimodal` 标注（`false`/未标 → 纯文本，可手改） | 有 | 活跃（217 ★，2026-11-09） | **复用**「账号级 vs 设备级」签到口径、导入导出互通格式；**避开**「不回落」式的企业池混用 |
| `dingminhua/dsh-connect-qoder`<br>npm `@dmh2002/dsh-connect-qoder` | 1.23.0 | `>=0.1.7-rc.1 <0.2.0-0 \|\| >=0.2.0-rc.1 <0.3.0-0 \|\| >=0.2.1-rc.1 <0.3.0-0 \|\| >=0.2.2-rc.1 <0.3.0-0` | **PAT 手填** + 网页/设备登录 | 有 | **有**（PAT 池 + 自动换号） | 有（每日，10:00 +08 刷新） | 有 | 上游目录 | 未取到 | 有 | 活跃（52 ★，dl 13,813） | **复用**它的识图口径：上游 `is_vl` 是**平台声明**、几乎全 `true`，不能当能力答案 → 只认按精确 model id 键控的核对表，未核实一律不预勾；**避开**把「池」做成 PAT 单源（我们要桌面端 + 网页混池） |
| `hdhgsysh/dsh-connect-qoder`<br>npm `dsh-connect-qoder` | 0.2.0 | `0.1.0-rc.6 \|\| 0.1.2-rc.1 \|\| >=0.1.5-0 <0.2.0-0 \|\| 0.1.6-alpha.1/2` | 桌面端 OSCrypt 凭据（只读）/ 设备登录 / PAT，三源优先级降级 | 无 | 无 | 有（只读状态） | 有（胶囊） | 上游目录 | README 未提及（未取到源码断言） | 有 | 停更风险（23 ★，2026-11-04；内核只到 0.1.x） | **复用**「三源择一可用的降级链」（本条正是我们双通道的雏形）；**避开**把内核范围钉死在 0.1.x |
| `zhlcba/dsh-raccoon-connect`<br>npm 同名 | 0.2.4 | `>=0.2.1-rc.1 <0.2.2-0 \|\| … \|\| >=0.2.9-rc.1 <0.3` | 桌面端 `~/.box-agent/config/auth.json`（**必须写回**） | 无 | **无** | 无 | 有（只读 + 流水） | 实时 → 已保存 → 内置兜底（三级） | **逐模型实测** + `visionModelIds`/`textOnlyModelIds` 覆盖 | 有（`lib/client.js` 1,637 行，设置卡 + 输入框「检测」） | 活跃但入口已死（1 ★，2026-10-30，dl 2,137） | **复用**令牌轮转写回、首字节超时、哨兵探测、预发布并集写法；**避开**已废弃的 `~/.box-agent` 路径 |
| `liudapeng0311/dsh-raccoon-work`<br>（无 npm 包） | 0.1.2 基线 | `0.1.5-rc.1` | 同 2.1 | 无 | 无 | 无 | 有 | 同上 | 同上 | 有 | 停更（0 ★，2026-09-18） | 上游血统来源；只在读 CHANGELOG 时用 |
| `xiuchuan666/dsh-raccoon-web`<br>（npm 未发布，`private`） | 0.1.0 | `>=0.2.1-rc.1 … <0.3.0-0` | **桌面端 `~/.office-raccoon/…/auth.json` 只读** + 扫码兜底（Web auth 协议） | 无 | **无** | 无（**明确拒绝**代领） | 有 | 上游目录（6 模型实测） | 3×3 纯红 PNG 探测（🟡 待真实请求） | 有（`client.js` 51 KB） | 活跃开发中（0 ★，2026-11-06） | **复用**新凭据路径、`extra_body.thinking`、自实现 QR、168 测试的组织方式；**避开**单账号设定 |
| `uia040808-design/dsh-connect-sensetime`<br>`@local/dsh-raccoon` | 0.1.0（private） | **未声明 peer**（README：0.2.2-rc.1 上开发） | 桌面端 `~/.box-agent` **只读** | 无 | **无** | 无 | 有（胶囊 + 面板） | 上游目录（20s 缓存） | 按目录 `vision` 声明透传（**不实测**） | **有**（侧栏 + 面板 + 胶囊 + 固定端口 8787 代理） | 活跃（0 ★，2026-11-08） | **复用**「固定端口 OpenAI 兼容端点」这条路（DSH 端口每次变）；**避开**依赖 IAM token 且无 refresh 的单源设定 |
| `lin2670/magpie-plugins`<br>npm `magpie-raccoon-auth` | 0.3.2 | **非 DSH 插件**（无 peer） | 网页/手机验证码 / 手动粘贴 / 从 agent2api 导入 | 有（框架层多账号） | 无（取「有活 token 的那个」） | **有（真实现）** | 有 | 上游 `model_catalog` | 目录 `tags` 含 `vision` → 多模态（信标签） | 无 | 活跃（1 ★，2026-11-01，dl 1,114） | **复用**签到三步（`setting_info` 触发 → bills 核对 → onboarding 账本）、未知模型静默回落必须本地校验；**避开**信标签判识图 |
| `k1-h2/dsh-llm-adapters`<br>npm 同名 | 1.2.7 | `^0.1.7-rc.1 \|\| ^0.2.0-rc.1` | **网页微信扫码**（宿主本地登录页） | 无（raccoon 只存一个 record） | **无** | **只检测不领取** | 有（`available_points` / `reward` / `daily`） | 上游 catalog + OpenRouter 实时表 | OpenRouter 表 > 上游声明 > 全开；`raccoonVisionModelIds` 手改 | 有（`client.js` 92 KB，四套设置页） | 活跃（2 ★，2026-11-08，dl 1,546） | **复用**扫码轮询容错、稳定 sess id、限流分类（含 200 流内 error frame）、请求头 `x-client-platform/version`；**避开** 9K 行单文件 |
| `hulibuld/dsh-get-it-for-free`<br>npm 同名 | 3.0.9（仓库 3.0.23） | `^0.1.2-rc.1 \|\| ^0.1.7-rc.2 \|\| ^0.2.0-rc.1` | 浏览器授权（各渠道） | 有 | 有（按渠道） | **有（raccoon 真能领 300/天 + 首登 3,000）** | 有 | 渠道实时目录（每天 12:00 强制重拉） | 未涉及 | 有（账号看板一页） | 活跃（6 ★，2026-11-10，dl 3,211） | **复用**「查账单 → 补打办公接口 → 再查账单确认」的领分序列；**避开**没有区域/账号隔离的粗放轮转 |
| `Stopning/dsh-free-model`<br>npm 同名 | 3.0.1（分支包 0.5.2） | `^0.1.2-rc.1 \|\| ^0.1.7-rc.2 \|\| ^0.2.0-rc.1` | 浏览器授权（15 渠道） | 有 | 有（vendored channel-pack） | 有（渠道包） | 有 | 渠道目录 | 未涉及 | 有 | fork 活跃（0 ★，2026-10-31，dl 2,484） | 说明「池」在这一层是渠道包通用能力；**避开**把 raccoon 当十几个渠道之一（拿不到桌面端 refresh 轮转） |
| `Alex663028/dsh-credit-hub`<br>（npm 404 未发布） | 0.2.2 | `^0.1.2-rc.1 \|\| ^0.1.7-rc.2 \|\| ^0.2.0-rc.1`（optional） | 设备流登录 / Token 导入 / vendored channel-pack | 有 | 有（渠道包） | 有 | 有 | 渠道目录桥接为 `pk/<provider>/<model>` | 未涉及 | 有 | 活跃（0 ★，2026-11-10） | **复用**「装到同源包就跳过」的去重思路；**避开** 8,330 网关这种第二进程形态 |
| `anye-99/dsh-codearts-auth` / `dsh-providers-hub`<br>npm 两个名字同源 | 2.21.261109 / 2.20.261109 | `^0.1.2-rc.1 \|\| ^0.1.7-rc.2 \|\| ^0.2.0-rc.1 \|\| ^0.2.1-rc.2` | 各渠道自登（raccoon 走扫码/短信） | 有 | 有（CodeArts 侧「只支持账号池」） | raccoon **故意不登记**（无端点） | 有（`balance` + `onboardingTasks`） | 上游目录 + 倍率 | 未涉及 | 有 | 活跃（18 ★，npm dl 5,865 / 9,495） | **复用**「零客户端依赖」作为对照分叉、`raccoon-tools` e2e 判据（响应里要有结构化 `tool_calls`）；**避开**只做扫码把桌面端 token 轮转丢掉 |
| `Ckarefulon/dsh-providers-hub-enhance`<br>（npm 404） | 1.2.1 | 无 peer（补丁器） | 继承宿主插件 | — | 复用上游池 | **补出来的签到**（办公端 `setting_info`） | 复用上游 | 复用上游 | 未涉及 | 有（报错行图标按钮） | 活跃（0 ★，2026-11-09） | **复用**它纠正的两条协议事实与「限流解禁后继续」的等待语义；**避开**改 `node_modules` 的做法 |
| `eghrhegpe/dsh-connect-sensenova-token-plan`<br>npm 同名 | 0.8.7 | `>=0.1.5 <0.3` | 控制台账号密码（Token Plan）+ 微信扫码（内建浣熊） | 无 | 无 | 无（只读额度） | 有（两档：商汤窗口 / 浣熊积分） | `/v1/models` + 商汤目录 | `output_modalities` 结构化判定 | 有（三 tab + 输入框胶囊） | 活跃（8 ★，2026-11-06，dl 4,443） | **复用**两档读数归口、429 自愈；**避开**其浣熊实现缺 `x-client-*` 头与放弃思考通道两点 |
| `DragonHorizon-xtihc/dsh-connect-trae-models`<br>npm 同名 | 0.1.6 | `>=0.1.7-rc.1 <0.3.0-0` | 自动发现本机登录快照（4 edition × 3 平台 + CLI home） | 有 | **有**（5 种派活策略 + 手动钉号） | 有（手动 + 自动，北京时间小时表） | 有（积分包到期四态） | 上游实时名册 + 静态回退 | README 未提及（未取到源码断言） | 有（输入框积分面板） | 活跃（1 ★，2026-11-04，dl 2,209） | **复用**五策略（尤其「粘性 = 保 prompt 缓存」）、「重新检测账号」的发现式入池；**避开**把钉号与容错对立起来 |
| `DragonHorizon-xtihc/dsh-connect-workbuddy-models`<br>npm 同名 | 0.1.4 | `>=0.1.7-rc.1 <0.3.0-0` | 自动发现 `*.info` 历史快照（两处路径都探） | 有 | **有**（`rankAccounts` 7 键全序，默认 `expiry`） | 有（手动 + 自动，幂等） | 有（总额 + 逐包到期） | 上游实时目录 | README 未提及（未取到源码断言） | 有（输入框下方切换账号） | 活跃（4 ★，2026-11-05，dl 1,560） | **复用**「读不出的文件要列出来并说明原因（encrypted/unreadable/malformed），不要悄悄少几个账号」；**避开**默认策略选 `priority`（会让积分多的号先被抽干） |
| `misakano7545/xiaohuanxiong2api-panel`<br>（Go，非 DSH） | — | — | 导入账号 JSON / 仅 access / `office-raccoon://auth/callback` 授权链接 | **有** | **有**（账号池轮转、软冷却、熔断降权、闲置补偿、`schedule.checkin_hours`） | 有（`/desktop/v1/login/points/grant` 幂等 + bills 判定） | 有 | 上游 `model_catalog`（`visible:false` 不展示但可调） | 未涉及 | **有**（内嵌 Web 面板 `auths/<uid>.json`） | 活跃（3 ★，2026-11-01） | **最重要的一条先例**：「401 先续期同号再重试一次，429 软冷却，5xx 熔断换号，其余 4xx 不换号」——**这正是小浣熊版池的错分口径** |
| `xxhhlk/raccoon2api`<br>（文档仓，非插件） | — | — | 只收录端点/鉴权/请求响应结构 | — | — | 说明「无签到端点、每日 300 由服务端发」 | 端点与字段 | 端点清单 + 模型表快照 | 目录 `vision` 标签 | 无 | 2026-10-04（2 ★） | **复用**端点表与错误信封（LiteLLM 风格 `code:200001/200003`）、「未知模型静默回落」警告；注意它写的是 `~/.box-agent`，**已过期** |
| `dushaobindoudou/dsh-plugin`<br>npm `dsh-raccoon` | 0.0.1 | 无 | — | — | — | — | — | — | — | — | **占位包，无实现**（2 ★，2026-11-01） | 仅用于避免误以为「这个包能用」 |

**表读法**：`多账号` 指「能同时保存并区分多个账号」；`账号池` 指「由插件决定每次请求用谁 + 失败自动换」。二者不是一回事——`magpie`/`llm-adapters` 有多账号库但没有池。

---

## 5. 空白与切入点

### 5.1 空白：DSH 原生小浣熊 provider **没有任何一个**带账号池

证据（可复核）：

1. 全部 4 个 DSH 原生小浣熊 provider 的源码/README 里，「多账号」「账号池」命中数 = **0**：
   - `dsh-raccoon-connect@0.2.4`：`store.current()` 单凭据 + `adoptIdentity()` 切账号即清运行时（`lib/index.js:383/423/469`）
   - `dsh-raccoon-web@0.1.0`：单凭据（桌面端）或单凭据（扫码），README 0 处
   - `dsh-connect-sensetime@0.1.0`：单 `auth.json`，README 0 处
   - `dsh-llm-adapters@1.2.7`：`RaccoonAccountRecord` 单字段 `raccoon?:`，`saveRaccoon()` 覆盖写（`src/account-store.ts:116/280`）
2. 唯一带「多账号 + 池」的小浣熊实现是 **Go 网关** `misakano7545/xiaohuanxiong2api-panel`（3 ★）与**渠道包**（`dsh-free-model` / `dsh-credit-hub` / `dsh-providers-hub`），**都不是 DSH 原生 provider**。
3. 「桌面端凭据」与「网页/扫码」在现有实现里始终是**二选一或兜底**（`dsh-raccoon-web` 明写「首选桌面端，扫码兜底」），**从未作为池里的两类成员并存**。

### 5.2 三条差异化建议

**① 双通道混池：桌面端凭据成员 + 网页扫码成员，同池同排序（生态里没有先例）**

- 每个池成员的凭据带 `source: 'desktop' | 'web'`：
  - `desktop` 成员参与 refresh 轮转 → **必须写回 App 的 `auth.json`**（沿用其原子写；写前在 `$DSH_HOME` 留备份），因此这类成员要**串行化刷新**（单次使用语义，两个成员同时刷同一个文件会互相顶掉）
  - `web` 成员是插件自有 token（扫码得来），失效只能重登
- 排序键对两类一视同仁，但**同 `accountId` 的桌面端成员优先**（它能自动续期，网页 token 过期就得人工）。
- 恰好 `@dmh2002/dsh-connect-qoder` 已经证明「PAT 与 OAuth 混在同一池」可行；`hdhgsysh/dsh-connect-qoder` 的三源降级链是这条路线的雏形 —— 但两者都还是**单活跃账号**，做成池是新的。

**② 换号判定用「账号态 vs 请求态」的硬口径，并补上「401 先续期再换号」这一格**

本仓库 `docs/ARCHITECTURE.md` ADR-6 已定下四类可换 / 三类不可换，与生态口径一致；生态里**多出来的一格**是 401 的处理顺序：

| 状态 | workbuddy / trae / qoder | `xiaohuanxiong2api-panel`（Go） | 建议 |
|---|---|---|---|
| 401 凭据失效 | 直接换号 | **先同号续期一次**再重试，仍 401 才换号 | 采纳后者。小浣熊的 refresh 是单次轮转、access 3 小时就死，直接换号等于白白把一个「只是 token 过期」的号打进出池名单；这也是 ADR-2「临期先刷新」的自然延伸 |

其余各条已有共识，照抄即可：

- 429 / `user_model_rate_limited` / `频率超限` → 软冷却 + 换号；**200 的 SSE 流里也会有 `{"error":…}` 帧，它算失败**
- 402 / 积分耗尽 → 换号，按日包 / 月包刷新时间回池
- 5xx / 网络 / 首字节超时 → 换号，只算「暂时出池」（30 分钟兜底，不编倒计时）
- **400 不换号**；**已开始吐字节后不换号**（ADR-6）；**未知模型不换号**——网关会静默回落默认模型并回 200，本地必须先校验模型名
- 每次换号写一行 `warn`：因何失败、换到谁

**③ 「客户端 + 网页都能选」做成同一张表的两列，而不是两套设置页**

用户原话要的是「客户端和网页都能选择」。现有实现把它理解成「登录方式二选一」；我们的理解应当是：

- **一个池表格**，每行 = 一个账号，列里显式给出 `来源`（`desktop` / `web` / `qr` / `import`）、`剩余积分`、`凭据到期`、`最近失败原因与解禁时刻`、`是否在池`；
- **勾选即授权**（P1），空池拒绝批量动作；
- 凭据库按本仓库已定的 `$DSH_HOME/raccoon-vault/accounts/<id>.json`（见 `docs/ARCHITECTURE.md` ADR-1 / `docs/CONTRACT.md` 的 `accounts[]`），每条带 `source` 字段区分来源；**桌面端那份是「插件自留副本」**，App 的文件只读一次、只写回轮转结果（ADR-1 已承认代价：客户端里那一个账号只贡献一个成员，第二、第三个账号必须走网页/扫码）；
- 若将来扩到企业版 / 多区域，再在 vault 下加 `<region>` 一层（WorkBuddy 的做法），现在不加——**没有第二区域就拆目录只是给自己制造迁移**；
- **导入导出**按 WorkBuddy 的格式做（脱敏预览 → 勾选导入 → 按账号去重 → 认不出的区域跳过并计数），并留好与他们互通的可能。

### 5.3 必须避开的三件事

1. **改别人的 `node_modules`**（`dsh-providers-hub-enhance` / `dsh-raccoon-checkin` 路线）：生命周期 = 上游下一次发版。
2. **为了签到去重放 `setting_info`**：`dsh-raccoon-web` 与 `dsh-llm-adapters` 各自独立地把这条判为「替用户改变账号状态」。要么做「检测」（读 bills 里今天的 `daily_grant`），要么做「显式按钮 + 幂等且先查后写」（`magpie` / `get-it-for-free` 路线），**默认关闭**。
3. **照抄 WorkBuddy 的「桌面端只读」**：小浣熊的 refresh 是单次使用轮转，不写回就会让用户被客户端登出（`refresh_conflict`）。这是两条相反的正确做法，不能混。

---

## 6. 附录：取证记录

### 6.1 npm（`curl -s -m 25 https://registry.npmjs.org/<pkg>`，本机直连）

| 包 | HTTP | latest | 发布时间 | 近 30 天下载（`api.npmjs.org/downloads/point/last-month`） |
|---|---|---|---|---|
| `dsh-raccoon-connect` | 200 | 0.2.4 | 2026-10-30 | 2,137 |
| `magpie-raccoon-auth` | 200 | 0.3.2 | 2026-10-26 | 1,114 |
| `dsh-llm-adapters` | 200 | 1.2.7 | 2026-11-08 | 1,546 |
| `dsh-connect-workbuddy` | 200 | 5.21.3 | 2026-11-09 | 101,724 |
| `dsh-connect-trae` | 200 | 4.18.0 | 2026-11-09 | 25,820 |
| `@dmh2002/dsh-connect-qoder` | 200 | 1.23.0 | 2026-11-08 | 13,813 |
| `dsh-connect-qoder`（hdhgsysh） | 200 | 0.2.0 | 2026-09-19 | 406 |
| `dsh-workbuddy-account-care` | 200 | 0.0.9 | 2026-11-09 | 1,231 |
| `dsh-connect-trae-models` | 200 | 0.1.6 | 2026-11-04 | 2,209 |
| `dsh-connect-workbuddy-models` | 200 | 0.1.4 | 2026-11-05 | 1,560 |
| `dsh-connect-sensenova-token-plan` | 200 | 0.8.7 | 2026-11-06 | 4,443 |
| `dsh-get-it-for-free` | 200 | 3.0.9 | 2026-11-01 | 3,211 |
| `dsh-free-model` | 200 | 3.0.1 | 2026-11-09 | 2,484 |
| `dsh-codearts-auth` | 200 | 2.21.261109 | 2026-11-09 | 5,865 |
| `dsh-providers-hub` | 200 | 2.20.261109 | 2026-11-09 | 9,495 |
| `dsh-our-free-model` | 200 | 2.1.0 | 2026-10-19 | 47,516 |
| `dsh-raccoon` | 200 | 0.0.1 | 2026-09-11 | 23 |
| `dsh-raccoon-web` / `dsh-connect-sensetime` / `dsh-raccoon-work` / `dsh-credit-hub` / `dsh-providers-hub-enhance` / `dsh-raccoon-checkin` | **404** | — | — | — |
| `dsh-connect-raccoon` / `raccoon-dsh` / `dsh-raccoon-pool` | **404**（名字可用） | — | — | — |

### 6.2 GitHub（必须走代理 `-x http://127.0.0.1:7897`）

`GET https://api.github.com/repos/<owner>/<repo>` — 全部 200，除：

| 请求 | 状态 | 说明 |
|---|---|---|
| `dingminhua/dsh-workbuddy-account-care` | **404** | 该仓库不存在；实际在 `eeetechen/dsh-workbuddy-account-care` |
| `GET .../git/trees/<branch>?recursive=1`（8 个仓库，10:49 后） | **403** | API 限流（`API rate limit exceeded for 140.235.141.169`），改用 `raw.githubusercontent.com` 逐文件探测 |
| `xiaohuanxiong2api` 系 4 个仓库的 repo 元数据 | **403** | 同上，星数取自 `search/repositories` 结果（同一次会话内） |
| `https://gitee.com/iJetLi/deepseek-harness-codearts/raw/master/README.md` | **302**（416 字节） | 需登录，未取到 |

| 仓库 | ★ | 最后推送 |
|---|---|---|
| `dingminhua/dsh-connect-workbuddy` | 1,385 | 2026-11-09T14:32:50Z |
| `dingminhua/dsh-connect-trae` | 217 | 2026-11-09T14:33:20Z |
| `dingminhua/dsh-connect-qoder` | 52 | 2026-11-08T18:09:44Z |
| `hdhgsysh/dsh-connect-qoder` | 23 | 2026-11-04T04:38:41Z |
| `anye-99/dsh-codearts-auth` | 18 | 2026-10-13T11:16:29Z |
| `eghrhegpe/dsh-connect-sensenova-token-plan` | 8 | 2026-11-05T18:53:09Z |
| `hulibuld/dsh-get-it-for-free` | 6 | 2026-11-10T01:49:04Z |
| `DragonHorizon-xtihc/dsh-connect-workbuddy-models` | 4 | 2026-11-05T02:18:50Z |
| `misakano7545/xiaohuanxiong2api-panel` | 3 | 2026-11-01T00:27:28Z |
| `k1-h2/dsh-llm-adapters` | 2 | 2026-11-08T12:37:05Z |
| `xxhhlk/raccoon2api` | 2 | 2026-10-04T11:30:05Z |
| `dushaobindoudou/dsh-plugin`（`dsh-raccoon` 占位） | 2 | 2026-11-01T09:00:46Z |
| `lin2670/magpie-plugins` | 1 | 2026-11-01T09:15:59Z |
| `zhlcba/dsh-raccoon-connect` | 1 | 2026-10-30T02:45:18Z |
| `eeetechen/dsh-workbuddy-account-care` | 1 | 2026-11-09T09:25:17Z |
| `DragonHorizon-xtihc/dsh-connect-trae-models` | 1 | 2026-11-04T03:39:04Z |
| `xiuchuan666/dsh-raccoon-web` | 0 | 2026-11-06T09:02:27Z |
| `uia040808-design/dsh-connect-sensetime` | 0 | 2026-11-08T10:40:18Z |
| `Stopning/dsh-free-model` | 0 | 2026-10-31T09:36:19Z |
| `Alex663028/dsh-credit-hub` | 0 | 2026-11-10T01:39:51Z |
| `Ckarefulon/dsh-providers-hub-enhance` | 0 | 2026-11-09T15:41:21Z |
| `liudapeng0311/dsh-raccoon-work` | 0 | 2026-09-18T07:36:27Z |
| `haoxinyu1/xiaohuanxiong2api` | 4 | 2026-10-09T09:23:06Z（取自 search） |
| `wicm84266964/Buddy2api` | 138 | 2026-11-09T07:56:20Z（取自 search，通用网关，未细读） |

GitHub 搜索 `raccoon dsh`：`total_count = 9`（与线索一致），命中的 9 个仓库均已收录于上表。

### 6.3 本地解包原文（未联网）

| 路径 | 用途 |
|---|---|
| `X:\Agent\deepseek插件\.tmp\raccoon\dsh-raccoon-connect_0.2.4\package\` | `lib/index.js` 单凭据 store、`lib/client.js` 1,637 行、`CHANGELOG.md` |
| `...\magpie-raccoon-auth_0.3.2\package\index.mjs` | 721 行单文件：签到、onboarding、`fresh()` 续期、`tags` 判识图 |
| `...\dsh-llm-adapters_1.2.7\package\{src,client.js,FAQ.md}` | `account-store.ts`（单 `raccoon?` 字段）、`raccoon.ts`（`checkinStatus` / `dailyGrant`）、`catalog.ts`（能力解析顺序） |
| `X:\Agent\deepseek插件\dsh-connect-raccoon\tools\probe-desktop-creds.mjs` | 本仓库已有工具，已覆盖 `~/.box-agent` / `BOX_AGENT_CONFIG_DIR` / `auth.json` 原子写与写回判定的探测 |

### 6.4 写在最后的判据提醒

- 本文档里凡是「能/不能」「有/没有」的结论，都指向具体 URL 或本地文件行号。**改造实现前要自己复跑一次**：`raw.githubusercontent.com` 上的 README 会变，`~/.office-raccoon` 与 `~/.box-agent` 的存活状态是本机事实，不是文档事实。
- 上游协议口径存在**互相冲突**的记录（access token 寿命 2 小时 vs 3 小时；`~/.box-agent` 活 vs 死；有无签到端点）。冲突处本文都并列了来源，**不取平均、不二选一**——实现时按本机实测定稿，并把实测记录写进仓库。
- 本机已定的两条（见 `docs/DESKTOP-CREDS.md`，截至 2026-11-10）：`access ≈ 3h / refresh ≈ 30d 单次轮换`；`~/.box-agent` **不存在**。文中凡引用 2 小时或 `~/.box-agent` 可用的说法，均为**上游实现的历史口径**，用作对读而非结论。
