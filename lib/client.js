/**
 * 浏览器半侧：小浣熊设置页与输入框左侧的积分胶囊。
 *
 * 职责：经宿主的两条路由读状态、发白名单动作，把账号池、模型目录、登录相位与
 * 桌面端探测结果画出来；本文件不直接访问 xiaohuanxiong.com，也不接触任何令牌。
 * 依赖：`ctx.slots`（回调晚执行）、`ctx.locale`（文案注册与绑定）、宿主提供的 `react`。
 * 不变量：只请求 STATUS_PATH 与 ACTION_PATH；轮询与登录探测都可取消；字段名以
 * `docs/CONTRACT.md` 为准，写错不会报错只会静默显示空白。
 */

(function bootstrapRaccoonClient() {
  var BUNDLE_NAME = 'dsh-connect-raccoon';
  var PROVIDER_ID = 'raccoon';
  var STATUS_PATH = '/plugins/dsh-connect-raccoon/status';
  var ACTION_PATH = '/plugins/dsh-connect-raccoon/action';
  /** 设置页与图标的公共 id：两者必须相等，宿主才会把图标放进这一节。 */
  var SECTION_ID = BUNDLE_NAME;
  /** 状态轮询间隔；诊断页可以就地关掉。 */
  var POLL_INTERVAL_MS = 60000;
  /** 登录会话进行中的探测间隔（契约 §四 规定 1000ms）。 */
  var LOGIN_POLL_MS = 1000;
  /** 本文件认识的契约版本；更大的 schemaVersion 只提示、不白屏。 */
  var KNOWN_SCHEMA_VERSION = 1;

  var CSS = [
    '.dsr-root{display:flex;flex-direction:column;gap:14px;min-width:0;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary)}',
    '.dsr-head{display:flex;flex-direction:column;gap:6px;min-width:0}',
    '.dsr-heading{display:flex;align-items:center;flex-wrap:wrap;gap:9px;min-width:0}',
    '.dsr-title{margin:0;font-size:17px;font-weight:600;line-height:1.4}',
    '.dsr-version{font-size:12px;color:var(--dsw-alias-label-tertiary)}',
    '.dsr-desc{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}',
    '.dsr-tabs{display:flex;gap:2px;overflow-x:auto;border-bottom:1px solid var(--dsw-alias-border-l1)}',
    '.dsr-tab{appearance:none;font:inherit;cursor:pointer;flex:none;border:0;border-bottom:2px solid transparent;background:transparent;padding:7px 13px;white-space:nowrap;color:var(--dsw-alias-label-tertiary)}',
    '.dsr-tab[data-active="true"]{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary)}',
    '.dsr-tab:focus-visible,.dsr-btn:focus-visible,.dsr-pill-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
    '.dsr-panel{display:flex;flex-direction:column;gap:10px;min-width:0}',
    '.dsr-panel[hidden]{display:none}',
    '.dsr-card{min-width:0;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);padding:12px 14px;display:flex;flex-direction:column;gap:8px}',
    '.dsr-card-title{margin:0;font-size:13px;font-weight:600;line-height:1.4}',
    '.dsr-hint{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}',
    '.dsr-warn{margin:0;font-size:12px;line-height:1.6;border-left:3px solid var(--dsw-alias-brand-primary);padding:6px 10px;background:var(--dsw-alias-bg-layer-3);border-radius:0 6px 6px 0;color:var(--dsw-alias-label-secondary)}',
    '.dsr-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-width:0}',
    '.dsr-btn{appearance:none;font:inherit;font-size:12px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);padding:4px 10px;white-space:nowrap}',
    '.dsr-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-3)}',
    '.dsr-btn:disabled{opacity:.5;cursor:not-allowed}',
    '.dsr-btn[data-tone="danger"]{color:var(--dsw-alias-label-secondary)}',
    '.dsr-btn[data-tone="primary"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
    '.dsr-table{width:100%;border-collapse:collapse;font-size:12px}',
    '.dsr-table th{text-align:left;font-weight:600;font-size:11px;color:var(--dsw-alias-label-tertiary);padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l2);white-space:nowrap}',
    '.dsr-table td{padding:7px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:middle}',
    '.dsr-table tr[data-current="true"] td{background:var(--dsw-alias-bg-layer-3)}',
    '.dsr-table tr:last-child td{border-bottom:0}',
    '.dsr-scroll{overflow-x:auto;min-width:0;border-radius:8px}',
    '.dsr-cell-main{display:flex;flex-direction:column;gap:1px;min-width:0}',
    '.dsr-name{font-weight:600;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}',
    '.dsr-sub{font-size:11px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}',
    '.dsr-badge{display:inline-block;font-size:10px;line-height:16px;padding:0 5px;border-radius:4px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);margin-left:4px;white-space:nowrap}',
    '.dsr-bad{color:var(--dsw-alias-label-secondary);font-weight:600}',
    '.dsr-muted{color:var(--dsw-alias-label-tertiary)}',
    '.dsr-kv{display:grid;grid-template-columns:minmax(120px,auto) 1fr;gap:4px 12px;font-size:12px;min-width:0}',
    '.dsr-k{color:var(--dsw-alias-label-tertiary)}',
    '.dsr-v{color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;min-width:0}',
    '.dsr-textarea{width:100%;box-sizing:border-box;min-height:74px;font:inherit;font-size:12px;line-height:1.5;padding:7px 9px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);resize:vertical}',
    '.dsr-input{box-sizing:border-box;font:inherit;font-size:12px;padding:5px 8px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
    '.dsr-qr{display:inline-flex;padding:10px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2)}',
    '.dsr-qr svg{display:block;width:196px;height:196px}',
    '.dsr-field{display:flex;flex-direction:column;gap:4px;min-width:0}',
    '.dsr-field-label{font-size:12px;color:var(--dsw-alias-label-secondary)}',
    '.dsr-check{display:inline-flex;align-items:center;gap:5px;cursor:pointer;font-size:12px}',
    '.dsr-check input{cursor:pointer;margin:0}',
    '.dsr-link{color:var(--dsw-alias-brand-primary);text-decoration:none;border-bottom:1px solid var(--dsw-alias-brand-primary);cursor:pointer}',
    '.dsr-phase{display:flex;align-items:center;gap:8px;min-width:0}',
    '.dsr-spinner{width:12px;height:12px;flex:none;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);animation:dsr-spin .9s linear infinite}',
    '@keyframes dsr-spin{to{transform:rotate(360deg)}}',
    '.dsr-pill{position:relative;display:inline-flex;align-items:center}',
    '.dsr-pill-btn{appearance:none;font:inherit;font-size:12px;line-height:1.4;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);padding:1px 9px;white-space:nowrap}',
    '.dsr-pill-btn:hover{background:var(--dsw-alias-bg-layer-3)}',
    '.dsr-pop{position:absolute;bottom:calc(100% + 6px);left:0;z-index:10;min-width:250px;max-width:330px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);padding:8px 10px;font-size:12px;line-height:1.6;text-align:left}',
    '.dsr-pop-head{font-weight:600;margin-bottom:4px;display:flex;align-items:center;justify-content:space-between;gap:8px}',
    '.dsr-pop-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:4px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}',
    '.dsr-pop-row:last-child{border-bottom:0}',
    '.dsr-pop-name{min-width:0;overflow-wrap:anywhere;display:flex;flex-direction:column;gap:1px}',
    '.dsr-pop-value{white-space:nowrap;color:var(--dsw-alias-label-secondary)}',
    '.dsr-empty{padding:14px 0;text-align:center;font-size:12px;color:var(--dsw-alias-label-tertiary)}'
  ].join('\n');

  var zh = {
    navLabel: '小浣熊',
    title: '商汤小浣熊',
    subtitle: '有桌面端时自动复用本机登录态；没有桌面端时用网页授权或微信扫码登录。多账号可勾选进池、手动切换、失败自动换号。',
    tabAccounts: '账号池',
    tabModels: '模型',
    tabLogin: '登录',
    tabDiag: '诊断',

    refresh: '刷新',
    copy: '复制',
    copied: '已复制',
    cancel: '取消',
    confirm: '确定',
    remove: '删除',
    dash: '—',
    yes: '是',
    no: '否',
    statusUnavailable: '读不到状态：宿主未就绪或这次请求失败了。界面会在下一次轮询时自动重试。',
    olderSchema: '插件比这份界面新，部分设置没有显示。',

    accountsHint: '桌面端一个登录文件只承载一个账号；要第二个账号请用网页/扫码登录。',
    accountsEmpty: '还没有任何账号。用上面的「网页登录」「扫码登录」或「从桌面端导入」加一个。',
    colAccount: '账号',
    colSource: '来源',
    colExpires: '到期',
    colCredits: '剩余积分',
    colStatus: '可用性',
    colPool: '进池',
    colCurrent: '当前选用',
    colActions: '操作',
    sourceDesktop: '桌面端',
    sourceWeb: '网页',
    sourceQr: '扫码',
    sourceImport: '导入',
    sourceUnknown: '未知',
    accountFallback: '未命名账号',
    poolOn: '账户池已启用',
    poolOff: '账户池未启用',
    poolToggle: '启用账户池（自动换号）',
    poolHint: '池内可用账号按「可用优先、快过期先花、积分高、凭据新」排序；请求失败时自动换下一个。',
    poolMembers: '池成员 {count} 个',
    usable: '可用',
    unusable: '不可用',
    creditsUnknown: '读不到',
    creditsExpiring: '{amount} 将在 {date} 过期',
    testAccount: '测试',
    testAccountTitle: '发一次真实请求探测这个账号（会消耗积分）',
    deleteAccount: '删除',
    deleteAccountTitle: '只从插件里删掉这条记录，不动桌面端文件',
    confirmDelete: '确定从插件里删除「{label}」吗？桌面端文件不会被修改。',
    checkinAll: '批量签到',
    webLogin: '网页登录',
    qrLogin: '扫码登录',
    adoptDesktop: '从桌面端导入',
    exportAccounts: '导出',
    importTitle: '导入账号',
    importHint: '粘贴其它机器导出的 JSON（不含令牌）。',
    importPlaceholder: '把导出的 JSON 粘在这里',
    importSubmit: '导入',
    exportTitle: '导出结果',
    exportHint: '上面只是脱敏预览。含令牌的完整副本已写入下面这个文件，请像密码一样保管。',
    exportPathLabel: '完整导出文件路径',
    importResult: '已导入 {imported} 个，跳过 {skipped} 个',
    checkinEmpty: '没有可签到的账号（勾选进池或先添加账号）。',
    checkinSummary: '签到 {total} 个：成功 {ok} 个，失败 {failed} 个',
    testRunning: '测试中…',
    effectiveLine: '实际使用：{label}',
    effectiveReason: '选择依据：{reason}',
    lastFailoverLine: '最近自动换号：{from} → {to}（{reason}）',
    lastFailoverNone: '还没有发生过自动换号',

    modelsHint: '取消勾选的模型不会出现在模型选择器里；至少要保留一个。',
    modelsEmpty: '目录还是空的，点「刷新」重读一次。',
    modelsSourceLine: '目录来源：{source}',
    modelsCount: '{count} 个模型',
    modelMultiplier: '倍率 {value}',
    modelNoMultiplier: '倍率未知',
    modelPromoLabel: '促销',
    modelContext: '上下文 {k}K',
    modelVision: '识图',
    modelReasoning: '推理',
    colMultiplier: '倍率',
    colPromo: '促销',
    colContext: '上下文',
    modelsKeepOne: '至少要留一个模型，最后一个不能被取消勾选。',
    catalogError: '目录读取失败：{message}',
    modelsFetchedAt: '更新于 {time}',
    sourceLive: '实时',
    sourceSaved: '缓存',
    sourceBuiltin: '内置兜底',

    loginHintWeb: '点下面的按钮在浏览器里完成授权；授权页会把授权码送到本地回环地址。回调没生效时，把授权码或整条回调 URL 粘到下面。',
    loginHintQr: '用微信扫下面的码，在小程序里确认登录。',
    loginPhaseIdle: '当前没有进行中的登录。',
    loginPhaseWaiting: '等待你在浏览器里完成登录…',
    loginPhaseExchanging: '正在换取登录凭证…',
    loginPhaseValidating: '正在校验账号…',
    loginPhaseDone: '登录成功',
    loginPhaseExpired: '登录超时，请重新发起',
    loginPhaseCancelled: '已取消',
    loginPhaseError: '登录失败',
    loginOpenAuthorize: '打开授权页',
    loginPasteTitle: '手粘授权码',
    loginPasteLabel: '把授权码粘在这里',
    loginPastePlaceholder: '粘授权码，或整条 http://127.0.0.1:…/auth/callback?code=… 链接',
    loginSubmitCode: '提交授权码',
    loginCancel: '取消登录',
    loginQrMissing: '还没拿到二维码，稍等一下或重新发起扫码登录。',
    loginExpiresAt: '这个会话在 {time} 前有效',
    loginDoneAccount: '已登录：{label}',
    loginRestartHint: '授权码是一次性的，过期后只能重新发起，不能重试同一个码。',
    loginStartWeb: '发起网页登录',
    loginStartQr: '发起扫码登录',
    loginNoSession: '没有进行中的会话。',

    diagHint: '这一页只读，用来判断读不到账号时是哪一环断了。',
    diagVersion: '插件版本',
    diagSchema: '契约版本',
    diagProvider: 'Provider',
    diagUpdated: '状态更新于',
    diagDesktop: '桌面端探测',
    diagDesktopState: '探测结果',
    diagDesktopDetected: '探测到桌面端凭据',
    diagDesktopMissing: '没探测到桌面端凭据',
    diagAuthPath: '凭据文件',
    diagConfigDir: '配置目录',
    diagExists: '文件存在',
    diagReadable: '可读',
    diagRuntime: '运行状态',
    diagNoDesktop: '本机没有可用的桌面端凭据。装客户端并登录，或改用网页登录。',
    diagReason: '原因',
    diagKeyOrder: '键序与客户端一致',
    diagMultiAccount: '一个文件多账号',
    diagAdopted: '已收进池',
    diagNickname: '昵称',
    diagExpires: '凭证到期',
    diagEffective: '下一次请求实际使用',
    diagEffectiveReason: '选择依据',
    diagCurrent: '用户手选账号',
    diagPool: '账户池',
    diagLastFailover: '最近自动换号',
    diagPolling: '后台轮询',
    diagPollingOn: '开着（60 秒一次）',
    diagPollingOff: '已关闭（界面不再自动刷新）',
    diagPollingStop: '关闭轮询',
    diagPollingResume: '恢复轮询',
    diagMultiAccountNo: '恒为否：桌面端一个文件只承载一个登录态',
    diagNoDesktop: '本机没有可用的桌面端凭据。装客户端并登录，或改用网页登录。',
    diagAccounts: '账号数',
    diagCheckin: '最近签到',

    pillName: '小浣熊',
    pillValue: '{name} · {total}',
    pillUnknown: '—',
    pillTitle: '小浣熊积分余额（点开逐账号看）',
    pillBalance: '积分余额',
    pillSwitchHint: '点一行切换当前选用。',
    pillNoAccounts: '还没有账号。',
    pillCurrent: '当前',
    pillSwitch: '切到它',
    pillExpiring: '{amount} 将在 {date} 过期',
    pillExpiresAt: '到期 {time}',

    reasonDesktopMissing: '没找到桌面端凭据文件',
    reasonDesktopUnreadable: '凭据文件读不了',
    reasonDesktopNoToken: '文件里没有可用令牌',
    reasonDesktopEncrypted: '字段是加密信封，本插件不解',
    reasonExpired: '登录已过期',
    reasonRefreshExpired: '续期令牌也过期了',
    reasonCredentialRejected: '上游拒绝了该凭据',
    reasonRateLimited: '被上游限流',
    reasonOutOfCredit: '积分耗尽',
    reasonUnknown: '未知原因',
    probeOk: '探测通过',
    probeRateLimited: '限流',
    probeOutOfCredit: '积分不足',
    probeRejected: '被拒绝',
    probeFailed: '失败',
    probeUnknown: '未探测',
    errorLine: '{code}：{message}',
    errorNoCode: '{message}',
    lastProbeAt: '探测于 {time}',
    loginKindWeb: '网页授权',
    loginKindQr: '扫码',
    exportEmpty: '没有可导出的账号。',
    importEmpty: '先粘一段 JSON 再点导入。'
  };

  var en = {
    navLabel: 'Raccoon',
    title: 'SenseTime Raccoon',
    subtitle: 'Reuses the desktop app sign-in when it exists; otherwise sign in through the browser or the WeChat mini-program QR code. Accounts can be pooled, switched by hand, and failed over automatically.',
    tabAccounts: 'Accounts',
    tabModels: 'Models',
    tabLogin: 'Sign in',
    tabDiag: 'Diagnostics',

    refresh: 'Refresh',
    copy: 'Copy',
    copied: 'Copied',
    cancel: 'Cancel',
    confirm: 'Confirm',
    remove: 'Delete',
    dash: '—',
    yes: 'Yes',
    no: 'No',
    statusUnavailable: 'Status unavailable: the host is not ready or this request failed. The next poll retries automatically.',
    olderSchema: 'The plugin is newer than this UI, so some settings are not shown.',

    accountsHint: 'One desktop sign-in file carries exactly one account; use browser or QR sign-in for a second account.',
    accountsEmpty: 'No accounts yet. Add one with Browser sign-in, QR sign-in, or Import from desktop.',
    colAccount: 'Account',
    colSource: 'Source',
    colExpires: 'Expires',
    colCredits: 'Credits left',
    colStatus: 'Usable',
    colPool: 'In pool',
    colCurrent: 'Selected',
    colActions: 'Actions',
    sourceDesktop: 'Desktop',
    sourceWeb: 'Browser',
    sourceQr: 'QR',
    sourceImport: 'Imported',
    sourceUnknown: 'Unknown',
    accountFallback: 'Unnamed account',
    poolOn: 'Account pool is on',
    poolOff: 'Account pool is off',
    poolToggle: 'Enable the account pool (automatic failover)',
    poolHint: 'Pooled usable accounts are ordered by usable first, soonest expiring first, highest credits, newest credentials; a failed request moves to the next one.',
    poolMembers: '{count} pooled',
    usable: 'Usable',
    unusable: 'Unusable',
    creditsUnknown: 'unavailable',
    creditsExpiring: '{amount} expires on {date}',
    testAccount: 'Test',
    testAccountTitle: 'Send one real request to probe this account (spends credits)',
    deleteAccount: 'Delete',
    deleteAccountTitle: 'Remove only this plugin record; the desktop file is untouched',
    confirmDelete: 'Delete “{label}” from the plugin? The desktop file is not modified.',
    checkinAll: 'Check in all',
    webLogin: 'Browser sign-in',
    qrLogin: 'QR sign-in',
    adoptDesktop: 'Import from desktop',
    exportAccounts: 'Export',
    importTitle: 'Import accounts',
    importHint: 'Paste JSON exported from another machine (it never contains tokens).',
    importPlaceholder: 'Paste the exported JSON here',
    importSubmit: 'Import',
    exportTitle: 'Export result',
    exportHint: 'This is a redacted preview. The full copy (with tokens) was written to the file below — keep it like a password.',
    exportPathLabel: 'Full export file path',
    importResult: 'Imported {imported}, skipped {skipped}',
    checkinEmpty: 'No account to check in (pool some or add one first).',
    checkinSummary: 'Checked in {total}: {ok} ok, {failed} failed',
    testRunning: 'Testing…',
    effectiveLine: 'Actually used: {label}',
    effectiveReason: 'Chosen because: {reason}',
    lastFailoverLine: 'Last automatic failover: {from} → {to} ({reason})',
    lastFailoverNone: 'No automatic failover has happened yet',

    modelsHint: 'Unchecked models do not appear in the model picker; keep at least one.',
    modelsEmpty: 'The catalog is empty. Press Refresh to read it again.',
    modelsSourceLine: 'Catalog source: {source}',
    modelsCount: '{count} models',
    modelMultiplier: '×{value}',
    modelNoMultiplier: 'rate unknown',
    modelPromoLabel: 'Promo',
    modelContext: '{k}K context',
    modelVision: 'Vision',
    modelReasoning: 'Reasoning',
    colMultiplier: 'Rate',
    colPromo: 'Promo',
    colContext: 'Context',
    modelsKeepOne: 'Keep at least one model; the last one cannot be unchecked.',
    catalogError: 'Catalog read failed: {message}',
    modelsFetchedAt: 'Updated {time}',
    sourceLive: 'live',
    sourceSaved: 'cached',
    sourceBuiltin: 'built-in fallback',

    loginHintWeb: 'Press the button to finish authorizing in your browser; the authorize page delivers the code to a loopback address. If the callback does not land, paste the code or the whole callback URL below.',
    loginHintQr: 'Scan the code with WeChat and confirm in the mini-program.',
    loginPhaseIdle: 'No sign-in in progress.',
    loginPhaseWaiting: 'Waiting for you to finish signing in…',
    loginPhaseExchanging: 'Exchanging for credentials…',
    loginPhaseValidating: 'Validating the account…',
    loginPhaseDone: 'Signed in',
    loginPhaseExpired: 'Sign-in timed out, please start again',
    loginPhaseCancelled: 'Cancelled',
    loginPhaseError: 'Sign-in failed',
    loginOpenAuthorize: 'Open authorize page',
    loginPasteTitle: 'Paste an authorization code',
    loginPasteLabel: 'Paste the code here',
    loginPastePlaceholder: 'Paste the code, or the whole http://127.0.0.1:…/auth/callback?code=… URL',
    loginSubmitCode: 'Submit code',
    loginCancel: 'Cancel sign-in',
    loginQrMissing: 'No QR code yet; wait a moment or start QR sign-in again.',
    loginExpiresAt: 'This session is valid until {time}',
    loginDoneAccount: 'Signed in: {label}',
    loginRestartHint: 'An authorization code is single-use; once expired you can only start over, not retry the same code.',
    loginStartWeb: 'Start browser sign-in',
    loginStartQr: 'Start QR sign-in',
    loginNoSession: 'No session in progress.',

    diagHint: 'This page is read-only; it shows which link broke when accounts are missing.',
    diagVersion: 'Plugin version',
    diagSchema: 'Contract version',
    diagProvider: 'Provider',
    diagUpdated: 'Status updated',
    diagDesktop: 'Desktop probe',
    diagDesktopState: 'Probe result',
    diagDesktopDetected: 'Desktop credentials detected',
    diagDesktopMissing: 'No desktop credentials detected',
    diagAuthPath: 'Credential file',
    diagConfigDir: 'Config directory',
    diagExists: 'File exists',
    diagReadable: 'Readable',
    diagRuntime: 'Runtime state',
    diagReason: 'Reason',
    diagKeyOrder: 'Key order matches the app',
    diagMultiAccount: 'Multiple accounts per file',
    diagAdopted: 'Adopted into the pool',
    diagNickname: 'Nickname',
    diagExpires: 'Credential expiry',
    diagEffective: 'Next request actually uses',
    diagEffectiveReason: 'Chosen because',
    diagCurrent: 'Selected by hand',
    diagPool: 'Account pool',
    diagLastFailover: 'Last automatic failover',
    diagPolling: 'Background polling',
    diagPollingOn: 'On (every 60 seconds)',
    diagPollingOff: 'Off (the UI no longer refreshes itself)',
    diagPollingStop: 'Stop polling',
    diagPollingResume: 'Resume polling',
    diagMultiAccountNo: 'Always no: one desktop file carries one sign-in',
    diagNoDesktop: 'No usable desktop credentials on this machine. Install and sign in to the app, or use browser sign-in.',
    diagAccounts: 'Accounts',
    diagCheckin: 'Last check-in',

    pillName: 'Raccoon',
    pillValue: '{name} · {total}',
    pillUnknown: '—',
    pillTitle: 'Raccoon credit balance (click for per-account detail)',
    pillBalance: 'Credit balance',
    pillSwitchHint: 'Click a row to select it.',
    pillNoAccounts: 'No accounts yet.',
    pillCurrent: 'Current',
    pillSwitch: 'Switch',
    pillExpiring: '{amount} expires on {date}',
    pillExpiresAt: 'Expires {time}',

    reasonDesktopMissing: 'No desktop credential file found',
    reasonDesktopUnreadable: 'The credential file cannot be read',
    reasonDesktopNoToken: 'The file holds no usable credential field',
    reasonDesktopEncrypted: 'The fields are encrypted envelopes this plugin does not decrypt',
    reasonExpired: 'The sign-in expired',
    reasonRefreshExpired: 'The renewal credential expired too',
    reasonCredentialRejected: 'The upstream rejected this credential',
    reasonRateLimited: 'Rate limited by the upstream',
    reasonOutOfCredit: 'Out of credits',
    reasonUnknown: 'Unknown reason',
    probeOk: 'Probe passed',
    probeRateLimited: 'Rate limited',
    probeOutOfCredit: 'Out of credits',
    probeRejected: 'Rejected',
    probeFailed: 'Failed',
    probeUnknown: 'Not probed',
    errorLine: '{code}: {message}',
    errorNoCode: '{message}',
    lastProbeAt: 'Probed {time}',
    loginKindWeb: 'browser authorization',
    loginKindQr: 'QR code',
    exportEmpty: 'No account to export.',
    importEmpty: 'Paste some JSON before importing.'
  };

  var loader = globalThis.__ModuleLoader__;
  if (loader === undefined) return;

  loader.load({
    id: BUNDLE_NAME,
    factory: function factory(require) {
      var React = require('react');
      var h = React.createElement;

      /**
       * 注入一次样式表。
       *
       * 用 `data-plugin-css` 做幂等键而不是 `id`：宿主的热重载会重跑 `apply`，
       * 有键就能就地替换文本，不会在 `<head>` 里叠出第二份声明。
       */
      function injectStyleOnce(key, css) {
        if (typeof document === 'undefined') return;
        var existing = document.querySelector('style[data-plugin-css="' + key + '"]');
        if (existing !== null) {
          existing.textContent = css;
          return;
        }
        var tag = document.createElement('style');
        tag.dataset.pluginCss = key;
        tag.textContent = css;
        document.head.appendChild(tag);
      }

      /** 数字读数：拿不到就给破折号，绝不把 `NaN` 印到界面上。 */
      function credits(value) {
        if (value === undefined || value === null || typeof value !== 'number' || !isFinite(value)) {
          return '—';
        }
        return value.toLocaleString();
      }

      /** 时间读数：契约里一律是 epoch 毫秒，坏值一律退成破折号。 */
      function clock(ms) {
        if (ms === undefined || ms === null || typeof ms !== 'number' || !isFinite(ms)) return '—';
        return new Date(ms).toLocaleString(undefined, {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit'
        });
      }

      /** 只要日期：积分「快过期」提示里时间粒度到天就够了。 */
      function shortDate(ms) {
        if (ms === undefined || ms === null || typeof ms !== 'number' || !isFinite(ms)) return '—';
        return new Date(ms).toLocaleDateString(undefined, { month: '2-digit', day: '2-digit' });
      }

      /** 上下文窗口按 K 显示；缺值时不显示单位，避免出现「undefinedK」。 */
      function contextK(value) {
        if (typeof value !== 'number' || !isFinite(value) || value <= 0) return undefined;
        return String(Math.round(value / 1024));
      }

      /** 取值链，任何一层缺失就返回 undefined，省掉满屏的 `&&`。 */
      function pick(root, path) {
        var node = root;
        for (var index = 0; index < path.length; index += 1) {
          if (node === undefined || node === null) return undefined;
          if (typeof node !== 'object') return undefined;
          node = node[path[index]];
        }
        return node;
      }

      /** 把动作错误对象渲染成一句可读的话；只有 message 时不留空括号。 */
      function errorText(t, error) {
        if (error === undefined || error === null) return '';
        var message = typeof error.message === 'string' && error.message !== '' ? error.message : t('reasonUnknown');
        if (typeof error.code === 'string' && error.code !== '') {
          return t('errorLine', { code: error.code, message: message });
        }
        return t('errorNoCode', { message: message });
      }

      /**
       * 分类原因码 → 文案键。
       *
       * 契约 §五 的分类码是稳定标识，只在这里映射一次：账号行与诊断页共用同一套，
       * 复制两份以后必然有一处落后，界面会自相矛盾。
       */
      function reasonKey(code) {
        if (code === 'desktop-missing') return 'reasonDesktopMissing';
        if (code === 'desktop-unreadable') return 'reasonDesktopUnreadable';
        if (code === 'desktop-no-token') return 'reasonDesktopNoToken';
        if (code === 'desktop-encrypted') return 'reasonDesktopEncrypted';
        if (code === 'expired') return 'reasonExpired';
        if (code === 'refresh-expired') return 'reasonRefreshExpired';
        if (code === 'credential-rejected') return 'reasonCredentialRejected';
        if (code === 'rate-limited') return 'reasonRateLimited';
        if (code === 'out-of-credit') return 'reasonOutOfCredit';
        return 'reasonUnknown';
      }

      /** 探测结论码 → 文案键（`lastProbe.outcome`，见契约 §二）。 */
      function probeKey(code) {
        if (code === 'ok') return 'probeOk';
        if (code === 'rate-limited') return 'probeRateLimited';
        if (code === 'out-of-credit') return 'probeOutOfCredit';
        if (code === 'rejected') return 'probeRejected';
        if (code === 'failed') return 'probeFailed';
        return 'probeUnknown';
      }

      /** 账号来源码 → 文案键（`source`：desktop | web | qr | import）。 */
      function sourceKey(code) {
        if (code === 'desktop') return 'sourceDesktop';
        if (code === 'web') return 'sourceWeb';
        if (code === 'qr') return 'sourceQr';
        if (code === 'import') return 'sourceImport';
        return 'sourceUnknown';
      }

      /** 目录来源码 → 文案键（`catalog.source`：live | saved | fallback）。 */
      function catalogSourceKey(code) {
        if (code === 'live') return 'sourceLive';
        if (code === 'saved') return 'sourceSaved';
        return 'sourceBuiltin';
      }

      /** 账号的显示名：契约给了 `label`，缺了才退到昵称与兜底名。 */
      function accountLabel(t, account) {
        if (account === undefined || account === null) return t('accountFallback');
        if (typeof account.label === 'string' && account.label !== '') return account.label;
        if (typeof account.nickname === 'string' && account.nickname !== '') return account.nickname;
        return t('accountFallback');
      }

      /** 按 id 找账号；找不到返回 undefined，调用方据此显示占位而不是空串。 */
      function accountById(accounts, id) {
        if (!Array.isArray(accounts) || typeof id !== 'string') return undefined;
        for (var index = 0; index < accounts.length; index += 1) {
          if (accounts[index] !== null && typeof accounts[index] === 'object' && accounts[index].id === id) {
            return accounts[index];
          }
        }
        return undefined;
      }

      /** 当前可用的总积分：优先手选账号，其次实际生效账号，再退回第一条读得到余额的。 */
      function pillTotal(status) {
        if (status === undefined || status === null) return undefined;
        var accounts = Array.isArray(status.accounts) ? status.accounts : [];
        var chosen =
          accountById(accounts, status.currentAccountId) ||
          accountById(accounts, status.effectiveAccountId);
        if (chosen !== undefined) {
          var direct = pick(chosen, ['credits', 'total']);
          if (typeof direct === 'number') return direct;
        }
        for (var index = 0; index < accounts.length; index += 1) {
          var total = pick(accounts[index], ['credits', 'total']);
          if (typeof total === 'number') return total;
        }
        return undefined;
      }

      /** 把动作返回的 `status` 信封写回快照：省掉一次「动作后再 GET」的往返。 */
      function applyStatus(status) {
        if (status === undefined || status === null || typeof status !== 'object') return false;
        snapshot = status;
        emit();
        return true;
      }

      /**
       * 把动作返回的 `login` 信封合并进快照。
       *
       * `login-status` 的返回只含登录会话，不含整份状态文档；不合并的话登录页要等到
       * 下一次 60 秒轮询才会动，用户会以为按钮没生效。
       */
      function applyLogin(login) {
        if (login === undefined || login === null || typeof login !== 'object') return false;
        var base = snapshot === undefined || snapshot === null ? {} : snapshot;
        var next = {};
        Object.keys(base).forEach(function (key) {
          next[key] = base[key];
        });
        next.login = login;
        snapshot = next;
        emit();
        return true;
      }

      var listeners = new Set();
      var snapshot;
      var ticker;
      var inflight;
      var inflightController;
      var polling = true;

      function emit() {
        listeners.forEach(function (listener) {
          try {
            listener(snapshot);
          } catch (error) {
            console.error('[dsh-connect-raccoon] 订阅者抛错（已忽略，不影响其它界面）：', error);
          }
        });
      }

      /**
       * 读一次状态。
       *
       * 复用同一个 `inflight`：设置页与胶囊同时挂载时会各触发一次加载，并发的两份
       * 请求没有意义；共享同一个 promise 还能保证顺序（后到的不会覆盖先到的）。
       */
      function loadStatus() {
        if (inflight !== undefined) return inflight;
        var controller = typeof AbortController === 'function' ? new AbortController() : undefined;
        var options = { headers: { accept: 'application/json' } };
        if (controller !== undefined) options.signal = controller.signal;
        inflightController = controller;
        var promise = fetch(STATUS_PATH, options)
          .then(function (response) {
            if (!response.ok) return undefined;
            return response.json();
          })
          .then(function (document) {
            if (document === undefined || document === null) return undefined;
            snapshot = document;
            emit();
            return document;
          })
          .catch(function (error) {
            // 一次轮询失败不值得把读数清空：保留上一次的值，等下一轮自愈。
            if (error !== undefined && error !== null && error.name === 'AbortError') return undefined;
            return undefined;
          })
          .then(function (document) {
            inflight = undefined;
            inflightController = undefined;
            return document;
          });
        inflight = promise;
        return promise;
      }

      /** 卸载/停用时掐掉在途请求：晚到的响应不该再写进已经清空的快照。 */
      function abortInflight() {
        if (inflightController === undefined) return;
        try {
          inflightController.abort();
        } catch (error) {
          void error;
        }
        inflightController = undefined;
        inflight = undefined;
      }

      /** 启动 ticker；重复调用只保留一个定时器。 */
      function startTicker() {
        if (ticker !== undefined) return;
        if (!polling) return;
        ticker = setInterval(function () {
          void loadStatus();
        }, POLL_INTERVAL_MS);
      }

      function stopTicker() {
        if (ticker === undefined) return;
        clearInterval(ticker);
        ticker = undefined;
      }

      /** 诊断页的开关：关掉之后界面不再自动刷新，但手动「刷新」仍然有效。 */
      function setPolling(on) {
        polling = on === true;
        if (polling) startTicker();
        else stopTicker();
      }

      /** 订阅状态；返回退订函数。首个订阅者负责起 ticker，末个退订负责停。 */
      function watch(listener) {
        listeners.add(listener);
        if (listeners.size === 1) {
          void loadStatus();
          startTicker();
        }
        return function () {
          listeners.delete(listener);
          if (listeners.size === 0) stopTicker();
        };
      }

      /** 组件侧读数入口：返回 `[status, reload]`。依赖数组为空是有意的，订阅只建一次。 */
      function useStatus() {
        var state = React.useState(snapshot);
        var status = state[0];
        var setStatus = state[1];
        React.useEffect(function () {
          // 挂载时先把当前快照铺上：store 里可能已经有值（另一块界面先加载完了）。
          setStatus(snapshot);
          return watch(setStatus);
        }, []);
        return [
          status,
          function () {
            void loadStatus();
          }
        ];
      }

      /**
       * 发一个白名单动作。
       *
       * 请求体就是契约 §一 的形状 `{action, ...其余字段}`；失败不抛给组件，统一转成
       * `{ok:false, error}` 让调用方决定怎么显示。`options.signal` 供登录轮询在卸载时
       * 掐断在途请求。
       */
      function act(action, body, options) {
        var payload = { action: action };
        if (body !== undefined && body !== null && typeof body === 'object') {
          Object.keys(body).forEach(function (key) {
            payload[key] = body[key];
          });
        }
        var init = {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(payload)
        };
        if (options !== undefined && options !== null && options.signal !== undefined) init.signal = options.signal;
        return fetch(ACTION_PATH, init)
          .then(function (response) {
            return response.json().then(
              function (result) {
                if (result !== null && typeof result === 'object') return result;
                return { ok: response.ok };
              },
              function () {
                return { ok: false, error: { code: 'upstream-error', message: 'HTTP ' + response.status } };
              }
            );
          })
          .then(function (result) {
            // 动作返回的信封里可能直接带整份 `status` 或新的 `login`：就地铺进快照，
            // 界面立刻反映结果，不必等下一次轮询。
            // `ok:false` 也要铺：`login-code` 失败回的是「已过期的 login 视图」，
            // 丢掉它界面会一直停在旧相位上。
            if (result !== undefined && result !== null) {
              if (!applyStatus(result.status)) applyLogin(result.login);
            }
            return result;
          })
          .catch(function (error) {
            return {
              ok: false,
              error: { code: 'network-error', message: error === undefined || error === null ? '' : String(error.message || error) }
            };
          });
      }

      /** 一句说明文字；`tone="warn"` 用于「这条是产品事实」的提示。 */
      function Note(props) {
        return h('p', { className: props.tone === 'warn' ? 'dsr-warn' : 'dsr-hint' }, props.children);
      }

      /** 小标题卡片；`actions` 是标题右侧的按钮组。 */
      function Card(props) {
        return h(
          'div',
          { className: 'dsr-card' },
          props.title === undefined
            ? null
            : h(
                'div',
                { className: 'dsr-toolbar' },
                h('h3', { className: 'dsr-card-title' }, props.title),
                h('span', { style: { flex: '1 1 auto' } }),
                props.actions === undefined ? null : props.actions
              ),
          props.children
        );
      }

      /** 一行「标签 / 值」，值可以是任意节点。 */
      function Kv(props) {
        return h(
          React.Fragment,
          null,
          h('span', { className: 'dsr-k' }, props.label),
          h('span', { className: 'dsr-v' }, props.children === undefined ? '—' : props.children)
        );
      }

      /** 工具条按钮；`tone` 只影响观感，不改变行为。 */
      function Button(props) {
        return h(
          'button',
          {
            type: 'button',
            className: 'dsr-btn',
            'data-tone': props.tone,
            title: props.title,
            disabled: props.disabled === true,
            onClick: props.onClick
          },
          props.children
        );
      }

      /** 徽标：紧跟在名字后面，不参与右对齐（右对齐会让它看起来属于下一列）。 */
      function Badge(props) {
        return h('span', { className: 'dsr-badge' }, props.children);
      }

      /** 忙碌标记：只在真的在请求时出现，避免页面无端跳动。 */
      function Spinner() {
        return h('span', { className: 'dsr-spinner', 'aria-hidden': true });
      }

      /**
       * 账号池 tab：逐账号一行，勾选进池、单选当前、行尾测试与删除。
       *
       * 写操作一律「先发动作、再由动作返回的 status 覆盖快照」，不做乐观更新：
       * 宿主是唯一真相，猜错了会让用户以为切换成功。
       */
      function AccountsTab(props) {
        var t = props.t;
        var status = props.status;
        var busy = props.busy;
        var perform = props.perform;
        var accounts = status !== undefined && Array.isArray(status.accounts) ? status.accounts : undefined;
        var pool = status === undefined ? undefined : status.pool;
        var memberIds = pool !== undefined && Array.isArray(pool.memberIds) ? pool.memberIds : [];
        var poolEnabled = pool !== undefined && pool.enabled === true;
        var importState = React.useState(false);
        var importOpen = importState[0];
        var setImportOpen = importState[1];
        var importTextState = React.useState('');
        var importText = importTextState[0];
        var setImportText = importTextState[1];
        var exportTextState = React.useState('');
        var exportText = exportTextState[0];
        var setExportText = exportTextState[1];
        // 完整导出（含令牌）落在宿主磁盘上，页面只拿到这个路径。
        var exportPathState = React.useState('');
        var exportPath = exportPathState[0];
        var setExportPath = exportPathState[1];

        /** 写池成员名单：整份替换，宿主不接受增量。 */
        function writeMembers(ids) {
          void perform('members', { ids: ids }, function () {
            return '';
          });
        }

        function toggleMember(id, nextOn) {
          var ids = memberIds.filter(function (item) {
            return item !== id;
          });
          if (nextOn) ids.push(id);
          writeMembers(ids);
        }

        function onExport() {
          var ids = memberIds.slice();
          if (ids.length === 0 && accounts !== undefined) {
            ids = accounts.map(function (account) {
              return account.id;
            });
          }
          if (ids.length === 0) {
            setExportText(t('exportEmpty'));
            return;
          }
          props.setBusy(true);
          void act('export-accounts', { accountIds: ids }).then(function (result) {
            props.setBusy(false);
            if (result === undefined || result.ok !== true) {
              setExportText(result === undefined ? '' : errorText(t, result.error));
              return;
            }
            setExportText(typeof result.text === 'string' ? result.text : '');
            setExportPath(typeof result.path === 'string' ? result.path : '');
          });
        }

        function onImport() {
          if (importText.trim() === '') {
            props.setNotice(t('importEmpty'));
            return;
          }
          props.setBusy(true);
          void act('import-accounts', { text: importText }).then(function (result) {
            props.setBusy(false);
            if (result === undefined || result.ok !== true) {
              props.setNotice(result === undefined ? t('reasonUnknown') : errorText(t, result.error));
              return;
            }
            setImportText('');
            setImportOpen(false);
            props.setNotice(t('importResult', {
              imported: credits(result.imported),
              skipped: credits(result.skipped)
            }));
            void loadStatus();
          });
        }

        function onCheckin() {
          var ids = memberIds.length > 0
            ? memberIds.slice()
            : (accounts === undefined
                ? []
                : accounts
                    .filter(function (account) {
                      return account.canCheckin !== false;
                    })
                    .map(function (account) {
                      return account.id;
                    }));
          if (ids.length === 0) {
            props.setNotice(t('checkinEmpty'));
            return;
          }
          void perform('checkin', { accountIds: ids }, function (result) {
            var results = result !== undefined && Array.isArray(result.results) ? result.results : undefined;
            if (results === undefined) return '';
            var ok = 0;
            results.forEach(function (item) {
              if (item !== null && typeof item === 'object' && item.outcome !== 'failed') ok += 1;
            });
            return t('checkinSummary', {
              total: credits(results.length),
              ok: credits(ok),
              failed: credits(results.length - ok)
            });
          });
        }

        var head = h(
          'div',
          { className: 'dsr-toolbar' },
          h(Button, {
            disabled: busy,
            onClick: function () {
              void perform('refresh', { force: true }, function () {
                return '';
              });
            }
          }, t('refresh')),
          h(Button, { disabled: busy || status === undefined, onClick: onCheckin }, t('checkinAll')),
          h(Button, {
            disabled: busy,
            onClick: function () {
              props.onStartLogin('web');
            }
          }, t('webLogin')),
          h(Button, {
            disabled: busy,
            onClick: function () {
              props.onStartLogin('qr');
            }
          }, t('qrLogin')),
          h(Button, {
            disabled: busy || status === undefined,
            title: t('accountsHint'),
            onClick: function () {
              void perform('adopt-desktop', {}, function () {
                return '';
              });
            }
          }, t('adoptDesktop')),
          h(Button, { disabled: busy, onClick: function () { setImportOpen(!importOpen); } }, t('importTitle')),
          h(Button, { disabled: busy || status === undefined, onClick: onExport }, t('exportAccounts'))
        );

        var rows = [];
        if (accounts !== undefined) {
          accounts.forEach(function (account) {
            var isCurrent = account.id === status.currentAccountId;
            var isMember = memberIds.indexOf(account.id) >= 0;
            var creditsNode = account.credits === null || account.credits === undefined
              ? h('span', { className: 'dsr-muted' }, t('creditsUnknown'))
              : h(
                  'div',
                  { className: 'dsr-cell-main' },
                  h('span', { className: 'dsr-name' }, credits(account.credits.total)),
                  typeof account.credits.expiringSoon === 'number' && account.credits.expiringSoon > 0
                    ? h('span', { className: 'dsr-sub' }, t('creditsExpiring', {
                        amount: credits(account.credits.expiringSoon),
                        date: shortDate(account.credits.nearestExpiryMs)
                      }))
                    : null
                );
            var usableNode = h(
              'div',
              { className: 'dsr-cell-main' },
              h(
                'span',
                { className: account.usable === true ? 'dsr-name' : 'dsr-bad' },
                account.usable === true ? t('usable') : t('unusable')
              ),
              account.usable === true
                ? null
                : h('span', { className: 'dsr-sub' }, t(reasonKey(account.reason)))
            );
            rows.push(
              h(
                'tr',
                { key: account.id, 'data-current': String(isCurrent) },
                h(
                  'td',
                  null,
                  h(
                    'div',
                    { className: 'dsr-cell-main' },
                    h('span', { className: 'dsr-name' }, accountLabel(t, account)),
                    h(
                      'span',
                      { className: 'dsr-sub' },
                      typeof account.identity === 'string' && account.identity !== ''
                        ? account.identity
                        : account.id
                    )
                  )
                ),
                h(
                  'td',
                  null,
                  h('span', null, t(sourceKey(account.source))),
                  account.isDesktopSource === true ? h(Badge, null, t('sourceDesktop')) : null
                ),
                h('td', null, h('span', { className: 'dsr-sub' }, clock(account.expiresAtMs))),
                h('td', null, creditsNode),
                h('td', null, usableNode),
                h(
                  'td',
                  null,
                  h(
                    'label',
                    { className: 'dsr-check' },
                    h('input', {
                      type: 'checkbox',
                      checked: isMember,
                      disabled: busy,
                      onChange: function (event) {
                        toggleMember(account.id, event.target.checked);
                      }
                    })
                  )
                ),
                h(
                  'td',
                  null,
                  h('input', {
                    type: 'radio',
                    name: 'dsr-current-account',
                    checked: isCurrent,
                    disabled: busy,
                    title: accountLabel(t, account),
                    onChange: function () {
                      void perform('switch-account', { accountId: account.id }, function () {
                        return '';
                      });
                    }
                  })
                ),
                h(
                  'td',
                  null,
                  h(
                    'div',
                    { className: 'dsr-toolbar' },
                    h(
                      Button,
                      {
                        disabled: busy,
                        title: t('testAccountTitle'),
                        onClick: function () {
                          void perform('test-account', { accountId: account.id }, function (result) {
                            var probe = result === undefined ? undefined : result.probe;
                            if (probe === undefined || probe === null) return '';
                            var label = t(probeKey(probe.outcome));
                            return typeof probe.message === 'string' && probe.message !== ''
                              ? label + '：' + probe.message
                              : label;
                          });
                        }
                      },
                      t('testAccount')
                    ),
                    h(
                      Button,
                      {
                        tone: 'danger',
                        disabled: busy,
                        title: t('deleteAccountTitle'),
                        onClick: function () {
                          if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
                            if (!window.confirm(t('confirmDelete', { label: accountLabel(t, account) }))) return;
                          }
                          void perform('remove-account', { accountId: account.id }, function () {
                            return '';
                          });
                        }
                      },
                      t('deleteAccount')
                    )
                  )
                )
              )
            );
          });
        }

        var table = h(
          'div',
          { className: 'dsr-scroll' },
          h(
            'table',
            { className: 'dsr-table' },
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', null, t('colAccount')),
                h('th', null, t('colSource')),
                h('th', null, t('colExpires')),
                h('th', null, t('colCredits')),
                h('th', null, t('colStatus')),
                h('th', null, t('colPool')),
                h('th', null, t('colCurrent')),
                h('th', null, t('colActions'))
              )
            ),
            h('tbody', null, rows)
          )
        );

        var effective = status === undefined ? undefined : accountById(accounts, status.effectiveAccountId);
        var failover = pool === undefined ? undefined : pool.lastFailover;

        return h(
          React.Fragment,
          null,
          h(Note, { tone: 'warn' }, t('accountsHint')),
          h(Card, { title: accounts === undefined ? undefined : t('poolMembers', { count: credits(memberIds.length) }), actions: head },
            h(
              'label',
              { className: 'dsr-check' },
              h('input', {
                type: 'checkbox',
                checked: poolEnabled,
                disabled: busy || status === undefined,
                onChange: function (event) {
                  void perform('settings', { patch: { accountPoolEnabled: event.target.checked } }, function () {
                    return '';
                  });
                }
              }),
              t('poolToggle')
            ),
            h(Note, null, t('poolHint')),
            accounts === undefined || accounts.length === 0
              ? h('div', { className: 'dsr-empty' }, t('accountsEmpty'))
              : table,
            effective === undefined
              ? null
              : h(Note, null, t('effectiveLine', { label: accountLabel(t, effective) })),
            typeof status === 'object' && status !== undefined && typeof status.effectiveReason === 'string' && status.effectiveReason !== ''
              ? h(Note, null, t('effectiveReason', { reason: status.effectiveReason }))
              : null,
            failover === undefined || failover === null
              ? h(Note, null, t('lastFailoverNone'))
              : h(Note, null, t('lastFailoverLine', {
                  from: accountLabel(t, accountById(accounts, failover.fromId) || { label: String(failover.fromId) }),
                  to: accountLabel(t, accountById(accounts, failover.toId) || { label: String(failover.toId) }),
                  reason: typeof failover.reason === 'string' ? failover.reason : t('reasonUnknown')
                }))
          ),
          importOpen
            ? h(Card, { title: t('importTitle') },
                h(Note, null, t('importHint')),
                h('textarea', {
                  className: 'dsr-textarea',
                  placeholder: t('importPlaceholder'),
                  value: importText,
                  onChange: function (event) {
                    setImportText(event.target.value);
                  }
                }),
                h(
                  'div',
                  { className: 'dsr-toolbar' },
                  h(Button, { tone: 'primary', disabled: busy, onClick: onImport }, t('importSubmit')),
                  h(Button, { onClick: function () { setImportOpen(false); } }, t('cancel'))
                )
              )
            : null,
          exportText === ''
            ? null
            : h(Card, { title: t('exportTitle') },
                h(Note, null, t('exportHint')),
                exportPath === '' ? null : h('textarea', {
                  className: 'dsr-textarea',
                  readOnly: true,
                  value: exportPath,
                  'aria-label': t('exportPathLabel')
                }),
                h('textarea', { className: 'dsr-textarea', readOnly: true, value: exportText })
              )
        );
      }

      /**
       * 模型 tab：目录逐行勾选启用。
       *
       * `catalog.models[].enabled` 是宿主算好的「是否在禁用名单之外」，写回时发的是
       * 整份 `disabledModels` 名单（契约 §三 `settings` 的 patch 形状），不是增量开关。
       */
      function ModelsTab(props) {
        var t = props.t;
        var status = props.status;
        var busy = props.busy;
        var perform = props.perform;
        var catalog = status === undefined ? undefined : status.catalog;
        var models = catalog !== undefined && Array.isArray(catalog.models) ? catalog.models : undefined;

        /** 勾选/取消：重算禁用名单后整份写回。 */
        function toggle(id, nextOn) {
          if (models === undefined) return;
          var disabled = [];
          var enabledCount = 0;
          models.forEach(function (model) {
            var on = model.id === id ? nextOn : model.enabled !== false;
            if (on) enabledCount += 1;
            else disabled.push(model.id);
          });
          // 界面上最后一行也点不动了，这里再挡一次是因为快照可能比界面新。
          if (enabledCount === 0) {
            props.setNotice(t('modelsKeepOne'));
            return;
          }
          void perform('settings', { patch: { disabledModels: disabled } }, function () {
            return '';
          });
        }

        var body;
        if (models === undefined) {
          body = h('div', { className: 'dsr-empty' }, t('modelsEmpty'));
        } else if (models.length === 0) {
          body = h('div', { className: 'dsr-empty' }, t('modelsEmpty'));
        } else {
          var rows = models.map(function (model) {
            var k = contextK(model.contextWindow);
            return h(
              'tr',
              { key: model.id },
              h(
                'td',
                null,
                h(
                  'label',
                  { className: 'dsr-check' },
                  h('input', {
                    type: 'checkbox',
                    checked: model.enabled !== false,
                    disabled: busy,
                    onChange: function (event) {
                      toggle(model.id, event.target.checked);
                    }
                  }),
                  h(
                    'span',
                    { className: 'dsr-cell-main' },
                    h(
                      'span',
                      { className: 'dsr-name' },
                      typeof model.name === 'string' && model.name !== '' ? model.name : model.id,
                      model.vision === true ? h(Badge, null, t('modelVision')) : null,
                      model.reasoning === true ? h(Badge, null, t('modelReasoning')) : null
                    ),
                    typeof model.description === 'string' && model.description !== ''
                      ? h('span', { className: 'dsr-sub' }, model.description)
                      : h('span', { className: 'dsr-sub' }, model.id)
                  )
                )
              ),
              h(
                'td',
                null,
                typeof model.multiplier === 'string' && model.multiplier !== ''
                  ? model.multiplier
                  : h('span', { className: 'dsr-muted' }, t('modelNoMultiplier'))
              ),
              h(
                'td',
                null,
                typeof model.promo === 'string' && model.promo !== ''
                  ? h(Badge, null, model.promo)
                  : h('span', { className: 'dsr-muted' }, '—')
              ),
              h('td', null, k === undefined ? h('span', { className: 'dsr-muted' }, '—') : t('modelContext', { k: k }))
            );
          });
          body = h(
            'div',
            { className: 'dsr-scroll' },
            h(
              'table',
              { className: 'dsr-table' },
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  h('th', null, t('tabModels')),
                  h('th', null, t('colMultiplier')),
                  h('th', null, t('colPromo')),
                  h('th', null, t('colContext'))
                )
              ),
              h('tbody', null, rows)
            )
          );
        }

        return h(
          React.Fragment,
          null,
          h(Note, null, t('modelsHint')),
          h(
            Card,
            {
              title: models === undefined ? t('tabModels') : t('modelsCount', { count: credits(models.length) }),
              actions: h(
                'div',
                { className: 'dsr-toolbar' },
                h(Button, {
                  disabled: busy,
                  onClick: function () {
                    void perform('refresh', { force: true }, function () {
                      return '';
                    });
                  }
                }, t('refresh'))
              )
            },
            catalog === undefined
              ? null
              : h(
                  'div',
                  { className: 'dsr-toolbar' },
                  h('span', { className: 'dsr-sub' }, t('modelsSourceLine', { source: t(catalogSourceKey(catalog.source)) })),
                  typeof catalog.fetchedAtMs === 'number'
                    ? h('span', { className: 'dsr-sub' }, t('modelsFetchedAt', { time: clock(catalog.fetchedAtMs) }))
                    : null
                ),
            catalog !== undefined && catalog.error !== null && catalog.error !== undefined
              ? h(Note, { tone: 'warn' }, t('catalogError', { message: errorText(t, catalog.error) }))
              : null,
            body
          )
        );
      }

      /**
       * 登录 tab：按 `login.phase` 渲染契约 §四 的八种状态。
       *
       * 只有 `running=true` 时才起 1000ms 的 `login-status` 轮询；`done` 之后必须再
       * `refresh` 一次，否则账号池还是登录前的快照。
       */
      function LoginTab(props) {
        var t = props.t;
        var status = props.status;
        var busy = props.busy;
        var login = status === undefined ? undefined : status.login;
        var phase = login === undefined || login === null ? 'idle' : login.phase;
        if (typeof phase !== 'string' || phase === '') phase = 'idle';
        var running = login !== undefined && login !== null && login.running === true;
        var kind = login === undefined || login === null ? undefined : login.kind;
        var textState = React.useState('');
        var text = textState[0];
        var setText = textState[1];
        /** 上一次见到的相位；只在「刚变成 done」那一刻刷新账号池。 */
        var previousPhaseRef = React.useRef(phase);

        /**
         * `running` 期间每 1000ms 问一次相位。
         *
         * 依赖里放 `running` 与 `phase`：相位前进也要重挂定时器，否则 `exchanging`
         * 到 `done` 的那一步会漏掉，界面一直停在「正在换取」。卸载与相位变化都会
         * `abort`：晚到的响应不能写进已经翻篇的界面。
         */
        React.useEffect(function () {
          if (!running) return undefined;
          var controller = typeof AbortController === 'function' ? new AbortController() : undefined;
          var timer = setInterval(function () {
            if (controller !== undefined && controller.signal.aborted) return;
            void props.requestLoginStatus(controller === undefined ? undefined : controller.signal);
          }, LOGIN_POLL_MS);
          return function () {
            clearInterval(timer);
            if (controller !== undefined) {
              try {
                controller.abort();
              } catch (error) {
                void error;
              }
            }
          };
        }, [running, phase]);

        // 相位刚变成 done 时刷新一次状态；每 1000ms 都刷会把账号池打成请求风暴。
        React.useEffect(function () {
          var was = previousPhaseRef.current;
          previousPhaseRef.current = phase;
          if (phase !== 'done' || was === 'done') return;
          props.onLoggedIn();
        }, [phase]);

        /** 手粘授权码：提交后不本地猜测结果，一切以宿主返回的相位为准。 */
        function submitCode() {
          if (text.trim() === '') return;
          void props.perform('login-code', { text: text.trim() }, function (result) {
            if (result !== undefined && result.ok === true) setText('');
            return '';
          });
        }

        var actions = h(
          'div',
          { className: 'dsr-toolbar' },
          running
            ? h(Button, {
                disabled: busy,
                onClick: function () {
                  void props.perform('cancel-login', {}, function () {
                    return '';
                  });
                }
              }, t('loginCancel'))
            : h(
                React.Fragment,
                null,
                h(Button, {
                  tone: 'primary',
                  disabled: busy,
                  onClick: function () {
                    props.onStartLogin('web');
                  }
                }, t('loginStartWeb')),
                h(Button, {
                  disabled: busy,
                  onClick: function () {
                    props.onStartLogin('qr');
                  }
                }, t('loginStartQr'))
              )
        );

        var phaseLine;
        if (phase === 'waiting') {
          phaseLine = h(
            'div',
            { className: 'dsr-phase' },
            h(Spinner),
            h('span', null, typeof login.message === 'string' && login.message !== '' ? login.message : t('loginPhaseWaiting'))
          );
        } else if (phase === 'exchanging') {
          phaseLine = h('div', { className: 'dsr-phase' }, h(Spinner), h('span', null, t('loginPhaseExchanging')));
        } else if (phase === 'validating') {
          phaseLine = h('div', { className: 'dsr-phase' }, h(Spinner), h('span', null, t('loginPhaseValidating')));
        } else if (phase === 'done') {
          var doneAccounts = status === undefined ? undefined : status.accounts;
          var doneAccount = accountById(doneAccounts, status === undefined ? undefined : status.currentAccountId);
          phaseLine = h(
            'div',
            { className: 'dsr-phase' },
            h('span', null, t('loginPhaseDone')),
            doneAccount === undefined ? null : h('span', { className: 'dsr-sub' }, t('loginDoneAccount', { label: accountLabel(t, doneAccount) }))
          );
        } else if (phase === 'expired') {
          phaseLine = h('div', { className: 'dsr-phase' }, h('span', { className: 'dsr-bad' }, t('loginPhaseExpired')));
        } else if (phase === 'cancelled') {
          phaseLine = h('div', { className: 'dsr-phase' }, h('span', { className: 'dsr-muted' }, t('loginPhaseCancelled')));
        } else if (phase === 'error') {
          var err = login === undefined ? undefined : login.error;
          phaseLine = h(
            'div',
            { className: 'dsr-phase' },
            h('span', { className: 'dsr-bad' }, t('loginPhaseError')),
            h('span', null, err === undefined || err === null ? '—' : errorText(t, err))
          );
        } else {
          phaseLine = h('div', { className: 'dsr-phase' }, h('span', { className: 'dsr-muted' }, t('loginPhaseIdle')));
        }

        return h(
          React.Fragment,
          null,
          h(Note, null, kind === 'qr' ? t('loginHintQr') : t('loginHintWeb')),
          h(Card, { title: kind === undefined ? t('tabLogin') : t(kind === 'qr' ? 'loginKindQr' : 'loginKindWeb'), actions: actions },
            phaseLine,
            // 授权码是一次性的：过期与 code-expired 都只能重新发起，所以要区别提示。
            phase === 'expired'
              ? h(Note, { tone: 'warn' }, t('loginRestartHint'))
              : phase === 'error' && login !== undefined && login.error !== undefined && login.error !== null && login.error.code === 'code-expired'
                ? h(Note, { tone: 'warn' }, t('loginRestartHint'))
                : null,
            typeof (login === undefined ? undefined : login.expiresAtMs) === 'number'
              ? h(Note, null, t('loginExpiresAt', { time: clock(login.expiresAtMs) }))
              : null,
            // 二维码是内容不是样式：宿主给的是完整内联 <svg>，只能原样填进容器。
            kind === 'qr' && typeof (login === undefined ? undefined : login.qrSvg) === 'string' && login.qrSvg !== ''
              ? h('div', { className: 'dsr-qr', dangerouslySetInnerHTML: { __html: login.qrSvg } })
              : kind === 'qr' && running
                ? h('div', { className: 'dsr-empty' }, t('loginQrMissing'))
                : null,
            // web 分支的链接用 <a> 而不是 window.open：新标签页由浏览器决定，
            // 也能被宿主的内容安全策略正常放行。
            kind === 'web' && typeof (login === undefined ? undefined : login.url) === 'string' && login.url !== ''
              ? h(
                  'div',
                  { className: 'dsr-toolbar' },
                  h(
                    'a',
                    { className: 'dsr-link', href: login.url, target: '_blank', rel: 'noreferrer noopener' },
                    t('loginOpenAuthorize')
                  )
                )
              : null
          ),
          kind === 'qr'
            ? null
            : h(
                Card,
                { title: t('loginPasteTitle') },
                h('div', { className: 'dsr-field' },
                  h('span', { className: 'dsr-field-label' }, t('loginPasteLabel')),
                  h('textarea', {
                    className: 'dsr-textarea',
                    placeholder: t('loginPastePlaceholder'),
                    value: text,
                    onChange: function (event) {
                      setText(event.target.value);
                    }
                  })
                ),
                h(
                  'div',
                  { className: 'dsr-toolbar' },
                  h(Button, { tone: 'primary', disabled: busy || text.trim() === '', onClick: submitCode }, t('loginSubmitCode'))
                )
              )
        );
      }

      /**
       * 诊断 tab：只读地摊开桌面端探测、生效账号与换号记录。
       *
       * 这里也是「关闭轮询」开关的唯一入口：读不到账号时第一步要确认的是
       * 界面到底还问不问宿主，所以开关必须贴着这些探测字段放。
       */
      function DiagnosticsTab(props) {
        var t = props.t;
        var status = props.status;
        var desktop = status === undefined ? undefined : status.desktop;
        var accounts = status === undefined || !Array.isArray(status.accounts) ? [] : status.accounts;
        var pool = status === undefined ? undefined : status.pool;
        var failover = pool === undefined || pool === null ? undefined : pool.lastFailover;
        var effective = accountById(accounts, status === undefined ? undefined : status.effectiveAccountId);
        var chosen = accountById(accounts, status === undefined ? undefined : status.currentAccountId);
        var pollingOn = props.pollingOn === true;

        /** 布尔三元：`undefined` 不当作 false 印出来，读不到就说读不到。 */
        function boolText(value) {
          if (value === true) return t('yes');
          if (value === false) return t('no');
          return '—';
        }

        var desktopRows = desktop === undefined
          ? [h(Kv, { key: 'none', label: t('diagDesktopState') }, t('diagNoDesktop'))]
          : [
              h(Kv, { key: 'detected', label: t('diagDesktopState') },
                desktop.detected === true ? t('diagDesktopDetected') : t('diagDesktopMissing')),
              h(Kv, { key: 'authPath', label: t('diagAuthPath') }, typeof desktop.authPath === 'string' ? desktop.authPath : '—'),
              h(Kv, { key: 'configDir', label: t('diagConfigDir') }, typeof desktop.configDir === 'string' ? desktop.configDir : '—'),
              h(Kv, { key: 'exists', label: t('diagExists') }, boolText(desktop.exists)),
              h(Kv, { key: 'readable', label: t('diagReadable') }, boolText(desktop.readable)),
              h(Kv, { key: 'reason', label: t('diagReason') },
                desktop.reason === null || desktop.reason === undefined
                  ? '—'
                  : t(reasonKey(desktop.reason))),
              h(Kv, { key: 'keyOrder', label: t('diagKeyOrder') }, boolText(desktop.keyOrderMatchesApp)),
              h(Kv, { key: 'multi', label: t('diagMultiAccount') },
                desktop.multiAccount === true ? t('yes') : t('diagMultiAccountNo')),
              h(Kv, { key: 'adopted', label: t('diagAdopted') }, boolText(desktop.adopted)),
              typeof desktop.nickname === 'string' && desktop.nickname !== ''
                ? h(Kv, { key: 'nickname', label: t('diagNickname') }, desktop.nickname)
                : null,
              typeof desktop.expiresAtMs === 'number'
                ? h(Kv, { key: 'expires', label: t('diagExpires') }, clock(desktop.expiresAtMs))
                : null
            ];

        return h(
          React.Fragment,
          null,
          h(Note, null, t('diagHint')),
          h(Card, { title: t('diagDesktop') },
            desktop !== undefined && desktop.detected !== true
              ? h(Note, { tone: 'warn' }, t('diagNoDesktop'))
              : null,
            h('div', { className: 'dsr-kv' }, desktopRows)
          ),
          h(Card, { title: t('diagRuntime') },
            h(
              'div',
              { className: 'dsr-kv' },
              h(Kv, { key: 'version', label: t('diagVersion') }, status === undefined || status.version === undefined ? '—' : String(status.version)),
              h(Kv, { key: 'schema', label: t('diagSchema') }, status === undefined || status.schemaVersion === undefined ? '—' : String(status.schemaVersion)),
              h(Kv, { key: 'provider', label: t('diagProvider') }, status === undefined ? '—' : String(status.provider === undefined ? PROVIDER_ID : status.provider)),
              h(Kv, { key: 'updated', label: t('diagUpdated') }, status === undefined ? '—' : clock(status.updatedAtMs)),
              h(Kv, { key: 'accounts', label: t('diagAccounts') }, credits(accounts.length)),
              h(Kv, { key: 'current', label: t('diagCurrent') }, chosen === undefined ? '—' : accountLabel(t, chosen)),
              h(Kv, { key: 'effective', label: t('diagEffective') }, effective === undefined ? '—' : accountLabel(t, effective)),
              h(Kv, { key: 'effectiveReason', label: t('diagEffectiveReason') },
                status === undefined || typeof status.effectiveReason !== 'string' || status.effectiveReason === ''
                  ? '—'
                  : status.effectiveReason),
              h(Kv, { key: 'pool', label: t('diagPool') },
                pool === undefined ? '—' : pool.enabled === true ? t('poolOn') : t('poolOff')),
              h(Kv, { key: 'failover', label: t('diagLastFailover') },
                failover === undefined || failover === null
                  ? t('lastFailoverNone')
                  : t('lastFailoverLine', {
                      from: typeof failover.fromId === 'string' ? failover.fromId : '—',
                      to: typeof failover.toId === 'string' ? failover.toId : '—',
                      reason: typeof failover.reason === 'string' && failover.reason !== '' ? failover.reason : t('reasonUnknown')
                    })),
              h(Kv, { key: 'checkin', label: t('diagCheckin') },
                status === undefined || status.checkin === undefined || status.checkin === null
                  ? '—'
                  : clock(status.checkin.lastRunAtMs)),
              h(Kv, { key: 'polling', label: t('diagPolling') },
                pollingOn ? t('diagPollingOn') : t('diagPollingOff'))
            ),
            h(
              'div',
              { className: 'dsr-toolbar' },
              h(Button, {
                onClick: function () {
                  props.onSetPolling(!pollingOn);
                }
              }, pollingOn ? t('diagPollingStop') : t('diagPollingResume')),
              h(Button, {
                disabled: props.busy,
                onClick: function () {
                  void props.perform('refresh', { force: true }, function () {
                    return '';
                  });
                }
              }, t('refresh'))
            )
          )
        );
      }

      /**
       * 设置页外壳：四个 tab 共用一次 store 订阅与一个动作包装。
       *
       * `perform` 只负责置忙与把错误写成一行提示；重读状态由动作自己的返回驱动，
       * 因为有些动作（`login-web`、`test-account`）成功时并不改状态文档。
       */
      function SettingsSection(props) {
        var t = props.t;
        var state = useStatus();
        var status = state[0];
        var reload = state[1];
        var busyState = React.useState(false);
        var busy = busyState[0];
        var setBusy = busyState[1];
        var noticeState = React.useState('');
        var notice = noticeState[0];
        var setNotice = noticeState[1];
        var tabState = React.useState('accounts');
        var activeTab = tabState[0];
        var setActiveTab = tabState[1];
        var pollingState = React.useState(true);
        var pollingOn = pollingState[0];
        var setPollingState = pollingState[1];

        /**
         * 统一包装：置忙、发动作、把错误转成一行提示。
         *
         * 信封里带 `status`/`login` 的已由 {@link act} 铺进快照；剩下的动作
         * （签到、导入导出、测试、手粘码）只回业务结果，需要再读一次状态。
         */
        function perform(action, body, describe) {
          setBusy(true);
          return act(action, body).then(function (result) {
            // `ok:false` 不一定带 error：`test-account` 探测不通过、`login-code` 授权码
            // 过期都只是「结果不理想」，它们的业务数据（probe / login）仍然要显示。
            var failed = result !== undefined && result.ok === false;
            var hasError = failed && result.error !== undefined && result.error !== null;
            if (hasError) setNotice(errorText(t, result.error));
            else setNotice(typeof describe === 'function' ? describe(result) || '' : '');
            setBusy(false);
            if (
              result !== undefined && result.ok === true &&
              result.status === undefined && result.login === undefined
            ) {
              void loadStatus();
            }
            return result;
          });
        }

        /** 起一个登录会话：宿主回 `login` 文档，相位从下一次轮询开始推进。 */
        function onStartLogin(kind) {
          var action = kind === 'qr' ? 'login-qr' : 'login-web';
          setActiveTab('login');
          void perform(action, {}, function () {
            return '';
          });
        }

        var tabs = [
          { key: 'accounts', label: 'tabAccounts' },
          { key: 'models', label: 'tabModels' },
          { key: 'login', label: 'tabLogin' },
          { key: 'diag', label: 'tabDiag' }
        ];
        /** tab 内部 id → 文案键。切分 id 与文案键，`t()` 只收文案键，不收路由名。 */
        var TAB_LABEL_KEYS = {
          accounts: 'tabAccounts',
          models: 'tabModels',
          login: 'tabLogin',
          diag: 'tabDiag'
        };

        /** 一个 tab 面板；`hidden` 而不是卸载，切回来时表单内容还在。 */
        function panel(key, children) {
          return h(
            'div',
            { className: 'dsr-panel', role: 'tabpanel', 'aria-label': t(TAB_LABEL_KEYS[key]), hidden: activeTab !== key },
            children
          );
        }

        var accounts = status === undefined || !Array.isArray(status.accounts) ? undefined : status.accounts;
        var currentAccount = accountById(accounts, status === undefined ? undefined : status.currentAccountId);
        var version = status === undefined || status.version === undefined ? '' : 'v' + String(status.version);
        var schemaTooNew =
          status !== undefined && typeof status.schemaVersion === 'number' && status.schemaVersion > KNOWN_SCHEMA_VERSION;

        return h(
          'div',
          { className: 'dsr-root', 'data-raccoon-settings': true },
          h(
            'div',
            { className: 'dsr-head' },
            h(
              'div',
              { className: 'dsr-heading' },
              h(SectionIcon, { size: 28, active: true }),
              h('h2', { className: 'dsr-title' }, t('title')),
              h('span', { className: 'dsr-version' }, version)
            ),
            h('p', { className: 'dsr-desc' }, t('subtitle')),
            currentAccount === undefined
              ? null
              : h('p', { className: 'dsr-desc' }, t('effectiveLine', { label: accountLabel(t, currentAccount) }))
          ),
          status === undefined
            ? h(Note, { tone: 'warn' }, t('statusUnavailable'))
            : null,
          schemaTooNew ? h(Note, { tone: 'warn' }, t('olderSchema')) : null,
          notice === '' ? null : h(Note, null, notice),
          h(
            'div',
            { className: 'dsr-tabs', role: 'tablist' },
            tabs.map(function (tab) {
              return h(
                'button',
                {
                  key: tab.key,
                  type: 'button',
                  role: 'tab',
                  className: 'dsr-tab',
                  'data-active': String(activeTab === tab.key),
                  'aria-selected': activeTab === tab.key,
                  onClick: function () {
                    setActiveTab(tab.key);
                  }
                },
                t(tab.label)
              );
            })
          ),
          panel('accounts', h(AccountsTab, {
            t: t,
            status: status,
            busy: busy,
            perform: perform,
            setBusy: setBusy,
            setNotice: setNotice,
            onStartLogin: onStartLogin
          })),
          panel('models', h(ModelsTab, {
            t: t,
            status: status,
            busy: busy,
            perform: perform,
            setNotice: setNotice
          })),
          panel('login', h(LoginTab, {
            t: t,
            status: status,
            busy: busy,
            perform: perform,
            onStartLogin: onStartLogin,
            onLoggedIn: reload,
            requestLoginStatus: function (signal) {
              return act('login-status', {}, signal === undefined ? undefined : { signal: signal });
            }
          })),
          panel('diag', h(DiagnosticsTab, {
            t: t,
            status: status,
            busy: busy,
            perform: perform,
            pollingOn: pollingOn,
            onSetPolling: function (next) {
              setPollingState(next);
              setPolling(next);
              reload();
            }
          }))
        );
      }

      /** 设置页图标：一只浣熊的简化轮廓（内联 SVG，经典脚本里没有资源管线）。 */
      function SectionIcon(props) {
        var size = typeof props.size === 'number' ? props.size : 16;
        return h(
          'svg',
          {
            width: size,
            height: size,
            viewBox: '0 0 24 24',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 2,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': true,
            style: { flexShrink: 0, color: props.active === true ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)' }
          },
          h('path', { d: 'M4 10a3 3 0 1 1 4.6-3.8h6.8A3 3 0 1 1 20 10v4a6 6 0 0 1-6 6h-4a6 6 0 0 1-6-6z' }),
          h('circle', { cx: '9.5', cy: '12', r: '1' }),
          h('circle', { cx: '14.5', cy: '12', r: '1' }),
          h('path', { d: 'M12 14.5v1.5' })
        );
      }

      /**
       * 输入框左侧的积分胶囊（`conversation.input.left`）。
       *
       * 读数取「手选账号 → 实际生效账号 → 第一条有余额的」，因为池开启时用户看到的
       * 余额应当是下一次请求会花掉的那份。点开是逐账号余额 + 一键切换。
       */
      function CreditPill(props) {
        var t = props.t;
        var state = useStatus();
        var status = state[0];
        var openState = React.useState(false);
        var open = openState[0];
        var setOpen = openState[1];
        var busyState = React.useState(false);
        var busy = busyState[0];
        var setBusy = busyState[1];
        var total = pillTotal(status);
        var accounts = status === undefined || !Array.isArray(status.accounts) ? [] : status.accounts;
        var currentId = status === undefined ? undefined : status.currentAccountId;

        /**
         * 点胶囊外面收起下拉。
         *
         * 只在真正展开时挂监听，收起来立刻摘掉：输入框旁边常驻一个 document 级
         * 监听会让每一次点击都过一遍这里。
         */
        React.useEffect(function () {
          if (!open) return undefined;
          function onDoc(event) {
            // 事件目标可能是文本节点，`closest` 不一定存在；不拦就等于点一下就关。
            var target = event.target;
            if (target !== null && target !== undefined && typeof target.closest === 'function' && target.closest('[data-raccoon-pill]') !== null) return;
            setOpen(false);
          }
          document.addEventListener('mousedown', onDoc);
          return function () {
            document.removeEventListener('mousedown', onDoc);
          };
        }, [open]);

        function switchTo(id) {
          if (id === currentId) {
            setOpen(false);
            return;
          }
          setBusy(true);
          void act('switch-account', { accountId: id }).then(function (result) {
            return loadStatus().then(function () {
              setBusy(false);
              if (result === undefined || result.ok !== false) setOpen(false);
            });
          });
        }

        var rows = accounts.map(function (account) {
          var rowTotal = pick(account, ['credits', 'total']);
          return h(
            'div',
            { key: account.id, className: 'dsr-pop-row' },
            h(
              'span',
              { className: 'dsr-pop-name' },
              h('span', null, accountLabel(t, account)),
              typeof account.expiresAtMs === 'number'
                ? h('span', { className: 'dsr-sub' }, t('pillExpiresAt', { time: clock(account.expiresAtMs) }))
                : null
            ),
            h(
              'span',
              { className: 'dsr-pop-value' },
              account.id === currentId ? h(Badge, null, t('pillCurrent')) : null,
              ' ',
              typeof rowTotal === 'number' ? credits(rowTotal) : t('pillUnknown'),
              account.id === currentId
                ? null
                : h(Button, { disabled: busy, onClick: function () { switchTo(account.id); } }, t('pillSwitch'))
            )
          );
        });

        return h(
          'div',
          { className: 'dsr-pill', 'data-raccoon-pill': true },
          h(
            'button',
            {
              type: 'button',
              className: 'dsr-pill-btn',
              title: t('pillTitle'),
              onClick: function () {
                setOpen(!open);
              }
            },
            typeof total === 'number' ? t('pillValue', { name: t('pillName'), total: credits(total) }) : t('pillValue', { name: t('pillName'), total: t('pillUnknown') })
          ),
          open
            ? h(
                'div',
                { className: 'dsr-pop' },
                h(
                  'div',
                  { className: 'dsr-pop-head' },
                  h('span', null, t('pillBalance')),
                  typeof total === 'number' ? h('span', null, credits(total)) : h('span', null, t('pillUnknown'))
                ),
                accounts.length === 0 ? h('div', { className: 'dsr-empty' }, t('pillNoAccounts')) : rows,
                accounts.length === 0 ? null : h('div', { className: 'dsr-sub' }, t('pillSwitchHint'))
              )
            : null
        );
      }

      /**
       * 胶囊的门控：只在当前 provider 是 `raccoon` 时整块渲染。
       *
       * 宿主没给投影时照常显示 —— 「我不知道」不该等于「藏起来」。
       */
      function CreditPillGate(props) {
        var next;
        try {
          var projection =
            typeof props.useProjection === 'function' ? props.useProjection('modelSelection') : undefined;
          if (projection !== undefined && projection !== null) {
            next = projection.next === undefined || projection.next === null ? projection.lastUsed : projection.next;
          }
        } catch (error) {
          next = undefined;
        }
        var provider = next === undefined || next === null ? undefined : next.provider;
        if (provider !== undefined && provider !== PROVIDER_ID) return null;
        return h(CreditPill, props);
      }

      /**
       * 插件模块本体：`inject` 声明依赖的服务，`apply` 在服务就绪时注册槽位。
       *
       * `t` 在 apply 里绑定后逐层以 props 传下去，而不是让每个组件自己去 `ctx.locale`：
       * 组件是纯函数，拿不到 ctx，自己找全局会退化成隐式依赖。
       */
      function apply(ctx) {
        var namespace = BUNDLE_NAME;
        injectStyleOnce(BUNDLE_NAME + '/client.css', CSS);
        ctx.effect(function () {
          return ctx.locale.register(namespace, { zh: zh, en: en });
        }, BUNDLE_NAME + ': locale');
        var t = ctx.locale.bind(namespace);

        /**
         * 注册一个槽位。
         *
         * 内层 try/catch 不可省：`ctx.slots.inject(name, cb)` 的回调是**晚执行**的
         * （等宿主声明那个槽位），抛出的异常会被重新抛到渲染器之外，外层 try 抓不到，
         * 结果就是整页空白而控制台只有一条与本插件无关的堆栈。
         */
        function injectSlot(name, register) {
          try {
            return ctx.slots.inject(name, function () {
              try {
                return register();
              } catch (error) {
                console.error('[dsh-connect-raccoon] 槽位注册失败（' + name + '，不影响模型路由）：', error);
                return undefined;
              }
            });
          } catch (error) {
            console.error('[dsh-connect-raccoon] 槽位注入失败（' + name + '，不影响模型路由）：', error);
            return undefined;
          }
        }

        // 设置页侧栏入口；id 同时驱动侧栏过滤与图标匹配，order 挑 60 排在官方页之后。
        injectSlot('settings.section', function () {
          return ctx.slots.register(
            {
              name: 'settings.section',
              id: SECTION_ID,
              order: 60,
              label: function () {
                return t('navLabel');
              },
              locale: namespace,
              inject: function () {
                return { t: t };
              }
            },
            SettingsSection
          );
        });

        // 侧栏图标：id 必须等于 section 的 id，props 是 `{ size, active }`。
        injectSlot('settings.section.icon', function () {
          return ctx.slots.register(
            {
              name: 'settings.section.icon',
              id: SECTION_ID,
              locale: namespace
            },
            SectionIcon
          );
        });

        // 输入框左侧的积分胶囊：坐在模型选择器旁边，与「这个 provider 在用」同一位置。
        injectSlot('conversation.input.left', function () {
          return ctx.slots.register(
            {
              name: 'conversation.input.left',
              id: BUNDLE_NAME + '-credits',
              order: 4,
              locale: namespace,
              inject: function () {
                return { t: t };
              }
            },
            CreditPillGate
          );
        });

        // 插件卸载/停用时不留下定时器与在途请求；快照也丢掉，换插件后不要看到旧读数。
        ctx.effect(function () {
          return function () {
            stopTicker();
            abortInflight();
            listeners.clear();
            snapshot = undefined;
          };
        }, BUNDLE_NAME + ': store');
      }

      return {
        name: BUNDLE_NAME,
        inject: ['slots', 'locale'],
        apply: apply
      };
    }
  });
})();
