# 宿主 ⇄ 浏览器契约

> 这份文件是**唯一**的接口真源。宿主侧 `src/host/status.ts` 产出它，浏览器侧
> `src/client/bundle.js` 消费它。两边任何一侧改字段，必须同时改这里与本文件末尾的
> 「版本与兼容」小节。`scripts/check-client.mjs` 会校验浏览器侧引用的字段都在这里。
>
> 为什么需要契约文件而不是各自读代码：浏览器半边是手写经典脚本、没有类型检查，
> 它唯一能对着写的就是这份文档。字段名写错不会报错，只会静默显示空白。

---

## 一、两条路由

两条都挂在宿主自己的 webServer 上，只接受**回环 Host**（`127.0.0.0/8`、`localhost`、`::1`），
非回环一律 403。响应 `Cache-Control: no-store`。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/plugins/dsh-connect-raccoon/status` | 读最新状态文档（可发上游请求，宿主内部有缓存） |
| POST | `/plugins/dsh-connect-raccoon/action` | 执行白名单里的一个动作 |

两条都要求「Host 是回环**或** Origin 是回环」：某些客户端不回传 Host，只有 Origin 可判。
两者都不是回环一律 403。`action` 是写操作，两条判据任一成立即放行（本机页面一定是其中之一），
远端页面两个头都指不到 127.0.0.1。

`action` 请求体：`{"action": "<名称>", ...其余字段由动作决定}`，上限 64 KiB。

`action` 响应：`{"ok": true, ...}` 或 `{"ok": false, "error": {"code": "...", "message": "..."}}`。
`error.code` 是稳定标识（kebab-case 或上游业务码原文），`message` 是给用户看的中文。

**token 永不进入响应。** 状态文档里只有账号名、到期时间戳、余额、错误分类文案。

---

## 二、`/status` 文档

```jsonc
{
  "schemaVersion": 1,
  "version": "0.0.1",                 // 插件版本
  "provider": "raccoon",
  "enabled": true,                    // 配置里 enabled
  "updatedAtMs": 1760000000000,

  // 桌面端探测结果（只读复用那条腿）
  "desktop": {
    "detected": true,                 // 候选路径里有没有找到可用凭据文件
    "configDir": "C:\\Users\\x\\.box-agent\\config",
    "authPath": "C:\\Users\\x\\.box-agent\\config\\auth.json",
    "exists": true,
    "readable": true,
    "multiAccount": false,            // 恒为 false：桌面端一个文件一份登录态
    "reason": null,                   // 没读到时的分类原因，见 §五
    "nickname": "…",                  // 能解出时才有
    "expiresAtMs": 1760010000000,
    "keyOrderMatchesApp": true,       // 写回安全性的依据
    "adopted": false                  // 是否已在池里（池里有同源账号即为 true）
  },

  // 账号池
  "accounts": [
    {
      "id": "acc_5f3a…",              // 稳定 id：由账号标识派生，增删其它账号不变
      "label": "小浣熊 · 昵称",        // 列表主标题
      "nickname": "…",
      "identity": "personal",          // office_identity 原值，可能缺
      "orgName": "…",                  // 可能缺
      "source": "desktop",             // desktop | web | qr | import
      "isDesktopSource": true,         // 这条记录背后是桌面端文件（写回风险在此）
      "expiresAtMs": 1760010000000,
      "refreshExpiresAtMs": 1762600000000,
      "usable": true,                  // 现在能不能拿去发请求
      "reason": null,                  // usable=false 时给分类原因
      "inPool": true,                  // 是否勾选进池
      "isCurrent": true,               // 是否是用户手选的那个
      "credits": {                     // 读不到时为 null，不写 0
        "total": 4123,
        "expiringSoon": 500,
        "nearestExpiryMs": 1762000000000,
        "fetchedAtMs": 1760000000000
      },
      "lastProbe": {
        "outcome": "ok",               // ok | rate-limited | out-of-credit | rejected | failed | unknown
        "message": "可用",
        "atMs": 1760000000000
      },
      "cooldownUntilMs": null,         // 换号时要跳过的截止时间
      "canCheckin": true               // 企业/教育账号为 false
    }
  ],
  "currentAccountId": "acc_5f3a…",     // 用户手选的；账号池开关不影响它
  "effectiveAccountId": "acc_5f3a…",   // 下一次请求实际会用谁（池开启时可能不同于上面）
  "effectiveReason": "池已启用：可用优先 → 快过期先花 → 积分高 → 凭据新",

  "pool": {
    "enabled": false,                  // 状态文件里的 accountPoolEnabled
    "memberIds": ["acc_5f3a…"],
    "lastFailover": {                  // 最近一次自动换号的记录，没有则 null
      "atMs": 1760000000000,
      "fromId": "acc_5f3a…",
      "toId": "acc_9c1b…",
      "reason": "上游 401"
    }
  },

  "catalog": {
    "source": "live",                  // live | saved | fallback
    "count": 12,
    "fetchedAtMs": 1760000000000,
    "error": null,
    "models": [                        // 完整目录，卡片据此画勾选列表
      {
        "id": "sensechat-6.8-flash-lite",
        "name": "SenseNova-6.8-Flash-Lite",
        "description": "…",
        "vision": false,
        "contextWindow": 131072,
        "maxTokens": 8192,
        "multiplier": "x0.00",
        "promo": "限免一个月",           // 没有活动时为 null
        "reasoning": false,
        "enabled": true                 // 用户是否启用（禁用名单之外的全部为 true）
      }
    ]
  },

  "login": {                           // 进行中的登录会话；没有则 running=false
    "running": true,
    "kind": "web",                     // web | qr
    "phase": "waiting",                // 见 §四
    "message": "请在浏览器里完成登录…",
    "url": "https://xiaohuanxiong.com/authorize?…",
    "port": 53682,
    "qrSvg": null,                     // kind=qr 且已拿到码时是内联 <svg> 字符串
    "expiresAtMs": 1760000300000,
    "error": null                      // { code, message } 或 null
  },

  "checkin": {
    "supported": true,                 // 当前账号是否可签到（企业版 false）
    "lastRunAtMs": 1760000000000,
    "results": [                       // 最近一次批量签到结果
      { "accountId": "acc_5f3a…", "outcome": "already", "message": "今天已领过" }
    ]
  },

  "state": {                           // 插件状态（可写回的部分）
    "disabledModels": [],
    "accountPoolEnabled": false,
    "enabledAccounts": [],
    "composerPill": true,
    "pollIntervalMs": 60000,
    "autoCheckin": false,
    "reuseDesktop": true
  }
}
```

字段规则：

1. **可选字段缺失用 `null`，不用空字符串**；`credits` 读不到就是 `null`，
   不许写成 `{total: 0}` —— 「不知道」不等于「没有」。
2. 时间一律 epoch 毫秒整数。
3. 数组顺序有含义：`accounts` 按「当前 → 池成员 → 其余，再按到期时间升序」排。

---

## 三、动作白名单

| action | body 字段 | 行为 | 返回 |
| --- | --- | --- | --- |
| `refresh` | `{force?: boolean}` | 重拉目录/积分/账号状态并写缓存 | `{ok, status}` |
| `login-web` | `{}` | 起本地回环登录（见 §四） | `{ok, login}` |
| `login-code` | `{text: string}` | 手粘授权码或整条回调 URL（兜底） | `{ok, account?}` |
| `login-qr` | `{}` | 起微信小程序扫码登录 | `{ok, login}` |
| `login-status` | `{}` | 读当前登录会话 | `{ok, login}` |
| `cancel-login` | `{}` | 取消进行中的登录 | `{ok, login}` |
| `adopt-desktop` | `{}` | 把桌面端文件里的登录态收进池 | `{ok, account?}` |
| `switch-account` | `{accountId: string}` | 改用户手选账号（写 `selected`） | `{ok, status}` |
| `remove-account` | `{accountId: string}` | 从池里删掉一条（不动桌面端文件） | `{ok, status}` |
| `members` | `{ids: string[]}` | 设置池成员名单 | `{ok, status}` |
| `settings` | `{patch: {...}}` | 改插件状态 | `{ok, status}` |
| `test-account` | `{accountId: string, modelId?: string}` | 发一次真实体积探测（**花钱**） | `{ok, probe}` |
| `checkin` | `{accountIds?: string[]}` | 给指定/勾选账号逐个签到（**写操作**） | `{ok, results}` |
| `import-accounts` | `{text: string}` | 粘 JSON 导入（**必须带令牌**；脱敏记录会被跳过） | `{ok, imported, skipped}` |
| `export-accounts` | `{accountIds?: string[]}` | 导出到 `$DSH_HOME/raccoon-vault/exports/*.json`（**令牌落文件、不进页面**） | `{ok, count, path, text}`（`text` 是脱敏预览） |

**`error.code` 取值**（稳定标识，不随文案变）：
`not-configured`、`loopback-only`、`already-running`、`not-running`、`no-such-account`、
`desktop-missing`、`desktop-unreadable`、`desktop-no-token`、`login-timeout`、`login-cancelled`、
`state-mismatch`、`code-expired`（上游 `200035`）、`token-rejected`（`200003`）、
`token-invalid`（`100002`）、`rate-limited`、`upstream-error`、`network-error`、
`qr-expired`、`payment-required`、`unsupported-model`。

---

## 四、登录会话的六个相位

```text
idle → waiting → (exchanging) → (validating) → done
                ↘ expired
                ↘ cancelled
                ↘ error
```

| phase | 界面该做什么 |
| --- | --- |
| `idle` | 不显示任何东西（`running=false`） |
| `waiting` | 显示 `message`；`kind=web` 时给「重新打开授权页」按钮（链接 `url`）；`kind=qr` 时把 `qrSvg` 直接 `dangerouslySetInnerHTML` 进容器 |
| `exchanging` | 显示「正在换取登录凭证…」，禁用按钮 |
| `validating` | 显示「正在校验账号…」，禁用按钮 |
| `done` | 显示「登录成功」+ 账号名，然后 `refresh` 一次状态 |
| `expired` | 显示「登录超时，请重新发起」 |
| `cancelled` | 显示「已取消」 |
| `error` | 显示 `error.message`，`error.code=code-expired` 时提示「重新发起」而不是「重试」 |

浏览器侧每 1000 ms 用 `login-status` 轮询一次，直到 `running=false`。

---

## 五、`reason` / `error.code` 的分类口径

| 分类码 | 含义 | 用户可做的动作 |
| --- | --- | --- |
| `desktop-missing` | 候选路径都不存在 | 装客户端并登录，或改用网页登录 |
| `desktop-unreadable` | 文件在但读不了（权限/占用） | 检查权限；或改用网页登录 |
| `desktop-no-token` | 文件在、能读，但没有可用 token 字段 | 重开客户端登录一次 |
| `desktop-encrypted` | 字段是加密信封，本插件不解 | 改用网页登录 |
| `expired` | token 过期且没有 refresh token | 重新登录 |
| `refresh-expired` | refresh token 也过期了 | 重新登录 |
| `credential-rejected` | 上游 401/403 拒绝该令牌 | 换号或重新登录 |
| `rate-limited` | 上游 429 / `user_model_rate_limited` | 等冷却或换号 |
| `out-of-credit` | 积分耗尽 | 签到或换号 |

---

## 六、浏览器侧硬编码常量（必须与 `src/constants.ts` 一致）

```js
var BUNDLE_NAME = 'dsh-connect-raccoon';
var PROVIDER_ID = 'raccoon';
var STATUS_PATH = '/plugins/dsh-connect-raccoon/status';
var ACTION_PATH = '/plugins/dsh-connect-raccoon/action';
```

`scripts/check-client.mjs` 会对这四个字符串做逐字比对。

---

## 七、版本与兼容

- `schemaVersion` 现在只有 `1`。加**必需**字段才升版；加可选字段不升版。
- 浏览器侧读到 `schemaVersion` 大于自己认识的版本时，**只渲染它认识的字段**并显示一条
  「插件较新，部分设置未显示」的提示，不许白屏。
- 删字段等同于升版：必须先让浏览器侧停止引用一个版本，再删。
