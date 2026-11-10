# 真机验证清单

> 自动化门禁（`node scripts/gate.mjs`）覆盖了类型、构建、静态自检、文档契约、宿主装载、
> 打包清单与 116 条单测。**它覆盖不到真机链路**：桌面端凭据、浏览器回环回调、微信扫码
> 这三条都需要真人操作上游页面。本文件是那部分的清单。
>
> 本机当前状态（2026-11-10）：**未安装小浣熊桌面端**（注册表 / 文件系统 / 进程三处均无证据，
> `~/.box-agent/config/auth.json` 不存在），所以下面「A 组」只能在他机上验。

---

## 前置：装进本机 DSH

```sh
# 本机 profile 已登记（package.json 的 dependencies + dsh.profile.bundles）
# 若换机器，重新登记后在 profile 目录执行：
dsh plugin --profile desktop add link:X:/Agent/deepseek插件/dsh-connect-raccoon
```

**必须完全退出 DSH（含托盘）再启动** —— 插件树的变更不热加载。

> ### 两个踩过的坑（2026-11-10 实测）
>
> 1. **宿主只在启动时装载插件树**。装完不重启时 `/plugins/dsh-connect-raccoon/status`
>    一直是 404，而同机已有的插件正常 200 —— 看起来像「插件加载失败」，实际只是没重启。
>    判断方法：比对 DSH 主进程启动时间与自己装插件的时间（`Get-Process 'DeepSeek Harness'`）。
> 2. **`file:` 依赖在 pnpm 下可能是拷贝而不是符号链接**。改完 `src/` 重新 `build`
>    只更新工作区，profile 里那份还是旧的 —— 表现是「重启了但行为没变」。
>    `node scripts/gate.mjs` 里的 `check-profile` 就是钉住这件事的；它红了就在 profile
>    目录跑 `pnpm install --force`，或删掉 `node_modules/dsh-connect-raccoon` 再装一次。

启动后确认三件事，缺任何一件就说明没装上：

1. 设置 → 插件 里出现「DSH Connect 商汤小浣熊」条目；
2. 模型选择器里出现「商汤小浣熊」分组（未登录时是 3 个**兜底**模型，名字带「兜底目录条目」描述）；
3. 侧栏/设置导航里出现浣熊图标。

---

## A 组：桌面端凭据（需要装客户端）

| # | 操作 | 期望 | 失败时看哪里 |
| --- | --- | --- | --- |
| A1 | 装小浣熊桌面端并登录，打开 DSH | 卡片「诊断」tab 里 `desktop.exists=true`、`detected=true`、`keyOrderMatchesApp=true` | 诊断 tab 的 `reason`：`desktop-missing` / `desktop-unreadable` / `desktop-no-token` / `desktop-encrypted` 各有专门文案 |
| A2 | 点「从桌面端导入」 | 池里出现一条 `source=desktop` 的账号，`isCurrent=true` | 若回 `desktop-encrypted`：新版客户端把字段加密了，这条路径需要另外取密钥（本插件不解密） |
| A3 | 选一个模型发一句话 | 正常回复；`res.login` 一直是 `idle` | 若报「没有可用的小浣熊账号」，说明池是空的 |
| A4 | 等 access token 临近过期（3 小时）后再发一次 | 自动续期成功；桌面端**没有被登出** | 若桌面端掉了登录，说明写回失败；看 `~/.dsh/.raccoon-auth.json-desktop-backup` 是否生成 |
| A5 | 关闭「写回桌面端」配置项后重复 A4 | 插件自己能用，但桌面端下次刷新会掉登录（**这是预期的代价**） | 配置项 `writeBackDesktop: false` |

---

## B 组：网页授权回环（无客户端，主线）

> 这条链路的**最后一跳未端到端实测**（需要真人登录一次）。B2 是关键观察点。

| # | 操作 | 期望 | 失败时看哪里 |
| --- | --- | --- | --- |
| B1 | 卡片「登录」tab → 点「网页登录」 | 浏览器自动打开 `xiaohuanxiong.com/authorize?...` 授权页；页面里能选短信或微信登录 | 「浏览器没能自动打开」→ 点卡片上那个链接手动开 |
| B2 | 在授权页完成登录 | **浏览器跳到一个「登录成功，可以关闭此页」的本地页面**，然后 DSH 卡片显示「正在校验账号…」→「登录成功：<昵称>」 | 若授权页登录后**停在站内**没有跳转：说明 `desktop_callback=loopback` 没被接受 —— 记下地址栏 URL 与 Network 里 `authorization_code` 的响应，这是唯一需要修的点 |
| B3 | 回到卡片看账号池 | 多出一条 `source=web` 的账号，`isCurrent=true`，到期时间约 3 小时后 | 若 `phase=error` 且 `code=token-rejected`：网关拒绝了令牌，看诊断 tab 的 `catalog.error` |
| B4 | 重复 B1-B3 换个账号登录 | 池里有两条账号，互不覆盖 | 两条 id 相同 = 上游给了同一个 `sub`，不是插件问题 |
| B5 | 点「扫码登录」 | 卡片里画出二维码；用微信扫（小程序内确认）后跳到「登录成功」 | 二维码内容形如 `https://xiaohuanxiong.com/login/mp?code=qr-…&appname=…&source=platform`；浏览器直接打开 `/login/mp` 是 404（预期） |
| B6 | 对 B5 的账号等 access token 过期（3 小时） | 提示需要重新扫码（扫码路径拿不到 refresh token） | 这是已知限制，不是 bug |

---

## C 组：账号池与换号

| # | 操作 | 期望 |
| --- | --- | --- |
| C1 | 池里勾两个账号，打开「账号池」开关 | 卡片上「当前选用」是你手选的，「本次实际使用」是池排序第一名，两者可不同 |
| C2 | 关掉开关 | 「本次实际使用」立刻回到你手选的那个 |
| C3 | 关掉开关后把池成员全部取消勾选，再打开开关 | 回 `没有勾选任何账号`（**不会**退化成全选） |
| C4 | 在「账号池」tab 点某行「测试」 | 该行显示「可用」或具体失败原因（限流 / 积分耗尽 / 令牌失效）；**这会花钱**（发一次真实请求） |
| C5 | 点「批量签到」 | 逐账号一行结果：`claimed` / `already` / `pending` / `failed` |

---

## D 组：界面细节

| # | 操作 | 期望 |
| --- | --- | --- |
| D1 | 选中其它 provider 的模型 | 输入框左侧的积分胶囊**消失**（只在选本插件的模型时出现） |
| D2 | 在「模型」tab 取消勾选一个模型 | 模型选择器里立刻看不到它（不用重启） |
| D3 | 切到英文界面 | 四个 tab、按钮、错误提示全部是英文（无原始键名残留） |
| D4 | 关掉插件（禁用） | 模型分组消失、两条路由 404、shim 端口关闭 |

---

## 自动化门禁覆盖了什么（不用手工重验）

```sh
NODE="C:/Users/<you>/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe"
"$NODE" scripts/gate.mjs          # 13 项：源码/构建/静态检查/单测
"$NODE" scripts/gate.mjs --live   # 再加 2 项：对着**运行中的**宿主验活体
```

| 步骤 | 覆盖 |
| --- | --- |
| `check-version` | `package.json` 与 `constants.ts` 的版本一致 |
| `typecheck` | `tsc --noEmit` 全量 |
| `build` | tsdown 产物 |
| `copy-client` | 浏览器半边拷贝完整性（字节数比对） |
| `check-client` | 语法 / 无 import-export / zh-en 同键 / `t()` 键存在 / 路径逐字一致 / 无令牌字段 |
| `check-doc-contract` | CONTRACT 里的动作、相位、路由与代码逐个对应 |
| `check-host` | 宿主能 import、四件套齐全、无 default 导出、patch 行名等于包名、peer 范围逐段带 rc |
| `check-pack` | 打包清单含必需文件、未混入源码/测试/文档 |
| `tests` | 116 条单测（逐文件跑，报告落 `test-report.txt`） |
| `preview-ui` | 浏览器半边三个槽位组件真能被渲染 |
| `smoke-apply` | 真跑 `apply()`：路由 200、shim 监听、无密钥 401、卸载关端口 |
| `check-cordis` | 用**真的** Cordis `Context` 装载、卸载后注册全释放 |
| `check-profile` | profile 里那份已安装副本与源码构建一致（防「改了没生效」） |
| `probe-pool` | **账号池 + 自动换号**：真插件 + 真 Cordis + 本地假上游，断言 A(401) → B(200) 的换号序列、第二次请求不再重复烧失败 |
| `verify-live` | **运行中的宿主**里 `/status` 回契约形状、无令牌字段、目录非空、客户端 bundle 在位；并比对「主进程启动时间 vs 插件安装时间」 |
| `probe-loopback` | **对着运行中的宿主**真发一次网页登录：本地监听、`state` 64hex、错的 state 回 400、对的 state 2ms 内回 HTML、假授权码打到真上游被归类成 `code-expired` |

`--live` 两项在插件没装进任何 profile 的机器上会自动跳过（源码仓库不等于使用者已装）。

### 已经跑通的真机证据（2026-11-10，本机）

```text
ok   phase=waiting port=61050
ok   state 64hex ✓ redirect ✓ (http://127.0.0.1:61050/auth/callback)
ok   错 state → 400 ✓
ok   对 state 回调 → 200，用时 2ms，页面 460 字节
ok   换码失败归类 ✓ code=code-expired（上游 授权码已失效（一次性，可能已用过）...）
```

扫码链路另测（真实上游签发）：`login-qr` → `phase=waiting`、`qrSvg` 16965 字节（57×57 模块）、
连续轮询保持 `pending` 稳定、`cancel-login` → `phase=cancelled`。

账号池换号（真宿主 + 真 Cordis + 本地假上游，不碰真实账号）：

```text
ok   假上游 http://127.0.0.1:49161
ok   临时 DSH_HOME 里 2 个账号，池已开启；A 凭据更新故先被选中，B 作为后备
ok   shim http://127.0.0.1:49168（地址由插件自己起，密钥长度 43）
ok   换号 A(401) → B(200) ✓ 上游调用序列 A→B
ok   第二次请求直接用 B（A 在冷却中，没重复烧失败）✓
```

---

## 已知未验证项（诚实清单）

| 项 | 状态 | 为什么 |
| --- | --- | --- |
| 真人登录后浏览器跳回 127.0.0.1 | **未验证** | 上面 `probe-loopback` 验的是「回调到达之后」的全过程；「浏览器会不会真的跳过来」需要你本人登录一次 |
| 池内换号在**真实**上游上的表现 | 已用本地假上游端到端验过 | 真实上游的限流/失效码与假上游一致（都按 `docs/PROTOCOL.md` 的码表），但真号轮转（尤其 refresh 单次使用）需两个真账号才能观察 |
| 微信真的扫一次并确认 | **未验证** | 只验到「服务端签发二维码 + 轮询 pending + 取消」；`success` 分支要真手机扫 |
| 扫码是否给 refresh token | 倾向「没有」 | 参考实现只取 access token |
| 桌面端 auth.json 真实形态 | 未验证 | 本机没装客户端；结论来自他机实测 + 参考实现代码 |
| 桌面端写回**不触发**客户端校验 | 未验证 | 需要客户端在场才能观察 |
| `iam/confirm` 成功时 `xhx_token` 的形态 | 未验证 | 需要合法 IAM token |
| refresh 能否带 `Authorization` | 冲突未解 | 两份证据互相矛盾，按「不带」实现 |
| macOS / Linux 凭据路径 | 未验证 | 只在 Windows 真机跑过 |
