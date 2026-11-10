# DSH Connect 商汤小浣熊

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![npm](https://img.shields.io/npm/v/dsh-connect-raccoon?color=cb3837)](https://www.npmjs.com/package/dsh-connect-raccoon)
[![DSH 内核](https://img.shields.io/badge/DSH-0.2.1--rc.1%20~%200.2.x-2f6f4f.svg)](#安装与版本对应)

> 把**商汤小浣熊**（SenseTime Raccoon，[xiaohuanxiong.com](https://xiaohuanxiong.com)）接进 DeepSeek Harness：
> **有客户端就自动读**它的登录态，**没有客户端就网页授权或微信扫码**登录；
> 多个账号进一张**账号池**表格，可勾选、可切换、失败自动换号重试。
> 模型目录、积分余额、每日签到都在插件设置页里。

---

## 为什么再做一个小浣熊插件

生态里已有 4 个 DSH 原生小浣熊 provider，但它们**全部是单账号**，而且「桌面端凭据」与
「网页登录」是二选一或兜底关系。这个插件补的正是那一格：**两类来源进同一张池表、同一套排序**。
逐条取证见 [`docs/ECOSYSTEM.md`](docs/ECOSYSTEM.md)。

| 能力 | 本插件 | 生态里的小浣熊 provider |
| --- | --- | --- |
| 桌面端凭据复用 | ✅ 自动探测 + 轮转时原子写回 | ✅（但不写回 → 客户端会掉登录） |
| 网页登录（免 DevTools） | ✅ 官方 `desktop_callback=loopback` 回调 | ❌ 多数要手粘授权码 |
| 微信扫码登录 | ✅ 纯 HTTP 可驱动 | 部分有 |
| 多账号 / 账号池 | ✅ 显式勾选 + 自动换号 | ❌ 全部单账号 |
| 积分读数 / 签到 | ✅ 逐账号 | 部分有 |

---

## 安装

```sh
# ① npm（推荐）
dsh plugin --profile desktop add dsh-connect-raccoon

# ② 本地目录（开发用）
dsh plugin --profile desktop add link:/path/to/dsh-connect-raccoon
```

装完**完全退出 DSH（含托盘）再启动**，然后在「设置 → 插件 → 商汤小浣熊」里登录。

**版本对应**：本插件声明支持 `@deepseek-ai/dsh-llm >= 0.2.1-rc.1 < 0.3.0-0`，
在 Windows + Desktop profile 上开发。其他内核世代需要自己核对 peer 范围。

---

## 两种登录方式（都不需要填 API Key）

### 有客户端：自动读，零操作

插件读桌面端写给本地 agent 的那个文件：`~/.box-agent/config/auth.json`
（`BOX_AGENT_CONFIG_DIR` 可整体搬走，`RACCOON_AUTH_FILE` 可直指文件）。
启动时自动探测一次并把登录态收进池子。

**桌面端要一直开着吗？** 不用。读的是**文件**，不是进程。只要登录过且凭据没过期，关掉 App 照样能用。

**一个客户端能贡献几个账号？** **一个。** 那个文件是一份扁平 JSON，只承载一份登录态 ——
上游的账号模型也是单值槽。要第二个账号，用下面两种登录方式之一。

**会改我的客户端文件吗？** 默认只在**令牌轮转时**写回（不写回会让客户端下次刷新撞
`refresh_conflict` 并被登出）。写回保键序、保未知字段、临时文件 + rename，首次写回前在
`$DSH_HOME` 留一份备份。想完全不写回就把配置里的 `writeBackDesktop` 关掉 —— 代价是客户端会掉一次登录。

### 没客户端：网页授权（推荐）

点「网页登录」，插件：

1. 在 `127.0.0.1` 的随机端口起一个**只收一次回调**的服务器；
2. 用官方授权页的 `desktop_callback=loopback` 参数打开浏览器（这是官方给 IDE 插件的一等公民通道）；
3. 你在页面里用短信或微信登录；
4. 浏览器把授权码 GET 回本地端口，插件换令牌、探一次模型目录、存进池子。

**用户操作 3 步，不需要 F12、不需要手粘任何东西。** 拿到的是完整 token 对（含 refresh token）。

> 主路径的最后一跳（浏览器真的 assign 到 `127.0.0.1`）**未端到端实测**（需要真人登录一次）。
> 所以插件同时保留手粘授权码的兜底：粘整条回调 URL 或裸码都行，`state` 逐字校验。

### 没客户端：微信扫码

点「扫码登录」，插件向 IAM 端点要一个**服务端签发**的二维码，画在设置页里；
用微信扫（小程序内确认）。纯 HTTP 可驱动，但**大概率拿不到 refresh token**，
access token 过期后要重扫 —— 所以它是快路径，不是主线。

---

## 账号池

**成员默认零个，必须显式勾选。** 「本机有登录」不等于「要拿它去花积分」。

- **池开关关着** → 永远用你手选的那个账号。
- **池开关开着** → 每次请求按 `可用优先 → 快过期先花 → 积分高 → 凭据新` 排序挑一个；
  该请求失败时依次换池内其他可用账号重试。
- **换号不写回你的选择**：关掉开关，你选定的账号立刻完全恢复生效。
- **HTTP 400 不换号**：同一个请求体换谁都是 400，重试只会白等。
- **流中途不换号**：一旦第一帧已经吐给宿主就不能再换（会得到两条拼接的回复）。
  所以判定点严格在「尚未收到任何字节」之前。

卡片上同时显示**当前选用**与**本次实际使用**（含原因）—— 开着池时这两者可能不同，
只显示一个会让人以为选错了账号。

### 哪些失败会换号

| 失败 | 换号？ |
| --- | --- |
| 401 / 403 令牌失效 | ✅ |
| 429 / `user_model_rate_limited` | ✅（等冷却或换号） |
| 积分耗尽 | ✅ |
| 上游 5xx / 网络错误 / 超时 | ✅ |
| 400 请求体非法 | ❌ |
| 404 模型不存在 | ❌ |

> `user_model_rate_limited` 的文案写的是「请求频率超限」，实测是**令牌吞吐墙**
> （十个大请求十秒内撞墙，五十个小请求不撞），且上游不给 `Retry-After`。
> 照抄文案会让人去加 sleep，正确动作是换小模型或换号。

---

## 设置页四个 tab

| tab | 内容 |
| --- | --- |
| **账号池** | 逐账号：昵称 / 来源 / 到期 / 剩余积分 / 可用性与原因 / 进池勾选 / 当前选用；行尾「测试」「删除」；顶部「刷新」「批量签到」「网页登录」「扫码登录」「从桌面端导入」「导出」 |
| **模型** | 目录列表，逐行勾选启用 + 倍率 / 促销 / 上下文 / 识图标记 |
| **登录** | 八相位状态机；网页模式给授权页链接 + 手粘授权码；扫码模式内联画二维码 |
| **诊断** | 桌面端探测（路径 / 是否存在 / 可读性 / 原因分类 / 键序是否匹配）、本次实际使用的账号与原因、最近一次换号、版本号 |

输入框左侧常驻一枚积分胶囊 `小浣熊 · 4,123`（只在选中本插件的模型时出现），
点开是逐账号余额表 + 一键切换。

---

## 配置

改 profile 的补丁层 `~/.dsh/profiles/<profile>/cordis.patch.yml`，追加针对本行的 `config`，改完重启 DSH：

```yaml
- id: dsh-connect-raccoon
  config:
    enabled: true
    reuseDesktop: true          # 读本机桌面端登录态（严格只读，除非轮转）
    writeBackDesktop: true      # 轮转后写回，避免客户端被登出
    warmOnStart: true           # 启动时预拉目录与账号
    maxFailoverAttempts: 3      # 一次请求最多换几个账号
    defaultReasoningEffort: ''  # off / low / medium / high / max
    siteOrigin: ''              # 留空用 https://xiaohuanxiong.com
```

---

## 为什么没有「推理档位」下拉

上游对 `reasoning_effort` 只做**部分**校验：随便写的哨兵值（`randomword1234567890`）
也返回 200。所以「某档返回 200」证明不了它被真正执行。插件因此不提供档位选择 ——
宁可没有档位控制，也不给五个看起来能用、实际被忽略的选项。取证见 [`docs/PROTOCOL.md`](docs/PROTOCOL.md)。

---

## 源码地图

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | 插件入口：装配仓库 / 账号 / 运行时 / shim，注册 LLM 与路由 |
| `src/config.ts` | 配置 schema（默认值唯一真源） |
| `src/constants.ts` | 协议常量与路径（唯一真源） |
| `src/state.ts` | 插件状态文件（界面偏好、池开关） |
| `src/credentials/vault.ts` | 一账号一文件的账号仓库 + JWT 声明解码 |
| `src/credentials/desktop.ts` | 桌面端凭据探测与保序写回 |
| `src/credentials/refresh.ts` | 单飞令牌续期（refresh 是单次使用轮转） |
| `src/credentials/inert-auth.ts` | pi-ai 的惰性认证平面（禁止它自己造凭据） |
| `src/protocol/errors.ts` | 上游错误归一（稳定 code + 是否换号） |
| `src/protocol/catalog.ts` | 模型目录解析、兜底目录、识图覆盖表 |
| `src/protocol/client.ts` | 上游 HTTP 客户端（目录 / 余额 / 对话 / 扫码 / 换码 / 签到） |
| `src/protocol/qr.ts` | 零依赖二维码 SVG 编码器 |
| `src/host/accounts.ts` | 账号生命周期：收号、续期、余额、可用性、冷却 |
| `src/host/pool.ts` | 池的排序与挑选（纯函数） |
| `src/host/login.ts` | 登录会话状态机（网页回环 / 扫码） |
| `src/host/routes.ts` | 两条宿主路由 + 动作白名单 |
| `src/host/status.ts` | 状态文档的唯一生产者 |
| `src/host/runtime.ts` | 运行时：把上面这些编成「能读的状态 + 能执行的动作」 |
| `src/llm/adapter.ts` | pi-ai provider 装配 |
| `src/shim/server.ts` | 本地回环 shim：换号发生在第一个字节之前 |
| `src/client/bundle.js` | 浏览器半边（手写经典脚本，不进打包器） |

---

## 开发

```sh
# 一条命令跑完全部校验（版本 → 类型 → 构建 → 客户端自检 → 文档契约 → 宿主装载 → 打包 → 测试）
node scripts/gate.mjs
```

本机 PATH 上没有 node 时用运行时自带的那份：

```sh
NODE="C:/Users/<you>/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe"
"$NODE" scripts/gate.mjs
```

单独跑测试：

```sh
"$NODE" --experimental-strip-types --test "test/*.test.ts"
```

看界面长什么样（离屏渲染到 `.preview/ui.html`，不联网）：

```sh
"$NODE" scripts/preview-ui.mjs
```

诊断本机桌面端凭据（只读、零网络）：

```sh
"$NODE" tools/probe-desktop-creds.mjs          # 人读
"$NODE" tools/probe-desktop-creds.mjs --json   # 机器读
```

---

## 文档

| 文档 | 内容 |
| --- | --- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 8 条架构决策（含每条代价） |
| [`docs/CONTRACT.md`](docs/CONTRACT.md) | 宿主 ⇄ 浏览器的接口真源（状态文档、动作、相位、错误码） |
| [`docs/PROTOCOL.md`](docs/PROTOCOL.md) | 上游协议取证（基址、鉴权、目录、对话、积分、扫码） |
| [`docs/PROTOCOL-EVIDENCE.md`](docs/PROTOCOL-EVIDENCE.md) | 原始证据摘录 |
| [`docs/DESKTOP-CREDS.md`](docs/DESKTOP-CREDS.md) | 桌面端凭据：路径、schema、写回策略 |
| [`docs/WEB-LOGIN.md`](docs/WEB-LOGIN.md) | 网页登录：回环回调机制、参数硬校验、未验证清单 |
| [`docs/ECOSYSTEM.md`](docs/ECOSYSTEM.md) | 同类插件清单与能力对照 |
| [`docs/VERIFY.md`](docs/VERIFY.md) | **真机验证清单**（桌面端 / 网页回环 / 扫码 / 账号池 / 界面） |

---

## 已知限制

- **桌面端只贡献一个账号**：一个 `auth.json` 一份登录态，这是上游数据模型决定的，不是插件没做。
- **主登录路径的最后一跳未真机验证**：需要真人在浏览器里完成一次登录。机制侧有第一方代码证据。
- **扫码登录大概率没有 refresh token**：过期要重扫。
- **换号只在请求级发生**：流中途不能换号，长对话撞吞吐墙时只能整轮重失败。
- **只在 Windows 上真机验证过**；macOS / Linux 的凭据路径按 `os.homedir()` 解析，逻辑相同但未实测。
- **企业版 / 教育版账号**的签到与「领取」不适用（上游对这类账号的个人权益写接口一律拒绝）。

---

## 免责声明

- 本项目仅供个人学习和研究使用，只驱动**使用者自己的**小浣熊账号在本机调用。
- 使用者需遵守商汤小浣熊的服务条款；因使用本项目产生的任何后果由使用者自行承担。
- 本项目与商汤科技、小浣熊、DeepSeek 均无关联，未获其授权或认可；文中出现的名称仅用于描述兼容关系。

## 许可证

[MIT](./LICENSE)
