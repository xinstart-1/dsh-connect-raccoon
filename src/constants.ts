/**
 * 小浣熊（SenseTime Raccoon）协议常量。
 *
 * 每一项都有取证来源，见 `docs/PROTOCOL.md`；本文件是**唯一**定义处，
 * 浏览器半侧硬编码的那几个路径必须与这里逐字一致（`scripts/check-client.mjs` 会校验）。
 *
 * @module dsh-connect-raccoon/constants
 */

/** DSH provider 路由键；同时是 pi-ai collection 的 key。 */
export const PROVIDER = 'raccoon';

/** 插件版本号（卡片与日志显示）。与 `package.json` 的 `version` 一致，由 gate 校验。 */
export const VERSION = '0.0.1';

/** 设置页命名空间（插件设置卡片的挂载点）。 */
export const SETTINGS_NS = 'raccoon';

/** 主站与网关同源；换测试环境时才需要改。 */
export const SITE_ORIGIN = 'https://xiaohuanxiong.com';

/**
 * OpenAI 兼容的 LLM 网关。
 *
 * 对话是 `POST {LLM_BASE}/chat/completions`，目录是 `GET {LLM_BASE}/model_catalog`。
 * 两者都认 `Authorization: Bearer <access token>`，实测假 token 回
 * `401 {"code":200003,"message":"authorization_verify_error"}`（见 `docs/evidence/`）。
 */
export const LLM_BASE = `${SITE_ORIGIN}/api/web/llm/v2`;

/** 业务鉴权 API：刷新令牌、换授权码、账号资料。 */
export const AUTH_BASE = `${SITE_ORIGIN}/api/web/auth/v1`;

/** IAM API：微信小程序扫码登录的创码与轮询。 */
export const IAM_BASE = `${SITE_ORIGIN}/api/iam/v1`;

/** 积分域：余额、账单、每日签到。 */
export const POINTS_BASE = `${SITE_ORIGIN}/api/web/points/v1`;

/** 授权页（`/code/authorize` 会 307 到这里，两条都可用）。 */
export const AUTHORIZE_PATH = '/authorize';

/** 本地回环回调路径；授权页对它的形状有硬校验（`^http://127\.0\.0\.1:[1-9][0-9]{3,4}/auth/callback$`）。 */
export const CALLBACK_PATH = '/auth/callback';

/** 授权页里显示的应用名；影响用户在授权页看到的提示文案。 */
export const AUTHORIZE_APP_NAME = 'DSH DeepSeek Harness';

/** 授权页 `login_source`：desktop 分支才会走回环回调。 */
export const LOGIN_SOURCE = 'desktop';

/** 让授权页把授权码投递到本地回环地址的那个参数值（只接受这一个字面量）。 */
export const DESKTOP_CALLBACK = 'loopback';

/** 二维码内容里的小程序应用名，与官方网页逐字相同。 */
export const QR_APP_NAME = '商汤小浣熊';


/**
 * 桌面端写的客户端版本号。
 *
 * 上游按这个头区分通道；桌面端自身从安装树的 `version` 文件读，这里取一个
 * 实测可用的固定值即可 —— 它不参与任何鉴权判定，只影响用量页的客户端标记。
 */
export const CLIENT_VERSION = 'v1.0.35';

/** 默认语言头。 */
export const CLIENT_LANGUAGE = 'zh-CN';

/** 单次上游请求的默认超时（对话另有 SSE 空闲超时）。 */
export const REQUEST_TIMEOUT_MS = 45_000;

/** SSE 空闲超时：这么久没有新帧就认为流断了。 */
export const STREAM_IDLE_TIMEOUT_MS = 180_000;

/** access token 提前多久刷新（桌面端 3 小时有效，留足余量）。 */
export const REFRESH_EARLY_MS = 5 * 60 * 1000;

/** 刷新被 429 限流后的冷却时长（上游刷新端点会限流）。 */
export const REFRESH_COOLDOWN_MS = 10 * 60 * 1000;

/** 登录会话超时：授权码与二维码本身都是 300 秒，留出换 token 的余量。 */
export const LOGIN_TIMEOUT_MS = 6 * 60 * 1000;

/** 目录缓存时长。 */
export const CATALOG_TTL_MS = 10 * 60 * 1000;

/** 积分缓存时长（余额是只读的，但没必要每次开卡片都问一遍）。 */
export const CREDITS_TTL_MS = 2 * 60 * 1000;

/** 二维码轮询的下限与上限（服务端给 `poll_interval`，这里夹取防呆）。 */
export const QR_POLL_MIN_MS = 1_000;
/** 见 {@link QR_POLL_MIN_MS}。 */
export const QR_POLL_MAX_MS = 10_000;

/** 状态路由（浏览器半侧硬编码，改这里必须同步改 `src/client/bundle.js`）。 */
export const STATUS_PATH = '/plugins/dsh-connect-raccoon/status';
/** 动作路由（同上）。 */
export const ACTION_PATH = '/plugins/dsh-connect-raccoon/action';


/** 账本目录名（`$DSH_HOME` 下，与 `workbuddy-vault` / `lingxi-vault` 同级）。 */
export const VAULT_DIRNAME = 'raccoon-vault';

/** 插件状态文件名。 */
export const STATE_FILENAME = 'dsh-connect-raccoon-state.json';

/** 桌面端凭据目录（相对家目录）；`BOX_AGENT_CONFIG_DIR` 可整体覆盖。 */
export const DESKTOP_CONFIG_DIRNAME = '.box-agent/config';

/** 桌面端凭据文件名。 */
export const DESKTOP_AUTH_FILENAME = 'auth.json';

/**
 * 桌面端 `auth.json` 的键序。
 *
 * 写回时必须保持这个顺序：App 自己按 `JSON.stringify` 的插入序 diff，
 * 乱序会在它那边产生无意义的文件变更。
 */
export const DESKTOP_TOKEN_KEYS = [
  'access_token',
  'refresh_token',
  'office_identity',
  'office_org_name',
  'office_org_role',
] as const;

/** 图片请求预算，与 `dsh-llm-pi-ai` 的默认值一致。 */
export const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
  maxRequestImages: 8,
  imageOffloadCountQuantum: 4,
} as const;
