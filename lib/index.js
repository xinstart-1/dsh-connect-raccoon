import { spawn } from "node:child_process";
import z from "@deepseek-ai/schemastery";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path, { dirname, join, resolve } from "node:path";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
// src/config.ts
/**
* 插件配置：用户在设置页 / `cordis.patch.yml` 里填的东西。
*
* 默认值只写在 schema 里，`apply` 内不再兜底 —— 两份默认值就是两次真相。
*
* @module dsh-connect-raccoon/config
*/
/** 配置 schema 与默认值。 */
const Config = z.object({
	/** 是否启用小浣熊路由（关掉即从模型选择器里撤掉）。 */
	enabled: z.boolean().description("在 DSH 模型选择器里启用商汤小浣熊。").default(true),
	/** 主站地址；只有换测试环境时才需要改。 */
	siteOrigin: z.string().description("小浣熊主站。留空用内置 https://xiaohuanxiong.com，只有测试环境需要改。").default(""),
	/**
	* 复用本机桌面端的登录态。
	*
	* 关掉后插件只用自己的账号池，一个字节都不碰桌面端文件。
	*/
	reuseDesktop: z.boolean().description("自动读取本机小浣熊桌面端的登录态（只读复用；令牌轮转时会原子写回）。").default(true),
	/**
	* 允许把轮转后的令牌写回桌面端文件。
	*
	* 关掉 = 纯只读：刷新令牌只更插件自己的副本，桌面端会因 `refresh_conflict`
	* 被登出一次，所以要由用户显式选择。
	*/
	writeBackDesktop: z.boolean().description("刷新令牌后把轮转结果写回桌面端 auth.json（不写回会导致客户端下次刷新冲突掉登录）。").default(true),
	/** 启动时预热一次目录与账号状态。 */
	warmOnStart: z.boolean().description("插件启动时预拉一次模型目录与账号状态，让卡片与选择器更快显示真实数据。").default(true),
	/** 默认思考档位（模型未声明时兜底）。 */
	defaultReasoningEffort: z.string().description("默认思考档位：off / low / medium / high / max。留空沿用上游默认。").default(""),
	/**
	* 换号时的最大尝试次数。
	*
	* 上限存在是为了「一个都不通时不把整池账号轮流打一遍」：那既慢又会把
	* 一池账号全打进限流。
	*/
	maxFailoverAttempts: z.number().description("一次请求最多换几个账号重试（1 表示不换号）。").default(3)
});
Config({});
// src/constants.ts
/**
* 小浣熊（SenseTime Raccoon）协议常量。
*
* 每一项都有取证来源，见 `docs/PROTOCOL.md`；本文件是**唯一**定义处，
* 浏览器半侧硬编码的那几个路径必须与这里逐字一致（`scripts/check-client.mjs` 会校验）。
*
* @module dsh-connect-raccoon/constants
*/
/** DSH provider 路由键；同时是 pi-ai collection 的 key。 */
const PROVIDER = "raccoon";
/** 插件版本号（卡片与日志显示）。与 `package.json` 的 `version` 一致，由 gate 校验。 */
const VERSION = "0.0.1";
/** 设置页命名空间（插件设置卡片的挂载点）。 */
const SETTINGS_NS = "raccoon";
/** 主站与网关同源；换测试环境时才需要改。 */
const SITE_ORIGIN = "https://xiaohuanxiong.com";
/** 授权页（`/code/authorize` 会 307 到这里，两条都可用）。 */
const AUTHORIZE_PATH = "/authorize";
/** 本地回环回调路径；授权页对它的形状有硬校验（`^http://127\.0\.0\.1:[1-9][0-9]{3,4}/auth/callback$`）。 */
const CALLBACK_PATH = "/auth/callback";
/** 授权页里显示的应用名；影响用户在授权页看到的提示文案。 */
const AUTHORIZE_APP_NAME = "DSH DeepSeek Harness";
/** 授权页 `login_source`：desktop 分支才会走回环回调。 */
const LOGIN_SOURCE = "desktop";
/** 让授权页把授权码投递到本地回环地址的那个参数值（只接受这一个字面量）。 */
const DESKTOP_CALLBACK = "loopback";
/** 二维码内容里的小程序应用名，与官方网页逐字相同。 */
const QR_APP_NAME = "商汤小浣熊";
/**
* 桌面端写的客户端版本号。
*
* 上游按这个头区分通道；桌面端自身从安装树的 `version` 文件读，这里取一个
* 实测可用的固定值即可 —— 它不参与任何鉴权判定，只影响用量页的客户端标记。
*/
const CLIENT_VERSION = "v1.0.35";
/** 默认语言头。 */
const CLIENT_LANGUAGE = "zh-CN";
/** 单次上游请求的默认超时（对话另有 SSE 空闲超时）。 */
const REQUEST_TIMEOUT_MS = 45e3;
/** SSE 空闲超时：这么久没有新帧就认为流断了。 */
const STREAM_IDLE_TIMEOUT_MS = 18e4;
/** 刷新被 429 限流后的冷却时长（上游刷新端点会限流）。 */
const REFRESH_COOLDOWN_MS = 6e5;
/** 登录会话超时：授权码与二维码本身都是 300 秒，留出换 token 的余量。 */
const LOGIN_TIMEOUT_MS = 36e4;
/** 二维码轮询的下限与上限（服务端给 `poll_interval`，这里夹取防呆）。 */
const QR_POLL_MIN_MS = 1e3;
/** 见 {@link QR_POLL_MIN_MS}。 */
const QR_POLL_MAX_MS = 1e4;
/** 状态路由（浏览器半侧硬编码，改这里必须同步改 `src/client/bundle.js`）。 */
const STATUS_PATH = "/plugins/dsh-connect-raccoon/status";
/** 动作路由（同上）。 */
const ACTION_PATH = "/plugins/dsh-connect-raccoon/action";
/** 账本目录名（`$DSH_HOME` 下，与 `workbuddy-vault` / `lingxi-vault` 同级）。 */
const VAULT_DIRNAME = "raccoon-vault";
/** 插件状态文件名。 */
const STATE_FILENAME = "dsh-connect-raccoon-state.json";
/** 桌面端凭据目录（相对家目录）；`BOX_AGENT_CONFIG_DIR` 可整体覆盖。 */
const DESKTOP_CONFIG_DIRNAME = ".box-agent/config";
/** 桌面端凭据文件名。 */
const DESKTOP_AUTH_FILENAME = "auth.json";
/**
* 桌面端 `auth.json` 的键序。
*
* 写回时必须保持这个顺序：App 自己按 `JSON.stringify` 的插入序 diff，
* 乱序会在它那边产生无意义的文件变更。
*/
const DESKTOP_TOKEN_KEYS = [
	"access_token",
	"refresh_token",
	"office_identity",
	"office_org_name",
	"office_org_role"
];
/** 图片请求预算，与 `dsh-llm-pi-ai` 的默认值一致。 */
const REQUEST_IMAGE_BUDGETS = {
	maxRequestImageBytes: 20971520,
	requestImagePixelBudget: 4194304,
	requestImageMaxBytes: 1048576,
	maxRequestImages: 8,
	imageOffloadCountQuantum: 4
};
// src/state.ts
/**
* 插件自己的状态文件：界面偏好与账号池开关。
*
* 为什么不用 DSH 的 settings：这些是「点一下立即生效、不经过保存」的开关。
* 写进 settings 意味着每次改都要过一遍「改配置 → 重载插件」。所以它们落在
* 一个自己的 JSON 文件里，读写都只碰它。
*
* 位置：`$DSH_HOME/dsh-connect-raccoon-state.json`；写盘走「临时文件 + rename」，
* 读到坏 JSON 会被当成默认值（那不会有害，但读到半个 JSON 会让用户以为设置全丢了）。
*
* @module dsh-connect-raccoon/state
*/
/** 状态刷新间隔的五档（1 / 5 / 10 / 30 / 60 分钟）。 */
const POLL_INTERVAL_CHOICES = Object.freeze([
	6e4,
	3e5,
	6e5,
	18e5,
	36e5
]);
/** 缺省状态。 */
const DEFAULT_STATE = Object.freeze({
	schemaVersion: 1,
	disabledModels: [],
	accountPoolEnabled: false,
	enabledAccounts: [],
	composerPill: true,
	pollIntervalMs: 6e4,
	autoCheckin: false
});
/** 状态文件路径。 */
function statePath(home) {
	return join(home, STATE_FILENAME);
}
/** 解析 DSH home：`$DSH_HOME` 优先，否则 `~/.dsh`。 */
function dshHome(env = process.env) {
	const configured = env["DSH_HOME"];
	return typeof configured === "string" && configured.trim() !== "" ? configured.trim() : join(homedir(), ".dsh");
}
/** 把任意输入收敛成合法状态；非法字段回落到默认值而不是抛错。 */
function normalizeState(raw) {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_STATE };
	const record = raw;
	const strings = (value) => Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
	const bool = (value, fallback) => typeof value === "boolean" ? value : fallback;
	const poll = typeof record["pollIntervalMs"] === "number" ? record["pollIntervalMs"] : 0;
	return {
		schemaVersion: 1,
		disabledModels: strings(record["disabledModels"]),
		accountPoolEnabled: bool(record["accountPoolEnabled"], DEFAULT_STATE.accountPoolEnabled),
		enabledAccounts: strings(record["enabledAccounts"]),
		composerPill: bool(record["composerPill"], DEFAULT_STATE.composerPill),
		pollIntervalMs: POLL_INTERVAL_CHOICES.includes(poll) ? poll : DEFAULT_STATE.pollIntervalMs,
		autoCheckin: bool(record["autoCheckin"], DEFAULT_STATE.autoCheckin)
	};
}
/** 读状态；文件不存在或读不动都返回默认值（不抛）。 */
async function readState(options) {
	const home = options?.home ?? dshHome();
	try {
		const text = await readFile(statePath(home), "utf8");
		return normalizeState(JSON.parse(text));
	} catch {
		return { ...DEFAULT_STATE };
	}
}
/**
* 合并写入状态。
*
* 返回**合并后**的完整状态：调用方拿它更新内存副本，避免再读一次盘
* （两次读盘之间的写入会被后一次覆盖）。
*
* @param patch - 要改的字段；未提供的保持原值。
* @param options - 家目录覆盖（测试用）。
* @returns 写入后的完整状态。
*/
async function writeState(patch, options) {
	const home = options?.home ?? dshHome();
	const next = normalizeState({
		...await readState({ home }),
		...patch
	});
	const path = statePath(home);
	await mkdir(dirname(path), { recursive: true });
	const temp = `${path}.${String(process.pid)}.tmp`;
	await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, {
		encoding: "utf8",
		mode: 384
	});
	await rename(temp, path);
	return next;
}
// src/credentials/vault.ts
/**
* 保存插件账号与显式选择，凭据仅写入私有文件。
* 根目录由调用参数、DSH_HOME、用户目录依次决定。
* 每次写入使用独立临时文件，rename 后才对读者可见。
*/
/** 从稳定账号标识派生安全文件名。 */
function accountIdFor(accountKey) {
	return `acc_${createHash("sha256").update(accountKey).digest("hex").slice(0, 16)}`;
}
/** 只解码 JWT payload；格式错误返回空对象，绝不验签。 */
function decodeJwtFacts(token) {
	try {
		const segments = token.split(".");
		const payload = segments[1];
		if (segments.length !== 3 || !payload || !/^[\w-]+$/.test(payload)) return {};
		const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
		if (!isRecord(claims)) return {};
		const facts = {};
		if (typeof claims.exp === "number" && Number.isFinite(claims.exp * 1e3)) facts.expiresAtMs = claims.exp * 1e3;
		if (typeof claims.sub === "string" && claims.sub) facts.accountKey = claims.sub;
		if (typeof claims.name === "string") facts.nickname = claims.name;
		if (typeof claims.identity === "string") facts.identity = claims.identity;
		return facts;
	} catch {
		return {};
	}
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isAccount(value) {
	if (!isRecord(value) || value.schemaVersion !== 1) return false;
	if (typeof value.accountKey !== "string" || value.id !== accountIdFor(value.accountKey)) return false;
	if (!["accessToken", "refreshToken"].every((key) => typeof value[key] === "string")) return false;
	if (![
		"expiresAtMs",
		"refreshExpiresAtMs",
		"savedAtMs"
	].every((key) => typeof value[key] === "number" && Number.isFinite(value[key]))) return false;
	if (![
		"desktop",
		"web",
		"qr",
		"import"
	].includes(String(value.source))) return false;
	if (![
		"identity",
		"orgName",
		"orgRole",
		"nickname",
		"desktopPath"
	].every((key) => value[key] === void 0 || typeof value[key] === "string")) return false;
	const probe = value.probe;
	return probe === void 0 || isRecord(probe) && typeof probe.outcome === "string" && typeof probe.message === "string" && typeof probe.atMs === "number" && Number.isFinite(probe.atMs);
}
async function readJson(path) {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		return;
	}
}
async function atomicJson(path, value) {
	await mkdir(dirname(path), {
		recursive: true,
		mode: 448
	});
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
			mode: 384,
			flag: "wx"
		});
		await rename(temporary, path);
	} finally {
		await unlink(temporary).catch(() => void 0);
	}
}
async function removeFile(path) {
	try {
		await unlink(path);
		return true;
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return false;
		throw error;
	}
}
/** 创建仓库；home 为 DSH 根目录，创建时不产生磁盘写入。 */
function createVault(options = {}) {
	const root = resolve(options.home ?? (process.env.DSH_HOME || join(homedir(), ".dsh")), VAULT_DIRNAME);
	const accountsDir = join(root, "accounts");
	const selectedPath = join(root, "selected.json");
	const validId = (id) => /^acc_[a-f0-9]{16}$/.test(id);
	const get = async (id) => {
		if (!validId(id)) return void 0;
		const account = await readJson(join(accountsDir, `${id}.json`));
		return isAccount(account) && account.id === id ? account : void 0;
	};
	return {
		rootDir: () => root,
		get,
		async list() {
			let filenames;
			try {
				filenames = await readdir(accountsDir);
			} catch (error) {
				if (isRecord(error) && error.code === "ENOENT") return [];
				throw error;
			}
			return (await Promise.all(filenames.filter((name) => name.endsWith(".json")).map((name) => get(name.slice(0, -5))))).filter((account) => account !== void 0);
		},
		async save(account) {
			if (!isAccount(account)) throw new TypeError("账号记录不符合 schemaVersion 1");
			await mkdir(root, {
				recursive: true,
				mode: 448
			});
			await atomicJson(join(accountsDir, `${account.id}.json`), account);
		},
		async remove(id) {
			return validId(id) ? removeFile(join(accountsDir, `${id}.json`)) : false;
		},
		async readSelected() {
			const selection = await readJson(selectedPath);
			if (!isRecord(selection) || selection.version !== 1 || typeof selection.accountId !== "string") return void 0;
			return await get(selection.accountId) ? selection.accountId : void 0;
		},
		async writeSelected(id) {
			if (id === void 0) {
				await removeFile(selectedPath);
				return;
			}
			if (!validId(id)) throw new TypeError("账号 id 格式无效");
			await atomicJson(selectedPath, {
				version: 1,
				accountId: id
			});
		}
	};
}
// src/protocol/errors.ts
/** 小浣熊协议层的唯一错误类型。 */
var RaccoonError = class extends Error {
	/** 稳定分类码；界面与换号策略都读它。 */
	code;
	/** 上游 HTTP 状态；本地错误为 0。 */
	status;
	/** 上游业务码原文（`200035`、`user_model_rate_limited` 之类）；没有则为 `null`。 */
	upstreamCode;
	/** 这个失败是否值得换一个账号重试。 */
	retriableWithOtherAccount;
	/**
	* @param input.code - 稳定分类码。
	* @param input.message - 给用户看的中文；上游原文在未知码时保留。
	* @param input.status - 上游 HTTP 状态，本地错误省略。
	* @param input.upstreamCode - 上游业务码原文。
	* @param input.cause - 底层异常。
	*/
	constructor(input) {
		super(input.message, input.cause === void 0 ? void 0 : { cause: input.cause });
		this.name = "RaccoonError";
		this.code = input.code;
		this.status = input.status ?? 0;
		this.upstreamCode = input.upstreamCode ?? null;
		this.retriableWithOtherAccount = RETRIABLE.has(input.code);
	}
};
/**
* 哪些分类值得换号。
*
* 400 一类不在此列：同一个请求体换谁都是 400，重试只会白等（ADR-6）。
*/
const RETRIABLE = /* @__PURE__ */ new Set([
	"authorization-verify",
	"rate-limited",
	"out-of-credit",
	"upstream-error",
	"network-error",
	"timeout"
]);
/** 上游业务码 → 分类。每条都来自真实探针或上游代码取证。 */
const UPSTREAM_CODE_MAP = Object.freeze({
	"200001": "authorization-empty",
	"200003": "authorization-verify",
	"100002": "token-invalid",
	"200035": "code-not-found",
	user_model_rate_limited: "rate-limited",
	points_insufficient: "out-of-credit",
	insufficient_points: "out-of-credit",
	AUTH_QRCODE_INVALID: "qr-invalid",
	AUTH_QRCODE_EXPIRED: "qr-expired",
	AUTH_QRCODE_NOT_FOUND: "qr-expired"
});
/** 业务码原值 → 给人看的中文；未知码走「原文直出」。 */
const CODE_MESSAGES = Object.freeze({
	"200001": "请求没有携带登录令牌",
	"200003": "登录态已失效，请换一个账号或重新登录",
	"100002": "续期凭据格式非法，请重新登录",
	"200035": "授权码已失效（一次性，可能已用过），请重新发起登录",
	user_model_rate_limited: "该模型的吞吐额度被限（不是请求频率），请稍后重发或换一个模型",
	AUTH_QRCODE_INVALID: "二维码无效，请重新发起扫码登录",
	AUTH_QRCODE_EXPIRED: "二维码已过期，请重新发起扫码登录",
	AUTH_QRCODE_NOT_FOUND: "二维码不存在或已失效，请重新发起扫码登录"
});
/** 从任意值里取一个字符串字段。 */
function stringOf(value) {
	if (typeof value === "string" && value.length > 0) return value;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
}
/** 从上游信封里取出 `code` 与 `message`（信封可能是 `{code,message}` 或 `{error:{...}}`）。 */
function envelopeOf(payload) {
	if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return {
		code: void 0,
		message: void 0
	};
	const record = payload;
	const nested = record["error"];
	const inner = nested !== null && typeof nested === "object" && !Array.isArray(nested) ? nested : void 0;
	return {
		code: stringOf(record["code"]) ?? (inner === void 0 ? void 0 : stringOf(inner["code"])),
		message: stringOf(record["message"]) ?? (inner === void 0 ? void 0 : stringOf(inner["message"]))
	};
}
/** HTTP 状态 → 分类（业务码缺席或未知时的兜底）。 */
function classifyStatus(status) {
	if (status === 400) return "bad-request";
	if (status === 401 || status === 403) return "authorization-verify";
	if (status === 404) return "model-not-found";
	if (status === 429) return "rate-limited";
	return "upstream-error";
}
/**
* 把一次上游响应归一成 {@link RaccoonError}。
*
* 判定顺序：先看业务码（它比 HTTP 状态更精确，200 也可能带业务错），
* 再看 HTTP 状态，最后落到 `upstream-error`。未知业务码保留原文交给用户。
*
* @param input.status - HTTP 状态。
* @param input.payload - 已解析的响应体（解析失败传 `undefined`）。
* @param input.fallback - 没有可用文案时的兜底说明。
* @returns 归一后的错误（调用方负责抛出）。
*/
function classifyUpstream(input) {
	const envelope = envelopeOf(input.payload);
	const upstreamCode = envelope.code;
	if (upstreamCode !== void 0) {
		const mapped = UPSTREAM_CODE_MAP[upstreamCode];
		if (mapped !== void 0) return new RaccoonError({
			code: mapped,
			message: CODE_MESSAGES[upstreamCode] ?? envelope.message ?? input.fallback ?? `上游返回 ${upstreamCode}`,
			status: input.status,
			upstreamCode
		});
		return new RaccoonError({
			code: classifyStatus(input.status),
			message: envelope.message ?? input.fallback ?? `上游返回 ${upstreamCode}`,
			status: input.status,
			upstreamCode
		});
	}
	return new RaccoonError({
		code: classifyStatus(input.status),
		message: envelope.message ?? input.fallback ?? `上游返回 HTTP ${String(input.status)}`,
		status: input.status
	});
}
/**
* 把 fetch 抛出的异常归一成 {@link RaccoonError}。
*
* @param error - 原始异常。
* @param fallback - 兜底说明。
* @returns 归一后的错误；已是 `RaccoonError` 时原样返回。
*/
function classifyThrown(error, fallback) {
	if (error instanceof RaccoonError) return error;
	const name = error?.name;
	if (name === "TimeoutError" || name === "AbortError") return new RaccoonError({
		code: "timeout",
		message: fallback ?? "请求小浣熊超时",
		cause: error
	});
	const message = error instanceof Error ? error.message : String(error);
	return new RaccoonError({
		code: "network-error",
		message: fallback ?? `无法连接小浣熊服务：${message}`,
		cause: error
	});
}
// src/protocol/catalog.ts
/**
* 模型目录：解析、兜底、以及「上游标签不可信」的覆盖表。
*
* 上游 `GET /llm/v2/model_catalog` 返回 `{code, data:{categories:[{models:[…]}]}}`。
* 目录是模型选择器唯一的真源，所以解析必须**宽进严出**：字段缺失用保守默认，
* 结构完全不对才抛错 —— 空目录会让选择器整组消失。
*
* @module dsh-connect-raccoon/protocol/catalog
*/
/** 目录里没有 `params` 时的保守默认：宁可少宣称，也不要假装 1M 窗口。 */
const DEFAULT_CONTEXT_WINDOW = 131072;
/** 见 {@link DEFAULT_CONTEXT_WINDOW}。 */
const DEFAULT_MAX_TOKENS = 8192;
/**
* 实测能读图的模型 id（前缀匹配）。
*
* 上游目录里唯一的能力信号是 `tags` 里的 `vision`，而实测它**两个方向都错过**：
* 有标签却把图片直接丢掉（模型回「我看不到这张图片」，比拒绝更难发现），
* 没标签却真的能读图。所以以实测为准，`tags` 只作为未知模型的线索。
* 新上架的 id 不在表里时按 `tags` 判，用户可在卡片里手工纠正。
*/
const MEASURED_VISION = Object.freeze([
	"sensenova-6.8-flash-lite",
	"kimi-k3",
	"glm-5-3-flash",
	"deepseek-v4.1-flash"
]);
/** 实测**不能**读图但打了 `vision` 标签的模型 id。优先级高于 {@link MEASURED_VISION}。 */
const MEASURED_TEXT_ONLY = Object.freeze(["glm-5-3"]);
/**
* 静态兜底目录。
*
* 目录请求全失败时也要能注册出模型，否则「刚装好还没登录」的用户会看到
* 选择器里一个模型都没有，而那个空选择器不会自己变好。字段值是**保守估计**，
* 名字里带「兜底」提示，避免被当成上游的真实声明。
*/
const FALLBACK_CATALOG = Object.freeze([
	{
		id: "sensenova-6.8-flash-lite",
		name: "SenseNova-6.8-Flash-Lite",
		description: "兜底目录条目：登录后会被上游目录替换",
		vision: true,
		contextWindow: 131072,
		maxTokens: 8192,
		multiplier: "",
		reasoning: false
	},
	{
		id: "kimi-k3",
		name: "Kimi-K3",
		description: "兜底目录条目：登录后会被上游目录替换",
		vision: true,
		contextWindow: 262144,
		maxTokens: 8192,
		multiplier: "",
		reasoning: false
	},
	{
		id: "deepseek-v4.1-flash",
		name: "DeepSeek-V4.1-Flash",
		description: "兜底目录条目：登录后会被上游目录替换",
		vision: true,
		contextWindow: 131072,
		maxTokens: 8192,
		multiplier: "",
		reasoning: false
	}
]);
/** 从任意值里取字符串。 */
function str$2(value) {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
}
/** 从任意值里取正整数。 */
function posInt(value) {
	const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	return Number.isFinite(number) && number > 0 ? Math.floor(number) : void 0;
}
/** 取一个对象。 */
function obj$2(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
/** 判一个 id 是否命中表（允许上游带前缀/后缀变体）。 */
function hits(id, table) {
	const lower = id.toLowerCase();
	return table.some((entry) => lower === entry || lower.startsWith(`${entry}-`) || lower.includes(entry));
}
/** 按实测表 + `tags` 判定识图能力。 */
function decideVision(id, tags) {
	if (hits(id, MEASURED_TEXT_ONLY)) return false;
	if (hits(id, MEASURED_VISION)) return true;
	return tags.some((tag) => tag.toLowerCase() === "vision");
}
/** 把一条目录行的倍率字段拼成展示串。 */
function multiplierOf(row) {
	const direct = str$2(row["billing_multiplier"]) ?? str$2(row["multiplier"]);
	if (direct !== void 0) return direct.startsWith("x") ? direct : `x${direct}`;
	const billing = obj$2(row["billing"]);
	const nested = billing === void 0 ? void 0 : str$2(billing["multiplier"]);
	if (nested !== void 0) return nested.startsWith("x") ? nested : `x${nested}`;
	return "";
}
/** 取促销文案；只认结构里明确带时间窗或文案的字段。 */
function promoOf(row) {
	const direct = str$2(row["promotion"]) ?? str$2(row["promo_label"]) ?? str$2(row["discount_label"]);
	if (direct !== void 0) return direct;
	const promo = obj$2(row["promotion_info"]);
	return promo === void 0 ? void 0 : str$2(promo["label"]) ?? str$2(promo["title"]);
}
/** 解析一条目录行；缺 id 的行返回 `undefined`。 */
function parseRow(raw) {
	const row = obj$2(raw);
	if (row === void 0) return void 0;
	const id = str$2(row["model_name"]) ?? str$2(row["name"]);
	if (id === void 0) return void 0;
	if (row["visible"] === false) return void 0;
	const tags = Array.isArray(row["tags"]) ? row["tags"].filter((tag) => typeof tag === "string") : [];
	const params = obj$2(row["params"]) ?? {};
	const promo = promoOf(row);
	const description = str$2(row["display_description"]) ?? str$2(row["description"]);
	return {
		id,
		name: str$2(row["display_name"]) ?? str$2(row["name"]) ?? id,
		...description === void 0 ? {} : { description },
		vision: decideVision(id, tags),
		contextWindow: posInt(params["context_window"]) ?? posInt(row["context_window"]) ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: posInt(params["max_tokens"]) ?? posInt(row["max_tokens"]) ?? DEFAULT_MAX_TOKENS,
		multiplier: multiplierOf(row),
		...promo === void 0 ? {} : { promo },
		reasoning: false
	};
}
/**
* 解析 `GET /model_catalog` 的响应。
*
* @param payload - 已解析的响应体。
* @param now - 抓取时间（测试注入）。
* @returns 目录快照；同名模型第一个生效。
* @throws {RaccoonError} 结构完全不是目录（`invalid-response`）或目录为空。
*/
function parseCatalog(payload, now = Date.now()) {
	const root = obj$2(payload);
	if (root === void 0) throw new RaccoonError({
		code: "invalid-response",
		message: "小浣熊模型目录不是 JSON 对象"
	});
	const code = root["code"];
	if (typeof code === "number" && code !== 0) throw new RaccoonError({
		code: "invalid-response",
		message: str$2(root["message"]) ?? `小浣熊模型目录返回 code=${String(code)}`,
		upstreamCode: code
	});
	if (typeof code === "string" && code !== "OK" && code !== "ok") throw new RaccoonError({
		code: "invalid-response",
		message: str$2(root["message"]) ?? `小浣熊模型目录返回 code=${code}`,
		upstreamCode: code
	});
	const data = obj$2(root["data"]) ?? root;
	const categories = Array.isArray(data["categories"]) ? data["categories"] : [];
	const models = [];
	const seen = /* @__PURE__ */ new Set();
	for (const category of categories) {
		const rows = obj$2(category)?.["models"];
		if (!Array.isArray(rows)) continue;
		for (const raw of rows) {
			const model = parseRow(raw);
			if (model === void 0 || seen.has(model.id)) continue;
			seen.add(model.id);
			models.push(model);
		}
	}
	if (models.length === 0) throw new RaccoonError({
		code: "invalid-response",
		message: "小浣熊返回的模型目录为空"
	});
	return {
		models,
		fetchedAtMs: now,
		source: "live"
	};
}
/** 按禁用名单过滤目录（过滤发生在出口，选择器读不到就不会出现）。 */
function visibleModels(models, disabled) {
	const off = new Set(disabled);
	return models.filter((model) => !off.has(model.id));
}
// src/protocol/client.ts
/**
* 小浣熊上游客户端：纯 HTTP，无账号状态。
*
* 账号从哪来、用完写回哪儿，都由 `host/` 决定；这里只把每个端点的形状、
* 身份头、错误归一与超时固定下来。所有方法都接受外部 `signal`，内部另加超时，
* 两者任一触发就中止 —— 「等待没有超时」是这类插件最常见的一类挂死。
*
* @module dsh-connect-raccoon/protocol/client
*/
/**
* 从主站派生端点。
*
* @param siteOrigin - 主站 origin；留空用内置的 `https://xiaohuanxiong.com`。
* @returns 五个端点前缀（都不带尾斜杠）。
*/
function endpointsOf(siteOrigin) {
	const trimmed = typeof siteOrigin === "string" ? siteOrigin.trim().replace(/\/+$/, "") : "";
	const site = trimmed === "" ? SITE_ORIGIN : trimmed;
	return {
		site,
		llm: `${site}/api/web/llm/v2`,
		auth: `${site}/api/web/auth/v1`,
		iam: `${site}/api/iam/v1`,
		points: `${site}/api/web/points/v1`
	};
}
/** 当前平台的身份头取值；网关按它区分通道。 */
function clientPlatform() {
	if (process.platform === "darwin") return "desktop-macos";
	if (process.platform === "linux") return "desktop-linux";
	return "desktop-windows";
}
/** 所有业务请求共用的身份头。 */
function identityHeaders(site, token) {
	return {
		accept: "application/json",
		"x-raccoon-language": CLIENT_LANGUAGE,
		"x-client-platform": clientPlatform(),
		"x-client-version": CLIENT_VERSION,
		"x-org-code": "",
		origin: site,
		referer: `${site}/`,
		...token === void 0 ? {} : { authorization: `Bearer ${token}` }
	};
}
/** 去掉上游可能附带的 `Bearer ` 前缀（含 `Bearer` 后无空白的畸形写法）。 */
function stripBearer$1(value) {
	return typeof value === "string" ? value.replace(/^Bearer\s*/i, "").trim() : "";
}
/** 取对象。 */
function obj$1(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
/** 取字符串。 */
function str$1(value) {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
}
/** 取有限数字。 */
function num(value) {
	const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	return Number.isFinite(number) ? number : void 0;
}
/**
* 起一个客户端。
*
* @param options - 注入的 fetch 与超时（测试用）。
* @returns 客户端；实例无状态，可并发调用。
*/
function createRaccoonClient(options = {}) {
	const fetchImpl = options.fetchImpl ?? fetch;
	const timeoutMs = options.timeoutMs ?? 45e3;
	const endpoints = endpointsOf(options.siteOrigin);
	/** 发一次请求并返回 `Response`；网络层失败归一成 RaccoonError。 */
	const send = async (input) => {
		const timeout = AbortSignal.timeout(timeoutMs);
		const signal = input.signal === void 0 ? timeout : AbortSignal.any([input.signal, timeout]);
		try {
			return await fetchImpl(input.url, {
				method: input.method ?? "GET",
				headers: {
					...input.body === void 0 ? {} : { "content-type": "application/json" },
					...input.headers ?? {}
				},
				...input.body === void 0 ? {} : { body: typeof input.body === "string" ? input.body : JSON.stringify(input.body) },
				signal,
				redirect: "error"
			});
		} catch (error) {
			throw classifyThrown(error);
		}
	};
	/** 发一次请求并把 JSON 解析出来；非 2xx 一律按上游信封归一成错误。 */
	const json = async (input) => {
		const response = await send(input);
		const text = await response.text().catch(() => "");
		let parsed;
		try {
			parsed = text === "" ? void 0 : JSON.parse(text);
		} catch {
			parsed = void 0;
		}
		if (!response.ok) throw classifyUpstream({
			status: response.status,
			payload: parsed
		});
		return parsed;
	};
	return {
		async fetchCatalog(accessToken, signal) {
			return parseCatalog(await json({
				url: `${endpoints.llm}/model_catalog`,
				headers: identityHeaders(endpoints.site, accessToken),
				...signal === void 0 ? {} : { signal }
			}));
		},
		async fetchBalance(accessToken, signal) {
			return parseBalance(await json({
				url: `${endpoints.points}/balance`,
				headers: identityHeaders(endpoints.site, accessToken),
				...signal === void 0 ? {} : { signal }
			}));
		},
		async chatStream(input) {
			const response = await send({
				url: `${endpoints.llm}/chat/completions`,
				method: "POST",
				headers: identityHeaders(endpoints.site, input.accessToken),
				body: input.body,
				...input.signal === void 0 ? {} : { signal: input.signal }
			});
			if (response.ok) return response;
			const text = await response.text().catch(() => "");
			let parsed;
			try {
				parsed = text === "" ? void 0 : JSON.parse(text);
			} catch {
				parsed = void 0;
			}
			throw classifyUpstream({
				status: response.status,
				payload: parsed
			});
		},
		async startQr() {
			return parseQrSession(await json({
				url: `${endpoints.iam}/auth/mp/qrcode`,
				method: "POST",
				headers: identityHeaders(endpoints.site),
				body: {}
			}), options.siteOrigin);
		},
		async pollQr(code) {
			return await pollQrOnce((input) => json(input), code, endpoints);
		},
		qrContent(session) {
			const url = new URL(session.scanPath, endpoints.site);
			url.search = "";
			url.searchParams.set("code", session.code);
			url.searchParams.set("appname", QR_APP_NAME);
			url.searchParams.set("source", "platform");
			return url.href;
		},
		async exchangeAuthorizationCode(code) {
			return parseTokenPair(await json({
				url: `${endpoints.auth}/login_with_authorization_code`,
				method: "POST",
				headers: identityHeaders(endpoints.site),
				body: { authorization_code: code }
			}));
		},
		async fetchUserInfo(accessToken) {
			const payload = await json({
				url: `${endpoints.auth}/user_info`,
				headers: identityHeaders(endpoints.site, accessToken)
			});
			const data = obj$1(obj$1(payload)?.["data"]) ?? obj$1(payload) ?? {};
			const name = str$1(data["name"]) ?? str$1(data["nickname"]);
			const ownerType = str$1(data["owner_type"]);
			const orgName = str$1(data["org_name"]);
			const identity = ownerType ?? (Array.isArray(data["orgs"]) && data["orgs"].length === 0 ? "personal" : void 0);
			return {
				...name === void 0 ? {} : { nickname: name },
				...identity === void 0 ? {} : { identity },
				...orgName === void 0 ? {} : { orgName }
			};
		},
		async confirmIamSession(accessToken) {
			try {
				const response = await send({
					url: `${endpoints.auth}/iam/confirm`,
					method: "POST",
					headers: identityHeaders(endpoints.site, accessToken),
					body: {}
				});
				const headers = response.headers;
				const cookies = headers.getSetCookie?.() ?? (headers.get("set-cookie") === null ? [] : [headers.get("set-cookie") ?? ""]);
				await response.text().catch(() => "");
				if (!response.ok) return void 0;
				return cookieValue(cookies, (name) => name === "xhx_token" || name.endsWith("xhx_token"));
			} catch {
				return;
			}
		},
		async settingInfo(accessToken) {
			return await json({
				url: `${endpoints.site}/api/web/office/v3/setting_info`,
				headers: identityHeaders(endpoints.site, accessToken)
			});
		},
		async fetchBills(accessToken) {
			return await json({
				url: `${endpoints.points}/bills`,
				headers: identityHeaders(endpoints.site, accessToken)
			});
		}
	};
}
/** 解析余额信封。 */
function parseBalance(payload) {
	const data = obj$1(obj$1(payload)?.["data"]) ?? obj$1(payload) ?? {};
	const total = num(data["balance"]) ?? num(data["total"]) ?? num(data["points"]) ?? 0;
	const packagesRaw = Array.isArray(data["packages"]) ? data["packages"] : Array.isArray(data["items"]) ? data["items"] : [];
	const packages = [];
	for (const raw of packagesRaw) {
		const row = obj$1(raw);
		if (row === void 0) continue;
		const amount = num(row["amount"]) ?? num(row["points"]) ?? num(row["balance"]);
		if (amount === void 0) continue;
		const expires = num(row["expires_at"]) ?? num(row["expire_at"]) ?? num(row["expired_at"]);
		packages.push({
			amount,
			...expires === void 0 ? {} : { expiresAtMs: expires > 0xe8d4a51000 ? expires : expires * 1e3 }
		});
	}
	const horizon = Date.now() + 1296e6;
	const expiringSoon = packages.filter((item) => item.expiresAtMs !== void 0 && item.expiresAtMs <= horizon).reduce((sum, item) => sum + item.amount, 0);
	const nearest = packages.map((item) => item.expiresAtMs).filter((value) => value !== void 0).sort((left, right) => left - right)[0];
	return {
		total,
		packages,
		expiringSoon,
		...nearest === void 0 ? {} : { nearestExpiryMs: nearest }
	};
}
/** 解析扫码会话；`scan_path` 必须通过同源校验。 */
function parseQrSession(payload, siteOrigin) {
	const data = obj$1(obj$1(payload)?.["data"]) ?? obj$1(payload) ?? {};
	const code = str$1(data["qrcode_code"]);
	const scanPath = str$1(data["scan_path"]);
	const expiresInSec = num(data["expires_in"]);
	const pollIntervalMs = (num(data["poll_interval"]) ?? 2) * 1e3;
	if (code === void 0 || scanPath === void 0 || expiresInSec === void 0 || expiresInSec <= 0 || expiresInSec > 3600) throw new RaccoonError({
		code: "invalid-response",
		message: "小浣熊登录服务返回的二维码信息不完整"
	});
	assertSameOriginPath(scanPath, endpointsOf(siteOrigin).site);
	return {
		code,
		scanPath,
		expiresInSec,
		pollIntervalMs
	};
}
/** 服务端给的落地路径必须是本站内的一条相对路径。 */
function assertSameOriginPath(scanPath, site) {
	if (!scanPath.startsWith("/") || scanPath.startsWith("//") || /[\\\s#]/.test(scanPath)) throw new RaccoonError({
		code: "invalid-response",
		message: "小浣熊返回了无效的扫码地址"
	});
	const url = new URL(scanPath, site);
	const expectedProtocol = site.startsWith("https:") ? "https:" : "http:";
	if (url.protocol !== expectedProtocol || url.origin !== new URL(site).origin || url.hash !== "") throw new RaccoonError({
		code: "invalid-response",
		message: "小浣熊返回了无效的扫码地址"
	});
}
/** 把一次轮询响应当成状态机读；网络抖动与超时不算失败。 */
function pollQrOnce(call, code, endpoints) {
	return call({
		url: `${endpoints.iam}/auth/mp/qrcode/login`,
		method: "POST",
		headers: identityHeaders(endpoints.site),
		body: { qrcode_code: code }
	}).then((payload) => {
		const data = obj$1(obj$1(payload)?.["data"]) ?? {};
		const status = str$1(data["status"]) ?? "";
		if (status === "success") {
			const accessToken = stripBearer$1(data["access_token"]);
			const tokenType = str$1(data["token_type"]);
			if (accessToken === "") return {
				status: "error",
				message: "扫码成功但响应里没有访问令牌"
			};
			if (tokenType !== void 0 && tokenType.toLowerCase() !== "bearer") return {
				status: "error",
				message: `扫码返回了不支持的令牌类型 ${tokenType}`
			};
			return {
				status: "success",
				accessToken
			};
		}
		if (status === "logging") return { status: "scanning" };
		if (status === "canceled") return {
			status: "canceled",
			message: "你取消了这次授权"
		};
		return { status: "pending" };
	}, (error) => {
		if (error instanceof RaccoonError) {
			if (error.code === "qr-expired") return {
				status: "expired",
				message: error.message
			};
			if (error.code === "qr-invalid") return {
				status: "error",
				message: error.message
			};
			return { status: "pending" };
		}
		return { status: "pending" };
	});
}
/** 解析换 token 的响应。 */
function parseTokenPair(payload) {
	const data = obj$1(obj$1(payload)?.["data"]) ?? {};
	const accessToken = stripBearer$1(data["access_token"]);
	const refreshToken = stripBearer$1(data["refresh_token"]);
	if (accessToken === "") {
		const classified = classifyUpstream({
			status: 400,
			payload,
			fallback: "换取登录凭证失败"
		});
		throw classified.upstreamCode === null ? new RaccoonError({
			code: "invalid-response",
			message: "换取登录凭证的响应里没有访问令牌"
		}) : classified;
	}
	const identity = str$1(data["office_identity"]);
	const orgName = str$1(data["office_org_name"]);
	const orgRole = str$1(data["office_org_role"]);
	return {
		accessToken,
		refreshToken,
		...identity === void 0 ? {} : { identity },
		...orgName === void 0 ? {} : { orgName },
		...orgRole === void 0 ? {} : { orgRole }
	};
}
/** 从 `Set-Cookie` 行里取指定名字的值。 */
function cookieValue(lines, matches) {
	for (const line of lines) {
		const pair = line.split(";", 1)[0] ?? "";
		const index = pair.indexOf("=");
		if (index <= 0) continue;
		if (!matches(pair.slice(0, index).trim())) continue;
		const raw = pair.slice(index + 1).trim().replace(/^"|"$/g, "");
		try {
			return decodeURIComponent(raw);
		} catch {
			return raw;
		}
	}
}
// src/credentials/refresh.ts
/**
* 令牌续期：单次使用轮转语义下的**单飞**刷新。
*
* 小浣熊的 refresh token 换一次就轮转一次（新旧一起变）。所以同一个账号
* 绝不能并发刷新 —— 第二个请求必然拿着已作废的 token 去换，结果是把这个账号
* 直接打进「需要重新登录」的状态。这里按 accountKey 去重：同账号并发调用
* 共享同一次网络请求与同一个结果。
*
* 429（上游对刷新端点限流）后进入冷却，冷却期内不再尝试，避免把限流打成封禁。
*
* @module dsh-connect-raccoon/credentials/refresh
*/
/** 上游明确拒绝了这个续期凭据（要重新登录，不是重试）。 */
var RefreshRejectedError = class extends Error {
	/** 稳定分类码；界面据此引导「重新登录」而不是「重试」。 */
	code = "refresh-rejected";
	/** 上游业务码原文。 */
	upstreamCode;
	constructor(message, upstreamCode = null) {
		super(message);
		this.name = "RefreshRejectedError";
		this.upstreamCode = upstreamCode;
	}
};
/** 刷新被限流，冷却中。 */
var RefreshCooldownError = class extends Error {
	/** 稳定分类码。 */
	code = "refresh-cooldown";
	/** 还要等多少毫秒。 */
	retryAfterMs;
	constructor(retryAfterMs) {
		super(`小浣熊续期端点限流中，请 ${String(Math.ceil(retryAfterMs / 6e4))} 分钟后再试`);
		this.name = "RefreshCooldownError";
		this.retryAfterMs = retryAfterMs;
	}
};
/** 去掉上游附带的 `Bearer ` 前缀。 */
function stripBearer(value) {
	return typeof value === "string" ? value.replace(/^Bearer\s+/i, "").trim() : "";
}
/** 取嵌套对象。 */
function obj(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
/**
* 建续期器。
*
* @param deps.fetchImpl - 注入的 fetch（测试用）。
* @param deps.now - 注入时钟（测试用）。
* @param deps.warn - 诊断日志。
* @returns 续期器实例；生命周期与插件一致。
*/
function createRefresher(deps = {}) {
	const fetchImpl = deps.fetchImpl ?? fetch;
	const now = deps.now ?? (() => Date.now());
	const warn = deps.warn ?? (() => {});
	const endpoints = endpointsOf(deps.siteOrigin);
	/** 进行中的刷新：同账号的后来者直接等这一次。 */
	const inflight = /* @__PURE__ */ new Map();
	/** 冷却截止时间：限流是「此刻」的事实，不落盘。 */
	const cooldownUntil = /* @__PURE__ */ new Map();
	const cooldownMs = (accountKey) => {
		const until = cooldownUntil.get(accountKey);
		if (until === void 0) return 0;
		const remaining = until - now();
		if (remaining <= 0) {
			cooldownUntil.delete(accountKey);
			return 0;
		}
		return remaining;
	};
	const once = async (refreshToken) => {
		const response = await fetchImpl(`${endpoints.auth}/refresh`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json"
			},
			body: JSON.stringify({ refresh_token: refreshToken }),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			redirect: "error"
		});
		const text = await response.text().catch(() => "");
		let parsed;
		try {
			parsed = text === "" ? void 0 : JSON.parse(text);
		} catch {
			parsed = void 0;
		}
		const root = obj(parsed) ?? {};
		const code = root["code"];
		if (response.status === 429) throw new RefreshCooldownError(REFRESH_COOLDOWN_MS);
		if (!response.ok) throw new RefreshRejectedError(`小浣熊续期失败（HTTP ${String(response.status)}）：${typeof root["message"] === "string" ? root["message"] : "无错误说明"}`, typeof code === "string" || typeof code === "number" ? code : null);
		const data = obj(root["data"]) ?? {};
		const accessToken = stripBearer(data["access_token"]);
		if (accessToken === "") throw new RefreshRejectedError(`小浣熊续期响应里没有访问令牌（code=${String(code ?? "null")}）`, typeof code === "string" || typeof code === "number" ? code : null);
		const rotated = stripBearer(data["refresh_token"]);
		const facts = decodeJwtFacts(accessToken);
		return {
			accessToken,
			refreshToken: rotated === "" ? refreshToken : rotated,
			expiresAtMs: facts.expiresAtMs ?? now() + 36e5
		};
	};
	return {
		cooldownMs,
		refresh(account, options) {
			const remaining = cooldownMs(account.accountKey);
			if (remaining > 0) return Promise.reject(new RefreshCooldownError(remaining));
			const existing = inflight.get(account.accountKey);
			if (existing !== void 0) return existing;
			if (account.refreshToken === "") return Promise.reject(new RefreshRejectedError("这个账号没有续期凭据，请重新登录"));
			const task = once(account.refreshToken).catch((error) => {
				if (error instanceof RefreshCooldownError) {
					cooldownUntil.set(account.accountKey, now() + error.retryAfterMs);
					warn(`账号 ${account.accountKey} 续期被限流，冷却 ${String(Math.round(error.retryAfterMs / 6e4))} 分钟`);
				}
				throw error;
			}).finally(() => {
				inflight.delete(account.accountKey);
			});
			inflight.set(account.accountKey, task);
			return task;
		}
	};
}
// src/credentials/desktop.ts
/**
* 桌面端凭据：探测与写回。
*
* 小浣熊桌面端把登录态写在 `~/.box-agent/config/auth.json`（`BOX_AGENT_CONFIG_DIR`
* 可整体搬走），**一个文件只承载一份登录态** —— 所以它最多贡献账号池里的一个成员。
*
* 写回是必须的：它的 refresh token 单次使用，插件只刷不写回会让 App 下次刷新撞
* `refresh_conflict` 并被登出。写回必须**保键序、保未知字段、原子替换**，
* 因为这些文件属于另一个程序（ADR-2）。
*
* 凭据只经本模块进出；本模块不写日志、不返回 token 给展示层。
*
* @module dsh-connect-raccoon/credentials/desktop
*/
/**
* 列出候选路径，按优先级。
*
* `RACCOON_AUTH_FILE` 直接当文件（短路其余全部），`BOX_AGENT_CONFIG_DIR` 当目录。
*
* @param env - 环境变量（测试注入）。
* @returns 候选路径，最多三条。
*/
function desktopAuthCandidates(env = process.env) {
	const explicitFile = env["RACCOON_AUTH_FILE"]?.trim();
	if (explicitFile !== void 0 && explicitFile !== "") return [{
		path: path.resolve(explicitFile),
		source: "env-file"
	}];
	const explicitDir = env["BOX_AGENT_CONFIG_DIR"]?.trim();
	if (explicitDir !== void 0 && explicitDir !== "") return [{
		path: path.join(path.resolve(explicitDir), DESKTOP_AUTH_FILENAME),
		source: "env-dir"
	}];
	return [{
		path: path.join(homedir(), DESKTOP_CONFIG_DIRNAME, DESKTOP_AUTH_FILENAME),
		source: "default"
	}];
}
/** 从任意值里取非空字符串。 */
function str(value) {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
}
/** 判断一个值是不是「加密信封」形态；本插件不解密（见 ADR-2 的说明）。 */
function isEnvelope(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value;
	return typeof record["envelope"] === "string" || Object.keys(record).some((key) => key.startsWith("$"));
}
/** 解析 auth.json 文档；不是对象返回 `undefined`。 */
function parseDocument(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return;
	}
	return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : void 0;
}
/** 一个探测结果：只是「没找到」那种。 */
function missing(authPath, configDir, reason) {
	return {
		configDir,
		authPath,
		exists: false,
		readable: false,
		multiAccount: false,
		reason,
		keyOrderMatchesApp: false
	};
}
/**
* 探测本机桌面端凭据；只读，不刷新、不写回。
*
* @param options.env - 环境变量覆盖（测试用）。
* @returns 探测结果；永远不会抛。
*/
async function probeDesktop(options = {}) {
	const candidate = desktopAuthCandidates(options.env ?? process.env)[0];
	if (candidate === void 0) return missing("", "", "desktop-missing");
	const authPath = candidate.path;
	const configDir = path.dirname(authPath);
	let exists = false;
	try {
		exists = (await stat(authPath)).isFile();
	} catch {
		return missing(authPath, configDir, "desktop-missing");
	}
	if (!exists) return missing(authPath, configDir, "desktop-missing");
	let text;
	try {
		text = await readFile(authPath, "utf8");
	} catch {
		return {
			...missing(authPath, configDir, "desktop-unreadable"),
			exists: true
		};
	}
	const document = parseDocument(text);
	if (document === void 0) return {
		...missing(authPath, configDir, "desktop-no-token"),
		exists: true,
		readable: true
	};
	const rawKeys = Object.keys(document);
	const keyOrderMatchesApp = DESKTOP_TOKEN_KEYS.every((key, index) => rawKeys[index] === key);
	const accessRaw = document["access_token"] ?? document["token"] ?? document["auth_token"];
	const refreshRaw = document["refresh_token"];
	if (isEnvelope(accessRaw) || isEnvelope(refreshRaw)) return {
		...missing(authPath, configDir, "desktop-encrypted"),
		exists: true,
		readable: true,
		keyOrderMatchesApp
	};
	const accessToken = str(accessRaw);
	const refreshToken = str(refreshRaw) ?? "";
	if (accessToken === void 0) return {
		...missing(authPath, configDir, "desktop-no-token"),
		exists: true,
		readable: true,
		keyOrderMatchesApp
	};
	const facts = decodeJwtFacts(accessToken);
	const identity = str(document["office_identity"]);
	const orgName = str(document["office_org_name"]);
	const orgRole = str(document["office_org_role"]);
	return {
		configDir,
		authPath,
		exists: true,
		readable: true,
		multiAccount: false,
		reason: null,
		keyOrderMatchesApp,
		credential: {
			accessToken,
			refreshToken,
			rawKeys,
			...identity === void 0 ? {} : { identity },
			...orgName === void 0 ? {} : { orgName },
			...orgRole === void 0 ? {} : { orgRole },
			...facts.nickname === void 0 ? {} : { nickname: facts.nickname },
			...facts.expiresAtMs === void 0 ? {} : { expiresAtMs: facts.expiresAtMs }
		}
	};
}
/**
* 把轮转后的令牌对原子写回桌面端文件。
*
* 保三条：未知键还在、键序不变、失败时原文件一个字节都不动（先写临时文件再 rename）。
*
* @param input.probe - 探测结果；必须带 `credential`（否则无从保字段）。
* @param input.accessToken - 新的访问令牌。
* @param input.refreshToken - 新的续期令牌。
* @param input.backupDir - 备份目录；缺省用凭据所在目录的上一级。
* @param input.now - 时钟（测试注入）。
* @returns 写入结果；失败不抛。
*/
async function writeBackDesktop(input) {
	const { probe } = input;
	if (probe.credential === void 0) return {
		ok: false,
		reason: "没有可写回的凭据快照"
	};
	let original;
	try {
		original = await readFile(probe.authPath, "utf8");
	} catch {
		return {
			ok: false,
			reason: "读不到桌面端凭据文件"
		};
	}
	const document = parseDocument(original);
	if (document === void 0) return {
		ok: false,
		reason: "桌面端凭据文件不是合法 JSON 对象"
	};
	const next = {
		...document,
		access_token: input.accessToken,
		refresh_token: input.refreshToken
	};
	const ordered = {};
	for (const key of DESKTOP_TOKEN_KEYS) if (key in next) ordered[key] = next[key];
	for (const key of Object.keys(document)) if (!(key in ordered)) ordered[key] = document[key];
	const backupDir = input.backupDir ?? path.dirname(probe.authPath);
	const backupPath = path.join(backupDir, `.${DESKTOP_AUTH_FILENAME}.dsh-backup`);
	let savedBackup;
	try {
		await mkdir(backupDir, { recursive: true });
		await stat(backupPath).then(() => void 0, async () => {
			await writeFile(backupPath, original, {
				encoding: "utf8",
				mode: 384
			});
			savedBackup = backupPath;
		});
	} catch {}
	const temp = `${probe.authPath}.${String(process.pid)}.${randomUUID()}.tmp`;
	try {
		await writeFile(temp, `${JSON.stringify(ordered, null, 2)}\n`, {
			encoding: "utf8",
			mode: 384
		});
		await rename(temp, probe.authPath);
	} catch {
		return {
			ok: false,
			reason: "写入桌面端凭据文件失败（临时文件或替换被拒绝）"
		};
	}
	return {
		ok: true,
		...savedBackup === void 0 ? {} : { backupPath: savedBackup }
	};
}
// src/host/accounts.ts
/**
* 账号生命周期：从桌面端收号、按需续期、读余额、判可用性、记冷却。
*
* 这里的所有写操作都收敛到一条不变量上：**同一个账号的令牌续期必须单飞**。
* 小浣熊的 refresh token 是单次使用的（换一次，新旧一起轮转），两个并发请求
* 各刷一次就等于把其中一个烧掉。所以续期一律走 `Refresher`，它按 accountKey
* 去重；本模块只负责「刷完存哪儿、写不写回桌面端」。
*
* @module dsh-connect-raccoon/host/accounts
*/
/** 从桌面端凭据造一条仓库记录。 */
function fromDesktop(input) {
	const key = input.accountKey ?? input.credential.accessToken;
	return {
		schemaVersion: 1,
		id: accountIdFor(key),
		accountKey: key,
		accessToken: input.credential.accessToken,
		refreshToken: input.credential.refreshToken,
		expiresAtMs: input.credential.expiresAtMs ?? 0,
		refreshExpiresAtMs: 0,
		source: "desktop",
		savedAtMs: input.nowMs,
		desktopPath: input.authPath,
		...input.credential.identity === void 0 ? {} : { identity: input.credential.identity },
		...input.credential.orgName === void 0 ? {} : { orgName: input.credential.orgName },
		...input.credential.orgRole === void 0 ? {} : { orgRole: input.credential.orgRole },
		...input.nickname === void 0 ? {} : { nickname: input.nickname }
	};
}
/**
* 建账号运行时。
*
* @param options - 仓库、上游客户端、续期器与两个配置开关。
* @returns 账号运行时。
*/
function createAccounts(options) {
	const now = options.now ?? (() => Date.now());
	/** 内存里的冷却表：限流是「此刻」的事实，不值得落盘。 */
	const cooldowns = /* @__PURE__ */ new Map();
	const creditCache = /* @__PURE__ */ new Map();
	const accountOf = async (id) => {
		const account = await options.vault.get(id);
		if (account === void 0) throw new RaccoonError({
			code: "bad-request",
			message: `账号 ${id} 不在本机`,
			status: 404
		});
		return account;
	};
	/** 令牌过期判定：`expiresAtMs === 0` 表示解不出，按「可能还有效」处理并交给上游判。 */
	const expiresSoon = (account) => account.expiresAtMs > 0 && account.expiresAtMs - now() <= 3e5;
	return {
		list: () => options.vault.list(),
		get: (id) => options.vault.get(id),
		selected: () => options.vault.readSelected(),
		select: async (id) => {
			if (id !== void 0) await accountOf(id);
			await options.vault.writeSelected(id);
		},
		remove: (id) => options.vault.remove(id),
		probeDesktop: () => options.reuseDesktop() ? probeDesktop() : Promise.resolve(emptyProbe()),
		async adoptDesktop(probe) {
			const resolved = probe ?? await this.probeDesktop();
			if (!options.reuseDesktop()) return {
				ok: false,
				reason: "配置里关掉了「复用桌面端登录」"
			};
			if (resolved.credential === void 0) return {
				ok: false,
				reason: resolved.reason ?? "desktop-no-token"
			};
			const account = fromDesktop({
				credential: resolved.credential,
				authPath: resolved.authPath,
				nowMs: now(),
				...resolved.credential.nickname === void 0 ? {} : { nickname: resolved.credential.nickname }
			});
			await options.vault.save(account);
			if (await options.vault.readSelected() === void 0) await options.vault.writeSelected(account.id);
			return {
				ok: true,
				account
			};
		},
		async accessToken(id) {
			const account = await accountOf(id);
			if (!expiresSoon(account)) return account.accessToken;
			if (account.refreshToken === "") throw new RaccoonError({
				code: "token-invalid",
				message: "这个账号的登录令牌已过期，且没有续期凭据（扫码登录无 refresh token），请重新登录",
				status: 401
			});
			const outcome = await options.refresher.refresh({
				accountKey: account.accountKey,
				refreshToken: account.refreshToken
			});
			const updated = {
				...account,
				accessToken: outcome.accessToken,
				refreshToken: outcome.refreshToken,
				expiresAtMs: outcome.expiresAtMs,
				savedAtMs: now()
			};
			await options.vault.save(updated);
			if (updated.source === "desktop" && options.writeBackDesktop()) {
				const probe = await probeDesktop();
				if (probe.exists && probe.keyOrderMatchesApp) {
					const written = await writeBackDesktop({
						probe,
						accessToken: outcome.accessToken,
						refreshToken: outcome.refreshToken
					});
					if (!written.ok) options.warn(`令牌写回桌面端失败（${written.reason}）：桌面端下次刷新可能需要重新登录`);
				}
			}
			return outcome.accessToken;
		},
		async credits(id, creditOptions) {
			const cached = creditCache.get(id);
			if (!(creditOptions?.force === true) && cached !== void 0 && now() - cached.atMs < 12e4) return cached.balance;
			try {
				const balance = await options.client.fetchBalance(await this.accessToken(id));
				creditCache.set(id, {
					atMs: now(),
					balance
				});
				return balance;
			} catch (error) {
				options.warn(`读取账号 ${id} 余额失败：${error instanceof Error ? error.message : String(error)}`);
				return;
			}
		},
		usability(account) {
			if (this.cooldownMs(account.id) > 0) return {
				usable: false,
				reason: "限流冷却中"
			};
			if (account.expiresAtMs > 0 && account.expiresAtMs <= now() && account.refreshToken === "") return {
				usable: false,
				reason: "登录令牌已过期，请重新登录"
			};
			if (account.refreshExpiresAtMs > 0 && account.refreshExpiresAtMs <= now()) return {
				usable: false,
				reason: "续期凭据已过期，请重新登录"
			};
			if (account.probe !== void 0 && account.probe.outcome === "rejected") return {
				usable: false,
				reason: account.probe.message
			};
			return { usable: true };
		},
		markCooldown(id, ms) {
			cooldowns.set(id, now() + ms);
		},
		cooldownMs(id) {
			const until = cooldowns.get(id);
			if (until === void 0) return 0;
			const remaining = until - now();
			if (remaining <= 0) {
				cooldowns.delete(id);
				return 0;
			}
			return remaining;
		}
	};
}
/** 没启用桌面端复用时返回的空探测结果（界面据此显示「已关闭」而不是「没装」）。 */
function emptyProbe() {
	return {
		configDir: "",
		authPath: "",
		exists: false,
		readable: false,
		multiAccount: false,
		reason: "desktop-missing",
		keyOrderMatchesApp: false
	};
}
// src/host/pool.ts
/** 逐个候选排序；返回新数组，不改输入。 */
function rank(candidates, nowMs) {
	return [...candidates].sort((left, right) => {
		if (left.usable !== right.usable) return left.usable ? -1 : 1;
		const horizon = 2592e6;
		const leftExpiring = left.nearestExpiryMs !== void 0 && left.nearestExpiryMs - nowMs <= horizon;
		const rightExpiring = right.nearestExpiryMs !== void 0 && right.nearestExpiryMs - nowMs <= horizon;
		if (leftExpiring !== rightExpiring) return leftExpiring ? -1 : 1;
		if (leftExpiring && rightExpiring) {
			const delta = (left.nearestExpiryMs ?? 0) - (right.nearestExpiryMs ?? 0);
			if (delta !== 0) return delta;
		}
		const leftKnown = left.credits !== void 0;
		const rightKnown = right.credits !== void 0;
		if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
		if (leftKnown && rightKnown) {
			const delta = (right.credits ?? 0) - (left.credits ?? 0);
			if (delta !== 0) return delta;
		}
		return right.expiresAtMs - left.expiresAtMs;
	});
}
/**
* 从池里挑一个账号。
*
* @param input.poolEnabled - 账号池总开关。
* @param input.currentId - 用户手动选定的账号 id（可能已被删除）。
* @param input.candidates - 池里全部账号（顺序不影响结果）。
* @param input.nowMs - 当前时间（注入以便测试）。
* @returns 选中的 id 与一句给用户看的原因。
*/
function pickAccount(input) {
	const nowMs = input.nowMs ?? Date.now();
	const { candidates, currentId, poolEnabled } = input;
	if (candidates.length === 0) return {
		id: void 0,
		reason: "账号池是空的"
	};
	if (!poolEnabled) {
		const current = candidates.find((candidate) => candidate.id === currentId);
		if (current === void 0) return {
			id: void 0,
			reason: currentId === void 0 ? "还没有选定账号" : "选定的账号已不在本机"
		};
		if (!current.usable) return {
			id: current.id,
			reason: current.reason ?? "当前选用的账号此刻不可用"
		};
		return {
			id: current.id,
			reason: "账号池未启用，使用当前选用的账号"
		};
	}
	const enabled = candidates.filter((candidate) => candidate.inPool && candidate.usable);
	if (enabled.length === 0) return {
		id: void 0,
		reason: candidates.some((candidate) => candidate.inPool) ? "账号池里的账号此刻都不可用" : "账号池已启用，但没有勾选任何账号"
	};
	const best = rank(enabled, nowMs)[0];
	if (best === void 0) return {
		id: void 0,
		reason: "没有可用账号"
	};
	const credits = best.credits;
	return {
		id: best.id,
		reason: credits === void 0 ? `池内 ${String(enabled.length)} 个可用账号中按排序取第一个（余额读不到，未参与比较）` : `余额 ${String(credits)}，在池内 ${String(enabled.length)} 个可用账号里排序第一`
	};
}
/**
* 换号重试时的候选序列。
*
* 先排好序，再按顺序给出**除首个之外**的可用账号；首个由 {@link pickAccount} 决定，
* 这里只回答「第一个不行之后该试谁」。
*
* @param input - 与 {@link pickAccount} 相同的池状态，外加首个账号 id。
* @returns 依次尝试的账号 id 列表（不含首个）。
*/
function failoverCandidates(input) {
	if (!input.poolEnabled) return [];
	const nowMs = input.nowMs ?? Date.now();
	return rank(input.candidates.filter((candidate) => candidate.inPool && candidate.usable), nowMs).map((candidate) => candidate.id).filter((id) => id !== input.firstId);
}
// src/protocol/qr.ts
const MAX_VERSION = 10;
/** 版本 1–10、纠错等级 M 的分块表（ISO/IEC 18004 表 9）。 */
const BLOCKS_M = [
	[[
		1,
		16,
		10
	]],
	[[
		1,
		28,
		16
	]],
	[[
		1,
		44,
		26
	]],
	[[
		2,
		32,
		18
	]],
	[[
		2,
		43,
		24
	]],
	[[
		4,
		27,
		16
	]],
	[[
		4,
		31,
		18
	]],
	[[
		2,
		38,
		22
	], [
		2,
		39,
		22
	]],
	[[
		3,
		36,
		22
	], [
		2,
		37,
		22
	]],
	[[
		4,
		43,
		26
	], [
		1,
		44,
		26
	]]
];
/** 版本 1–10 的对齐图案中心坐标（ISO/IEC 18004 表 E.1）；版本 1 没有对齐图案。 */
const ALIGNMENT_CENTERS = [
	[],
	[6, 18],
	[6, 22],
	[6, 26],
	[6, 30],
	[6, 34],
	[
		6,
		22,
		38
	],
	[
		6,
		24,
		42
	],
	[
		6,
		26,
		46
	],
	[
		6,
		28,
		50
	]
];
const UTF8 = new TextEncoder();
/** 编码为模块矩阵；内容超出 byte 模式 + 等级 M 的版本 1–10 容量时抛 {@link RangeError}。 */
function encodeQrMatrix(content) {
	const bytes = UTF8.encode(content);
	const version = pickVersion(bytes.length);
	const codewords = interleaveCodewords(buildDataCodewords(bytes, version), version);
	const matrix = createWorkingMatrix(version);
	drawFunctionPatterns(matrix, version);
	placeCodewords(matrix, codewords);
	const mask = chooseMask(matrix);
	applyMask(matrix, mask);
	drawFormatBits(matrix, mask);
	return {
		size: matrix.size,
		modules: matrix.modules
	};
}
/** 渲染为可直接内联进 HTML 的完整 SVG；深色模块合成一条 path，四周留 4 模块静区。 */
function renderQrSvg(content, options = {}) {
	const { size: moduleCount, modules } = encodeQrMatrix(content);
	const quietZone = 4;
	const extent = moduleCount + 8;
	const pixelSize = options.size ?? 220;
	if (!Number.isFinite(pixelSize) || pixelSize <= 0) throw new RangeError(`SVG 边长必须是正数：${pixelSize}`);
	let path = "";
	for (let row = 0; row < moduleCount; row += 1) for (let col = 0; col < moduleCount; col += 1) if (modules[row]?.[col] === true) path += `M${col + quietZone} ${row + quietZone}h1v1h-1z`;
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${extent} ${extent}" width="${pixelSize}" height="${pixelSize}" shape-rendering="crispEdges"><rect width="${extent}" height="${extent}" fill="#ffffff"/><path d="${path}" fill="#000000"/></svg>`;
}
/** 选容量足够的最小版本；超容量抛错，不静默截断（截断会产出扫得开但内容错的码）。 */
function pickVersion(byteLength) {
	for (let version = 1; version <= MAX_VERSION; version += 1) if (byteLength <= byteCapacity(version)) return version;
	throw new RangeError(`二维码内容 ${byteLength} 字节，超出 byte 模式 + 纠错等级 M 的版本 1–10 上限 ${byteCapacity(MAX_VERSION)} 字节`);
}
/** 该版本在等级 M 下的数据码字总数。 */
function dataCodewordCount(version) {
	const groups = BLOCKS_M[version - 1] ?? [];
	let total = 0;
	for (const [count, dataCodewords] of groups) total += count * dataCodewords;
	return total;
}
/** 字符计数指示符的位宽：版本 1–9 为 8 bit，版本 10 起为 16 bit。 */
function countBits(version) {
	return version < 10 ? 8 : 16;
}
/** 该版本可容纳的 UTF-8 字节数：数据码字去掉模式指示符与字符计数。 */
function byteCapacity(version) {
	return Math.floor((dataCodewordCount(version) * 8 - 4 - countBits(version)) / 8);
}
/** 拼出模式指示符 → 字符计数 → 数据 → 终止符 → 填充字节的完整数据码字。 */
function buildDataCodewords(bytes, version) {
	const capacityBits = dataCodewordCount(version) * 8;
	const bits = [];
	appendBits(bits, 4, 4);
	appendBits(bits, bytes.length, countBits(version));
	for (const byte of bytes) appendBits(bits, byte, 8);
	appendBits(bits, 0, Math.min(4, capacityBits - bits.length));
	appendBits(bits, 0, (8 - bits.length % 8) % 8);
	let pad = 236;
	while (bits.length < capacityBits) {
		appendBits(bits, pad, 8);
		pad = pad === 236 ? 17 : 236;
	}
	const codewords = new Uint8Array(dataCodewordCount(version));
	for (let i = 0; i < capacityBits; i += 1) if (bits[i] === 1) codewords[i >> 3] = codewords[i >> 3] | 1 << 7 - (i & 7);
	return codewords;
}
/** 按高位在前的顺序追加 `length` 个比特。 */
function appendBits(bits, value, length) {
	for (let i = length - 1; i >= 0; i -= 1) bits.push(value >>> i & 1);
}
/** 分块、算 EC，再按「数据逐列、EC 逐列」交织成最终码字序列。 */
function interleaveCodewords(dataCodewords, version) {
	const groups = BLOCKS_M[version - 1] ?? [];
	const dataBlocks = [];
	const ecBlocks = [];
	let offset = 0;
	for (const [count, dataLength, ecLength] of groups) for (let i = 0; i < count; i += 1) {
		const block = dataCodewords.subarray(offset, offset + dataLength);
		offset += dataLength;
		dataBlocks.push(block);
		ecBlocks.push(reedSolomonRemainder(block, ecLength));
	}
	const total = dataCodewords.length + ecBlocks.reduce((sum, block) => sum + block.length, 0);
	const out = new Uint8Array(total);
	let cursor = 0;
	const maxData = Math.max(...dataBlocks.map((block) => block.length));
	for (let i = 0; i < maxData; i += 1) for (const block of dataBlocks) if (i < block.length) out[cursor++] = block[i];
	const maxEc = Math.max(...ecBlocks.map((block) => block.length));
	for (let i = 0; i < maxEc; i += 1) for (const block of ecBlocks) if (i < block.length) out[cursor++] = block[i];
	return out;
}
const GF_EXP = /* @__PURE__ */ new Uint8Array(512);
const GF_LOG = /* @__PURE__ */ new Uint8Array(256);
for (let i = 0, value = 1; i < 255; i += 1) {
	GF_EXP[i] = value;
	GF_LOG[value] = i;
	value <<= 1;
	if (value & 256) value ^= 285;
}
for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255];
/** GF(256) 乘法。 */
function gfMul(a, b) {
	if (a === 0 || b === 0) return 0;
	return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}
/** 计算 `(x - α^0)(x - α^1)…(x - α^(degree-1))` 的系数，省略首项 1。 */
function reedSolomonDivisor(degree) {
	const divisor = new Uint8Array(degree);
	divisor[degree - 1] = 1;
	let root = 1;
	for (let i = 0; i < degree; i += 1) {
		for (let j = 0; j < degree; j += 1) {
			const scaled = gfMul(divisor[j], root);
			divisor[j] = scaled ^ (j + 1 < degree ? divisor[j + 1] : 0);
		}
		root = gfMul(root, 2);
	}
	return divisor;
}
/** 对一块数据码字做多项式长除，返回长度等于纠错码字数的余式。 */
function reedSolomonRemainder(data, ecLength) {
	const divisor = reedSolomonDivisor(ecLength);
	const remainder = new Uint8Array(ecLength);
	for (const byte of data) {
		const factor = byte ^ remainder[0];
		remainder.copyWithin(0, 1);
		remainder[ecLength - 1] = 0;
		for (let i = 0; i < ecLength; i += 1) remainder[i] = (remainder[i] ?? 0) ^ gfMul(divisor[i], factor);
	}
	return remainder;
}
function createWorkingMatrix(version) {
	const size = version * 4 + 17;
	return {
		size,
		modules: Array.from({ length: size }, () => new Array(size).fill(false)),
		reserved: Array.from({ length: size }, () => new Array(size).fill(false))
	};
}
/** 画定位、时序、对齐、格式与（v≥7 的）版本信息，并把它们标记为不可写数据。 */
function drawFunctionPatterns(matrix, version) {
	const size = matrix.size;
	for (const [centerX, centerY] of [
		[3, 3],
		[size - 4, 3],
		[3, size - 4]
	]) drawFinderPattern(matrix, centerX, centerY);
	for (let i = 8; i < size - 8; i += 1) {
		setFunctionModule(matrix, 6, i, i % 2 === 0);
		setFunctionModule(matrix, i, 6, i % 2 === 0);
	}
	const centers = ALIGNMENT_CENTERS[version - 1] ?? [];
	for (const centerY of centers) for (const centerX of centers) {
		if (isFinderCorner(centerX, centerY, size)) continue;
		drawAlignmentPattern(matrix, centerX, centerY);
	}
	drawFormatBits(matrix, 0);
	if (version >= 7) drawVersionBits(matrix, version);
}
function isFinderCorner(centerX, centerY, size) {
	return centerX === 6 && centerY === 6 || centerX === 6 && centerY === size - 7 || centerX === size - 7 && centerY === 6;
}
/** 7×7 定位图案连同外侧一圈分隔符（距离 2 为浅色，0/1/3/4 为深色）。 */
function drawFinderPattern(matrix, centerX, centerY) {
	for (let dy = -4; dy <= 4; dy += 1) for (let dx = -4; dx <= 4; dx += 1) {
		const distance = Math.max(Math.abs(dx), Math.abs(dy));
		setFunctionModule(matrix, centerX + dx, centerY + dy, distance !== 2 && distance !== 4);
	}
}
/** 5×5 对齐图案：中心深色，距离 1 的环浅色，距离 2 的环深色。 */
function drawAlignmentPattern(matrix, centerX, centerY) {
	for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) setFunctionModule(matrix, centerX + dx, centerY + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
}
/** 写两份 15 bit 格式信息（等级 M 指示符 00 + 3 bit 掩码号，BCH(15,5) 后异或 0x5412）。 */
function drawFormatBits(matrix, mask) {
	const data = mask;
	let remainder = data;
	for (let i = 0; i < 10; i += 1) remainder = remainder << 1 ^ (remainder >>> 9) * 1335;
	const bits = (data << 10 | remainder) ^ 21522;
	for (let i = 0; i <= 5; i += 1) setFunctionModule(matrix, 8, i, bitOf(bits, i));
	setFunctionModule(matrix, 8, 7, bitOf(bits, 6));
	setFunctionModule(matrix, 8, 8, bitOf(bits, 7));
	setFunctionModule(matrix, 7, 8, bitOf(bits, 8));
	for (let i = 9; i < 15; i += 1) setFunctionModule(matrix, 14 - i, 8, bitOf(bits, i));
	for (let i = 0; i < 8; i += 1) setFunctionModule(matrix, matrix.size - 1 - i, 8, bitOf(bits, i));
	for (let i = 8; i < 15; i += 1) setFunctionModule(matrix, 8, matrix.size - 15 + i, bitOf(bits, i));
	setFunctionModule(matrix, 8, matrix.size - 8, true);
}
/** 版本 7 起写两份 18 bit 版本信息：6 bit 版本号 + BCH(18,6) 校验，生成多项式 0x1F25。 */
function drawVersionBits(matrix, version) {
	let remainder = version;
	for (let i = 0; i < 12; i += 1) remainder = remainder << 1 ^ (remainder >>> 11) * 7973;
	const bits = version << 12 | remainder;
	for (let i = 0; i < 18; i += 1) {
		const dark = bitOf(bits, i);
		const a = matrix.size - 11 + i % 3;
		const b = Math.floor(i / 3);
		setFunctionModule(matrix, a, b, dark);
		setFunctionModule(matrix, b, a, dark);
	}
}
function setFunctionModule(matrix, col, row, dark) {
	if (row < 0 || row >= matrix.size || col < 0 || col >= matrix.size) return;
	matrix.modules[row][col] = dark;
	matrix.reserved[row][col] = true;
}
function bitOf(value, index) {
	return (value >>> index & 1) === 1;
}
/** 从右下角起，按 2 列宽的蛇形路径填充码字，跳过功能图案并跳过第 6 列（纵向时序）。 */
function placeCodewords(matrix, codewords) {
	const size = matrix.size;
	const bitLimit = codewords.length * 8;
	let bitIndex = 0;
	for (let right = size - 1; right >= 1; right -= 2) {
		if (right === 6) right = 5;
		const upward = (right + 1 & 2) === 0;
		for (let vertical = 0; vertical < size; vertical += 1) {
			const row = upward ? size - 1 - vertical : vertical;
			for (let offset = 0; offset < 2; offset += 1) {
				const col = right - offset;
				if (matrix.reserved[row]?.[col] === true || bitIndex >= bitLimit) continue;
				const byte = codewords[bitIndex >>> 3];
				matrix.modules[row][col] = bitOf(byte, 7 - (bitIndex & 7));
				bitIndex += 1;
			}
		}
	}
}
/** 依次试 8 种掩码，罚分最低者胜出（掩码自逆，试完再异或一次即还原）。 */
function chooseMask(matrix) {
	let bestMask = 0;
	let bestPenalty = Number.POSITIVE_INFINITY;
	for (let mask = 0; mask < 8; mask += 1) {
		applyMask(matrix, mask);
		drawFormatBits(matrix, mask);
		const penalty = penaltyScore(matrix);
		if (penalty < bestPenalty) {
			bestPenalty = penalty;
			bestMask = mask;
		}
		applyMask(matrix, mask);
	}
	return bestMask;
}
function applyMask(matrix, mask) {
	for (let row = 0; row < matrix.size; row += 1) for (let col = 0; col < matrix.size; col += 1) {
		if (matrix.reserved[row]?.[col] === true) continue;
		if (isMasked(mask, row, col)) matrix.modules[row][col] = matrix.modules[row][col] !== true;
	}
}
/** ISO/IEC 18004 表 10 的 8 种掩码条件；`row` 是 i，`col` 是 j。 */
function isMasked(mask, row, col) {
	switch (mask) {
		case 0: return (row + col) % 2 === 0;
		case 1: return row % 2 === 0;
		case 2: return col % 3 === 0;
		case 3: return (row + col) % 3 === 0;
		case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
		case 5: return row * col % 2 + row * col % 3 === 0;
		case 6: return (row * col % 2 + row * col % 3) % 2 === 0;
		default: return ((row + col) % 2 + row * col % 3) % 2 === 0;
	}
}
/** 按 ISO/IEC 18004 的四个罚分规则给整幅矩阵打分。 */
function penaltyScore(matrix) {
	const size = matrix.size;
	const modules = matrix.modules;
	let score = 0;
	for (let row = 0; row < size; row += 1) {
		const line = Array.from({ length: size }, (_, col) => modules[row]?.[col] === true);
		score += runPenalty(line) + finderLikePenalty(line, size);
	}
	for (let col = 0; col < size; col += 1) {
		const line = Array.from({ length: size }, (_, row) => modules[row]?.[col] === true);
		score += runPenalty(line) + finderLikePenalty(line, size);
	}
	for (let row = 0; row + 1 < size; row += 1) for (let col = 0; col + 1 < size; col += 1) {
		const color = modules[row]?.[col] === true;
		if (color === (modules[row]?.[col + 1] === true) && color === (modules[row + 1]?.[col] === true) && color === (modules[row + 1]?.[col + 1] === true)) score += 3;
	}
	let darkModules = 0;
	for (const row of modules) for (const dark of row) if (dark) darkModules += 1;
	const total = size * size;
	score += (Math.ceil(Math.abs(darkModules * 20 - total * 10) / total) - 1) * 10;
	return score;
}
/** 规则 1：每条同色连续段长度 `n ≥ 5` 罚 `3 + (n - 5)`。 */
function runPenalty(line) {
	let score = 0;
	let run = 1;
	for (let i = 1; i < line.length; i += 1) if (line[i] === line[i - 1]) run += 1;
	else {
		if (run >= 5) score += 3 + (run - 5);
		run = 1;
	}
	if (run >= 5) score += 3 + (run - 5);
	return score;
}
/**
* 规则 3：`n:n:3n:n:n` 的类定位图案每处罚 40。
* 比例按段长等比缩放（不限于 1 模块宽），且图案某一侧要有 4n 宽的浅色区；
* 因此用「最近 7 段长度」的滑动窗口判断，窗口外按浅色边界补齐。
*/
function finderLikePenalty(line, size) {
	const history = [
		0,
		0,
		0,
		0,
		0,
		0,
		0
	];
	let score = 0;
	let runColor = false;
	let run = 0;
	const pushHistory = (length) => {
		const extended = history[0] === 0 ? length + size : length;
		history.pop();
		history.unshift(extended);
	};
	const countPatterns = () => {
		const n = history[1] ?? 0;
		if (!(n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n)) return 0;
		return (history[0] >= n * 4 && history[6] >= n ? 1 : 0) + (history[6] >= n * 4 && history[0] >= n ? 1 : 0);
	};
	for (const dark of line) if (dark === runColor) run += 1;
	else {
		pushHistory(run);
		if (!runColor) score += countPatterns() * 40;
		runColor = dark;
		run = 1;
	}
	if (runColor) {
		pushHistory(run);
		run = 0;
	}
	pushHistory(run + size);
	score += countPatterns() * 40;
	return score;
}
// src/host/login.ts
/**
* 登录会话管理：网页授权回调与微信扫码两条路，共用一个六相位状态机。
*
* 网页那条是主线：本地起一个**只收一次回调**的服务器，把官方授权页的
* `desktop_callback=loopback` 接住。扫码那条是快路径（纯 HTTP 可驱动，但拿不到
* refresh token）。两条路都以「拿到令牌后探一次模型目录」为成功判据 ——
* 上游会签发令牌，但只有网关接受它才算真的登录成功。
*
* 不变量：任一时刻最多一个进行中的会话；`state` 必须逐字比对；凭据只进仓库，
* 永不进状态文档。
*
* @module dsh-connect-raccoon/host/login
*/
/** 空闲视图。 */
const IDLE = {
	running: false,
	kind: "web",
	phase: "idle",
	message: "",
	url: null,
	port: null,
	qrSvg: null,
	expiresAtMs: null,
	error: null
};
/** 建一个空闲视图（`running:false` 的相位不参与渲染）。 */
function idle(kind = "web") {
	return {
		...IDLE,
		kind
	};
}
/** 从任意输入里取出授权码：整条回调 URL 或裸码都接受。 */
function extractAuthorizationCode(text, expectedState) {
	const trimmed = text.trim();
	if (trimmed === "") return { error: "没有收到授权码" };
	if (!trimmed.includes("://") && !trimmed.includes("code=")) return { code: trimmed };
	let url;
	try {
		url = new URL(trimmed.includes("://") ? trimmed : `office-raccoon://auth/callback?${trimmed.replace(/^\?/, "")}`);
	} catch {
		return { error: "这段文本既不是授权码也不是一条回调地址" };
	}
	const code = url.searchParams.get("code") ?? url.searchParams.get("authorization_code") ?? "";
	const state = url.searchParams.get("state") ?? "";
	if (code === "") return { error: "回调地址里没有 code" };
	if (state === "") return { error: "回调地址里没有 state，无法确认这次登录由本机发起" };
	if (!safeEqual(state, expectedState)) return { error: "回调 state 不匹配，已拒绝这次登录" };
	return { code };
}
/** 定长比较，避免把 state 校验写成有长度侧信道的形式。 */
function safeEqual(left, right) {
	const a = Buffer.from(left);
	const b = Buffer.from(right);
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}
/** 生成 64 位小写 hex；授权页对 `state` 有这条硬校验。 */
function defaultState() {
	return randomBytes(32).toString("hex");
}
/** 拼授权页 URL。 */
function buildAuthorizeUrl(input) {
	const url = new URL(`${SITE_ORIGIN}${AUTHORIZE_PATH}`);
	url.searchParams.set("login_source", LOGIN_SOURCE);
	url.searchParams.set("appname", AUTHORIZE_APP_NAME);
	url.searchParams.set("state", input.state);
	url.searchParams.set("redirect", input.redirectUrl);
	url.searchParams.set("desktop_callback", DESKTOP_CALLBACK);
	return url.href;
}
/** 回调时回给浏览器的那一页；必须在收到请求后立刻响应。 */
function callbackPage(ok, message) {
	const title = ok ? "登录成功" : "登录未完成";
	return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;background:#f6f7f9;color:#1f2328}
main{max-width:32rem;padding:2rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .75rem}p{margin:0;line-height:1.7;color:#57606a}</style>
</head><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;
}
/**
* 建登录管理器。
*
* @param options - 上游客户端、保存与校验回调、浏览器启动器。
* @returns 管理器；同一时刻最多一个会话。
*/
function createLoginManager(options) {
	const now = options.now ?? (() => Date.now());
	const randomState = options.randomState ?? defaultState;
	let current = idle();
	let server;
	let expectedState = "";
	let deadline = 0;
	let disposed = false;
	/** 关掉本地回调服务器并释放端口。 */
	const closeServer = async () => {
		const handle = server;
		server = void 0;
		if (handle === void 0) return;
		await new Promise((resolve) => {
			handle.closeAllConnections?.();
			handle.close(() => {
				resolve();
			});
		});
	};
	const finish = (patch) => {
		current = {
			...current,
			...patch
		};
		return current;
	};
	const fail = (code, message) => {
		closeServer();
		return finish({
			running: false,
			phase: "error",
			message,
			error: {
				code,
				message
			}
		});
	};
	/** 拿到码之后的公共后半程：换令牌 → 探目录 → 保存。 */
	const complete = async (input) => {
		finish({
			phase: "validating",
			message: "正在校验账号…",
			qrSvg: null
		});
		if (!await options.validate(input.accessToken).catch(() => false)) return fail("token-rejected", "网关拒绝了这次登录令牌，请重新登录");
		let nickname;
		try {
			nickname = (await options.client.fetchUserInfo(input.accessToken)).nickname;
		} catch {}
		const account = await options.toAccount({
			source: input.kind === "qr" ? "qr" : "web",
			accessToken: input.accessToken,
			refreshToken: input.refreshToken,
			...input.identity === void 0 ? {} : { identity: input.identity },
			...input.orgName === void 0 ? {} : { orgName: input.orgName },
			...input.orgRole === void 0 ? {} : { orgRole: input.orgRole },
			...nickname === void 0 ? {} : { nickname }
		});
		await options.save(account);
		const label = account.nickname ?? account.id;
		return finish({
			running: false,
			phase: "done",
			message: `登录成功：${label}`,
			url: null,
			port: null,
			qrSvg: null,
			error: null
		});
	};
	/** 用授权码换令牌并保存。 */
	const redeemCode = async (code, kind) => {
		finish({
			phase: "exchanging",
			message: "正在换取登录凭证…"
		});
		try {
			const pair = await options.client.exchangeAuthorizationCode(code);
			return await complete({
				kind,
				accessToken: pair.accessToken,
				refreshToken: pair.refreshToken,
				...pair.identity === void 0 ? {} : { identity: pair.identity },
				...pair.orgName === void 0 ? {} : { orgName: pair.orgName },
				...pair.orgRole === void 0 ? {} : { orgRole: pair.orgRole }
			});
		} catch (error) {
			if (error.code === "code-not-found") return fail("code-expired", "授权码已失效（一次性，可能已用过），请重新发起登录");
			return fail("upstream-error", error instanceof Error ? error.message : "换取登录凭证失败");
		}
	};
	return {
		view() {
			if (current.running && current.kind === "web" && now() >= deadline) {
				closeServer();
				current = {
					...current,
					running: false,
					phase: "expired",
					message: "登录超时，请重新发起",
					url: null,
					port: null,
					error: {
						code: "login-timeout",
						message: "登录超时，请重新发起"
					}
				};
			}
			return current;
		},
		async startWeb() {
			if (disposed) return idle();
			if (current.running) return current;
			await closeServer();
			expectedState = randomState();
			deadline = now() + LOGIN_TIMEOUT_MS;
			let port = 0;
			const waiting = new Promise((resolve) => {
				const handle = createServer((req, res) => {
					const url = new URL(req.url ?? "/", "http://127.0.0.1");
					if (url.pathname !== "/auth/callback") {
						res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
						res.end("not found");
						return;
					}
					const code = url.searchParams.get("code") ?? url.searchParams.get("authorization_code") ?? "";
					const state = url.searchParams.get("state") ?? "";
					if (code === "" || !safeEqual(state, expectedState)) {
						res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
						res.end(callbackPage(false, "回调缺少授权码，或 state 校验失败。请回到 DSH 重新发起登录。"));
						closeServer();
						finish({
							running: false,
							phase: "error",
							message: "回调 state 校验失败，已拒绝这次登录",
							error: {
								code: "state-mismatch",
								message: "回调 state 校验失败"
							}
						});
						resolve();
						return;
					}
					res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
					res.end(callbackPage(true, "可以关闭此页，回到 DSH 继续。"));
					resolve();
					redeemCode(code, "web").finally(() => {
						closeServer();
					});
				});
				handle.once("error", () => {
					resolve();
				});
				handle.listen(0, "127.0.0.1", () => {
					port = handle.address()?.port ?? 0;
					resolve();
				});
				server = handle;
			});
			current = {
				running: true,
				kind: "web",
				phase: "waiting",
				message: "正在准备本地登录服务…",
				url: null,
				port: null,
				qrSvg: null,
				expiresAtMs: deadline,
				error: null
			};
			await waiting;
			if (port === 0) {
				current = idle("web");
				return fail("network-error", "无法在本地回环地址上监听回调端口");
			}
			const redirectUrl = `http://127.0.0.1:${String(port)}${CALLBACK_PATH}`;
			const url = buildAuthorizeUrl({
				state: expectedState,
				redirectUrl
			});
			const opened = options.openBrowser(url);
			current = {
				...current,
				phase: "waiting",
				message: opened ? "已在浏览器里打开授权页：登录后本页会自动完成，无需复制任何东西。" : "浏览器没能自动打开，请点下面的链接手动打开授权页。",
				url,
				port
			};
			return current;
		},
		async startQr() {
			if (disposed) return idle("qr");
			if (current.running) return current;
			await closeServer();
			deadline = now() + LOGIN_TIMEOUT_MS;
			current = {
				running: true,
				kind: "qr",
				phase: "waiting",
				message: "正在获取二维码…",
				url: null,
				port: null,
				qrSvg: null,
				expiresAtMs: deadline,
				error: null
			};
			try {
				const session = await options.client.startQr();
				const qrSvg = renderQrSvg(options.client.qrContent(session), { size: 220 });
				const userInterval = options.pollIntervalMs?.();
				const intervalMs = Math.min(QR_POLL_MAX_MS, Math.max(QR_POLL_MIN_MS, session.pollIntervalMs, userInterval ?? 0));
				current = {
					...current,
					message: "请用微信扫描二维码（小程序内确认）",
					qrSvg,
					expiresAtMs: now() + session.expiresInSec * 1e3
				};
				const code = session.code;
				const poll = async () => {
					for (;;) {
						if (disposed || !current.running || current.kind !== "qr") return;
						if (now() >= deadline) {
							fail("login-timeout", "登录超时，请重新发起扫码");
							return;
						}
						await new Promise((resolve) => {
							setTimeout(resolve, intervalMs).unref?.();
						});
						const outcome = await options.client.pollQr(code).catch(() => void 0);
						if (outcome === void 0) continue;
						if (outcome.status === "success" && outcome.accessToken !== void 0) {
							await complete({
								kind: "qr",
								accessToken: outcome.accessToken,
								refreshToken: ""
							});
							return;
						}
						if (outcome.status === "canceled") {
							fail("login-cancelled", "你取消了这次授权，请重新发起");
							return;
						}
						if (outcome.status === "expired" || outcome.status === "error") {
							fail(outcome.status === "expired" ? "qr-expired" : "upstream-error", outcome.message ?? "二维码已失效");
							return;
						}
						if (outcome.status === "scanning") current = {
							...current,
							message: "已扫码，请在手机上确认"
						};
					}
				};
				poll();
				return current;
			} catch (error) {
				return fail("upstream-error", error instanceof Error ? error.message : "获取二维码失败");
			}
		},
		async submitCode(text) {
			if (disposed) return idle();
			if (expectedState === "") return fail("state-mismatch", "没有进行中的网页登录，请先点「网页登录」再粘授权码");
			const parsed = extractAuthorizationCode(text, expectedState);
			if ("error" in parsed) return fail("state-mismatch", parsed.error);
			return await redeemCode(parsed.code, "web");
		},
		async cancel() {
			await closeServer();
			if (current.running) current = {
				...current,
				running: false,
				phase: "cancelled",
				message: "已取消登录",
				qrSvg: null
			};
		},
		dispose() {
			disposed = true;
			closeServer();
		}
	};
}
// src/host/status.ts
/**
* 状态文档：浏览器半边唯一能读到的数据形状。
*
* 这里是 `docs/CONTRACT.md` 里那份 JSON 的**唯一生产者**。字段只增不改 ——
* 页面没有类型检查，少一个字段不会报错，只会显示空白，所以契约文件与本文件
* 必须一起改。
*
* 不变量：文档里**永不出现** access token / refresh token / cookie。
*
* @module dsh-connect-raccoon/host/status
*/
/** 账号在列表里的排序：当前 → 池成员 → 其余，再按到期时间升序。 */
function sortAccounts(views, currentId) {
	return [...views].sort((left, right) => {
		if (left.id === currentId && right.id !== currentId) return -1;
		if (right.id === currentId && left.id !== currentId) return 1;
		if (left.inPool !== right.inPool) return left.inPool ? -1 : 1;
		return left.expiresAtMs - right.expiresAtMs;
	});
}
/** 把一条仓库记录转成页面用的形状。 */
function toAccountView(input) {
	const { account } = input;
	const nickname = account.nickname ?? null;
	const label = nickname ?? `${account.source === "desktop" ? "桌面端" : "小浣熊"}账号 · ${account.id.slice(-6)}`;
	return {
		id: account.id,
		label,
		nickname,
		identity: account.identity ?? null,
		orgName: account.orgName ?? null,
		source: account.source,
		isDesktopSource: account.source === "desktop",
		expiresAtMs: account.expiresAtMs,
		refreshExpiresAtMs: account.refreshExpiresAtMs,
		usable: input.usable.usable,
		reason: input.usable.reason ?? null,
		inPool: input.inPool,
		isCurrent: input.currentId === account.id,
		credits: input.credits === void 0 ? null : {
			total: input.credits.total,
			expiringSoon: input.credits.expiringSoon,
			nearestExpiryMs: input.credits.nearestExpiryMs ?? null,
			fetchedAtMs: input.creditsAtMs ?? 0
		},
		lastProbe: account.probe ?? null,
		cooldownUntilMs: input.cooldownMs > 0 ? input.nowMs + input.cooldownMs : null,
		canCheckin: account.identity !== "enterprise" && account.identity !== "education"
	};
}
/**
* 构建状态文档。
*
* @param input - 当前全部运行时事实。
* @returns 可直接下发给页面的文档。
*/
function buildStatus(input) {
	const memberIds = new Set(input.memberIds);
	const views = input.accounts.map((entry) => toAccountView({
		account: entry.account,
		usable: entry.usable,
		credits: entry.credits,
		...entry.creditsAtMs === void 0 ? {} : { creditsAtMs: entry.creditsAtMs },
		cooldownMs: entry.cooldownMs,
		currentId: input.currentAccountId,
		inPool: memberIds.has(entry.account.id),
		nowMs: input.nowMs
	}));
	const desktop = input.desktop;
	const adopted = views.some((view) => view.isDesktopSource);
	return {
		schemaVersion: 1,
		version: VERSION,
		provider: input.provider,
		enabled: input.enabled,
		updatedAtMs: input.nowMs,
		desktop: {
			detected: desktop?.credential !== void 0,
			configDir: desktop?.configDir ?? "",
			authPath: desktop?.authPath ?? "",
			exists: desktop?.exists ?? false,
			readable: desktop?.readable ?? false,
			multiAccount: false,
			reason: desktop?.reason ?? null,
			nickname: desktop?.credential?.nickname ?? null,
			expiresAtMs: desktop?.credential?.expiresAtMs ?? null,
			keyOrderMatchesApp: desktop?.keyOrderMatchesApp ?? false,
			adopted
		},
		accounts: sortAccounts(views, input.currentAccountId),
		currentAccountId: input.currentAccountId ?? null,
		effectiveAccountId: input.effectiveAccountId ?? null,
		effectiveReason: input.effectiveReason,
		pool: {
			enabled: input.poolEnabled,
			memberIds: [...input.memberIds],
			lastFailover: input.lastFailover
		},
		catalog: {
			source: input.catalog.source,
			count: input.catalog.models.length,
			fetchedAtMs: input.catalog.fetchedAtMs,
			error: input.catalog.error,
			models: input.catalog.models.map((model) => ({
				id: model.id,
				name: model.name,
				description: model.description ?? null,
				vision: model.vision,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				multiplier: model.multiplier,
				promo: model.promo ?? null,
				reasoning: model.reasoning,
				enabled: !input.state.disabledModels.includes(model.id)
			}))
		},
		login: input.login,
		checkin: {
			supported: views.some((view) => view.canCheckin),
			lastRunAtMs: input.checkin.lastRunAtMs,
			results: input.checkin.results
		},
		state: {
			disabledModels: [...input.state.disabledModels],
			accountPoolEnabled: input.state.accountPoolEnabled,
			enabledAccounts: [...input.state.enabledAccounts],
			composerPill: input.state.composerPill,
			pollIntervalMs: input.state.pollIntervalMs,
			autoCheckin: input.state.autoCheckin,
			reuseDesktop: input.reuseDesktop
		}
	};
}
// src/host/runtime.ts
/**
* 运行时：把仓库、账号、目录、登录与上游客户端编成一份「界面能读的状态 + 能执行的动作」。
*
* 这一层是**唯一**持有可变状态的地方（目录缓存、最近换号记录、签到结果）。
* 它不做渲染（那是浏览器半边）、不做协议解析（那是 `protocol/`）、
* 也不决定令牌怎么续（那是 `credentials/`）。
*
* 不变量：① 任何动作都不把令牌写进返回值；② 目录永远有值（最差是内置兜底），
* 因为空目录会让模型选择器整组消失且不会自己恢复。
*
* @module dsh-connect-raccoon/host/runtime
*/
/**
* 建运行时。
*
* @param options - 仓库、账号、上游客户端与状态读写。
* @returns 运行时。
*/
function createRuntime(options) {
	const now = options.now ?? (() => Date.now());
	/** 目录缓存；初始就是兜底表（选择器不能空着）。 */
	let catalog = {
		models: [...FALLBACK_CATALOG],
		fetchedAtMs: 0,
		source: "fallback"
	};
	let catalogError = null;
	let desktopProbe = null;
	let lastFailover = null;
	let lastCheckin = {
		lastRunAtMs: null,
		results: []
	};
	let disposed = false;
	/** 目录写入口：唯一一处更新缓存 + 通知 adapter。 */
	const setCatalog = (next, error) => {
		catalog = next;
		catalogError = error;
		options.onCatalog?.(visibleModels(next.models, options.state().disabledModels));
	};
	/** 拉一次目录；失败保留旧目录并记下原因（绝不清空）。 */
	const refreshCatalog = async (accessToken) => {
		if (accessToken === void 0) return;
		try {
			const live = await options.client.fetchCatalog(accessToken);
			setCatalog(live, null);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			catalogError = message;
			if (catalog.source === "fallback") setCatalog({ ...catalog }, message);
			options.warn(`刷新模型目录失败（继续使用现有目录）：${message}`);
		}
	};
	/**
	* 挑一个可用于「读目录」等只读操作的账号。
	*
	* 目录与桌面端探测都不该因为「用户还没勾选池成员」而失败 ——
	* 这里退回到「当前选用，其次第一个可用账号」。
	*/
	const anyUsableAccount = async () => {
		const selected = await options.vault.readSelected();
		if (selected !== void 0) {
			const account = await options.vault.get(selected);
			if (account !== void 0) return account;
		}
		return (await options.vault.list())[0];
	};
	const login = createLoginManager({
		client: options.client,
		warn: options.warn,
		openBrowser: options.openBrowser,
		now,
		pollIntervalMs: () => options.state().pollIntervalMs,
		async toAccount(input) {
			const facts = decodeJwtFacts(input.accessToken);
			const refreshFacts = input.refreshToken === "" ? {} : decodeJwtFacts(input.refreshToken);
			const key = facts.accountKey ?? refreshFacts.accountKey ?? input.accessToken;
			return {
				schemaVersion: 1,
				id: accountIdFor(key),
				accountKey: key,
				accessToken: input.accessToken,
				refreshToken: input.refreshToken,
				expiresAtMs: facts.expiresAtMs ?? 0,
				refreshExpiresAtMs: refreshFacts.expiresAtMs ?? 0,
				source: input.source,
				savedAtMs: now(),
				...input.nickname === void 0 ? {} : { nickname: input.nickname },
				...input.identity === void 0 ? {} : { identity: input.identity },
				...input.orgName === void 0 ? {} : { orgName: input.orgName },
				...input.orgRole === void 0 ? {} : { orgRole: input.orgRole }
			};
		},
		async save(account) {
			await options.vault.save(account);
			await options.vault.writeSelected(account.id);
		},
		async validate(accessToken) {
			try {
				await options.client.fetchCatalog(accessToken);
				return true;
			} catch {
				return false;
			}
		}
	});
	/** 当前账号对应的可用令牌；读不到就返回 undefined（不抛给界面）。 */
	const tokenOfSelected = async () => {
		const account = await anyUsableAccount();
		if (account === void 0) return void 0;
		try {
			return await options.accounts.accessToken(account.id);
		} catch (error) {
			options.warn(`取账号令牌失败：${error instanceof Error ? error.message : String(error)}`);
			return;
		}
	};
	/** 状态文档里「下一次请求实际会用谁」的理由文案。 */
	const effectiveOf = async () => {
		const state = options.state();
		const selected = await options.vault.readSelected();
		const candidates = (await options.vault.list()).map((account) => ({
			id: account.id,
			inPool: state.enabledAccounts.includes(account.id),
			usable: options.accounts.usability(account).usable,
			credits: void 0,
			nearestExpiryMs: void 0,
			expiresAtMs: account.expiresAtMs
		}));
		const choice = pickAccount({
			poolEnabled: state.accountPoolEnabled,
			currentId: selected,
			candidates,
			nowMs: now()
		});
		return {
			id: choice.id,
			reason: choice.reason
		};
	};
	const buildStatusDocument = async () => {
		const state = options.state();
		const selected = await options.vault.readSelected();
		const all = await options.vault.list();
		const effective = await effectiveOf();
		const entries = await Promise.all(all.map(async (account) => ({
			account,
			usable: options.accounts.usability(account),
			credits: await options.accounts.credits(account.id),
			cooldownMs: options.accounts.cooldownMs(account.id)
		})));
		return buildStatus({
			provider: PROVIDER,
			enabled: options.config().enabled,
			nowMs: now(),
			desktop: desktopProbe,
			accounts: entries,
			currentAccountId: selected,
			effectiveAccountId: effective.id,
			effectiveReason: effective.reason,
			poolEnabled: state.accountPoolEnabled,
			memberIds: state.enabledAccounts,
			lastFailover,
			catalog: {
				source: catalog.source,
				fetchedAtMs: catalog.fetchedAtMs === 0 ? null : catalog.fetchedAtMs,
				error: catalogError,
				models: visibleModels(catalog.models, state.disabledModels)
			},
			login: login.view(),
			checkin: lastCheckin,
			state,
			reuseDesktop: options.config().reuseDesktop
		});
	};
	/** 动作失败时抛出的错误带稳定 code（路由层把它放进响应）。 */
	const actionError = (code, message) => Object.assign(new Error(message), { code });
	/** 校验 body 里的账号 id 存在。 */
	/**
	* 把桌面端探测的分类码翻成一句能让用户立刻行动的话。
	*
	* @param code - `DesktopReason` 之一（也可能是 adoptDesktop 自己给的配置类原因）。
	* @returns 面向用户的一句话。
	*/
	const desktopHint = (code) => {
		switch (code) {
			case "desktop-missing": return "本机没装小浣熊桌面端（找不到 ~/.box-agent/config/auth.json）。没有客户端就用「网页登录」或「扫码登录」";
			case "desktop-unreadable": return "找到了客户端凭据文件，但没有读权限。检查文件权限，或用网页登录";
			case "desktop-no-token": return "客户端凭据文件在，但里面没有可用的登录令牌 —— 先在小浣熊客户端里登录一次，再回来点这个按钮";
			case "desktop-encrypted": return "客户端凭据是加密的，本插件解不开。请改用网页登录";
			default: return `没能从桌面端读到登录态（${code}）`;
		}
	};
	const requireAccountId = (body) => {
		const id = body["accountId"];
		if (typeof id !== "string" || id === "") throw actionError("bad-request", "缺少 accountId");
		return id;
	};
	/**
	* 读一个**可选**的字符串数组字段。
	*
	* 缺省返回 `undefined`（表示「全部/默认」）；给了但不是字符串数组就明确报错。
	* 不能像以前那样「不是数组就当没给」—— 那样界面传错类型时会被静默当成
	* 「导出全部」，用户以为只导了一个号，实际把整池都写进了文件。
	*/
	const readOptionalIds = (body, field) => {
		const value = body[field];
		if (value === void 0) return void 0;
		if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw actionError("bad-request", `${field} 必须是字符串数组`);
		return value;
	};
	return {
		login,
		catalog: () => visibleModels(catalog.models, options.state().disabledModels),
		async status() {
			if (now() - catalog.fetchedAtMs > 6e5) tokenOfSelected().then((token) => refreshCatalog(token));
			if (desktopProbe === null && options.config().reuseDesktop) desktopProbe = await options.accounts.probeDesktop();
			return await buildStatusDocument();
		},
		async run(action, body) {
			switch (action) {
				case "refresh": {
					const force = body["force"] === true;
					if (desktopProbe === null || force) desktopProbe = await options.accounts.probeDesktop();
					await refreshCatalog(await tokenOfSelected());
					return {
						ok: true,
						status: await buildStatusDocument()
					};
				}
				case "login-web": return {
					ok: true,
					login: await login.startWeb()
				};
				case "login-qr": return {
					ok: true,
					login: await login.startQr()
				};
				case "login-status": return {
					ok: true,
					login: login.view()
				};
				case "cancel-login":
					await login.cancel();
					return {
						ok: true,
						login: login.view()
					};
				case "login-code": {
					const text = body["text"];
					if (typeof text !== "string" || text.trim() === "") throw actionError("bad-request", "请粘贴授权码或整条回调地址");
					const view = await login.submitCode(text);
					return {
						ok: view.phase === "done",
						login: view
					};
				}
				case "adopt-desktop": {
					const probe = desktopProbe ?? await options.accounts.probeDesktop();
					desktopProbe = probe;
					const adopted = await options.accounts.adoptDesktop(probe);
					if (!adopted.ok) {
						const code = adopted.reason ?? "desktop-missing";
						throw actionError(code, desktopHint(code));
					}
					return {
						ok: true,
						accountId: adopted.account?.id,
						status: await buildStatusDocument()
					};
				}
				case "switch-account":
					await options.accounts.select(requireAccountId(body));
					return {
						ok: true,
						status: await buildStatusDocument()
					};
				case "remove-account": {
					const id = requireAccountId(body);
					await options.accounts.remove(id);
					if (await options.vault.readSelected() === id) {
						const remaining = await options.vault.list();
						await options.vault.writeSelected(remaining[0]?.id);
					}
					const state = options.state();
					if (state.enabledAccounts.includes(id)) await options.saveState({ enabledAccounts: state.enabledAccounts.filter((item) => item !== id) });
					return {
						ok: true,
						status: await buildStatusDocument()
					};
				}
				case "members": {
					const ids = readOptionalIds(body, "ids");
					if (ids === void 0) throw actionError("bad-request", "缺少 ids");
					const known = new Set((await options.vault.list()).map((account) => account.id));
					const filtered = ids.filter((id) => known.has(id));
					await options.saveState({ enabledAccounts: filtered });
					return {
						ok: true,
						status: await buildStatusDocument()
					};
				}
				case "settings": {
					const patch = body["patch"];
					if (patch === null || typeof patch !== "object" || Array.isArray(patch)) throw actionError("bad-request", "patch 必须是对象");
					const record = patch;
					const allowed = {};
					if (Array.isArray(record["disabledModels"])) allowed.disabledModels = record["disabledModels"].filter((item) => typeof item === "string");
					if (typeof record["accountPoolEnabled"] === "boolean") allowed.accountPoolEnabled = record["accountPoolEnabled"];
					if (typeof record["composerPill"] === "boolean") allowed.composerPill = record["composerPill"];
					if (typeof record["pollIntervalMs"] === "number") allowed.pollIntervalMs = record["pollIntervalMs"];
					if (typeof record["autoCheckin"] === "boolean") allowed.autoCheckin = record["autoCheckin"];
					if (Array.isArray(record["enabledAccounts"])) allowed.enabledAccounts = record["enabledAccounts"].filter((item) => typeof item === "string");
					const next = await options.saveState(allowed);
					options.onCatalog?.(visibleModels(catalog.models, next.disabledModels));
					return {
						ok: true,
						status: await buildStatusDocument()
					};
				}
				case "test-account": {
					const outcome = await testAccount(requireAccountId(body), typeof body["modelId"] === "string" ? body["modelId"] : void 0);
					return {
						ok: outcome.outcome === "ok",
						probe: outcome
					};
				}
				case "checkin": {
					const ids = readOptionalIds(body, "accountIds") ?? options.state().enabledAccounts;
					const results = [];
					for (const id of ids) results.push(await checkinOne(id));
					lastCheckin = {
						lastRunAtMs: now(),
						results
					};
					return {
						ok: true,
						results
					};
				}
				case "export-accounts": {
					const requested = readOptionalIds(body, "accountIds");
					const all = await options.vault.list();
					const ids = requested ?? all.map((account) => account.id);
					const chosen = all.filter((account) => ids.includes(account.id));
					const preview = chosen.map((account) => ({
						id: account.id,
						nickname: account.nickname ?? null,
						identity: account.identity ?? null,
						orgName: account.orgName ?? null,
						source: account.source,
						expiresAtMs: account.expiresAtMs,
						hasAccessToken: account.accessToken !== "",
						hasRefreshToken: account.refreshToken !== ""
					}));
					const path = await writeExport(chosen);
					return {
						ok: true,
						count: chosen.length,
						path,
						text: JSON.stringify({
							version: 1,
							accounts: preview
						}, null, 2)
					};
				}
				case "import-accounts": {
					const text = body["text"];
					if (typeof text !== "string" || text.trim() === "") throw actionError("bad-request", "请粘贴导入内容");
					const outcome = await importAccounts(text);
					return {
						ok: true,
						imported: outcome.imported,
						skipped: outcome.skipped
					};
				}
				default: throw actionError("bad-request", `未知动作：${String(action)}`);
			}
		},
		async warm() {
			if (disposed) return;
			if (options.config().reuseDesktop) {
				desktopProbe = await options.accounts.probeDesktop();
				if (desktopProbe.credential !== void 0) await options.accounts.adoptDesktop(desktopProbe);
			}
			await refreshCatalog(await tokenOfSelected());
		},
		dispose() {
			disposed = true;
			login.dispose();
		}
	};
	/** 测一个账号此刻可用性：发一次真实的最小对话（会花钱，所以按次点击）。 */
	async function testAccount(id, modelId) {
		const model = modelId ?? catalog.models[0]?.id ?? FALLBACK_CATALOG[0]?.id ?? "sensenova-6.8-flash-lite";
		try {
			const token = await options.accounts.accessToken(id);
			await (await options.client.chatStream({
				accessToken: token,
				body: {
					model,
					messages: [{
						role: "user",
						content: "ping"
					}],
					stream: false,
					max_tokens: 1
				}
			})).text().catch(() => "");
			return {
				accountId: id,
				outcome: "ok",
				message: "可用",
				atMs: now()
			};
		} catch (error) {
			const failure = error instanceof RaccoonError ? error : void 0;
			return {
				accountId: id,
				outcome: failure?.code === "rate-limited" ? "rate-limited" : failure?.code === "out-of-credit" ? "out-of-credit" : failure?.code === "authorization-verify" ? "rejected" : "failed",
				message: error instanceof Error ? error.message : String(error),
				atMs: now()
			};
		}
	}
	/** 给一个账号签到：先读状态避免重复领取，再触发一次发放。 */
	async function checkinOne(id) {
		try {
			const token = await options.accounts.accessToken(id);
			if (todayAlreadyClaimed(await options.client.fetchBills(token), now())) return {
				accountId: id,
				outcome: "already",
				message: "今天已经领过"
			};
			await options.client.settingInfo(token);
			return todayAlreadyClaimed(await options.client.fetchBills(token), now()) ? {
				accountId: id,
				outcome: "claimed",
				message: "已领取今日积分"
			} : {
				accountId: id,
				outcome: "pending",
				message: "已请求发放，上游这次没有入账记录"
			};
		} catch (error) {
			return {
				accountId: id,
				outcome: "failed",
				message: error instanceof Error ? error.message : String(error)
			};
		}
	}
	/**
	* 把选中的账号写成一份可迁移的 JSON 文件。
	*
	* 为什么要落文件而不是回给页面：完整的迁移需要令牌，而令牌不能进浏览器。
	* 返回值只有路径；页面显示的预览是脱敏的那份。
	*
	* @param accounts - 要导出的账号。
	* @returns 文件的绝对路径。
	*/
	async function writeExport(accounts) {
		const dir = join(options.vault.rootDir(), "exports");
		await mkdir(dir, {
			recursive: true,
			mode: 448
		});
		const path = join(dir, `raccoon-accounts-${String(now())}.json`);
		const body = {
			version: 1,
			exportedAtMs: now(),
			accounts: accounts.map((account) => ({
				id: account.id,
				nickname: account.nickname ?? null,
				identity: account.identity ?? null,
				orgName: account.orgName ?? null,
				source: account.source,
				expiresAtMs: account.expiresAtMs,
				accessToken: account.accessToken,
				refreshToken: account.refreshToken
			}))
		};
		await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, {
			encoding: "utf8",
			mode: 384
		});
		return path;
	}
	/**
	* 把一段 JSON 里的账号导入仓库。
	*
	* 只接受**带令牌**的记录：脱敏导出（只有昵称与到期时间）无法回灌 —— 换台机器
	* 要恢复登录只能重新登录，这一点在 CONTRACT 里写明，不让用户以为导出是备份。
	*
	* @param text - 用户粘贴的 JSON。
	* @returns 导入与跳过的条数。
	*/
	async function importAccounts(text) {
		let parsed;
		try {
			parsed = JSON.parse(text);
		} catch {
			throw actionError("bad-request", "粘贴的内容不是合法 JSON");
		}
		if (parsed === null || typeof parsed !== "object") throw actionError("bad-request", "粘贴的内容不是 JSON 对象");
		const list = parsed["accounts"];
		if (!Array.isArray(list)) throw actionError("bad-request", "缺少 accounts 数组");
		let imported = 0;
		let skipped = 0;
		for (const raw of list) {
			if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
				skipped += 1;
				continue;
			}
			const record = raw;
			const accessToken = typeof record["accessToken"] === "string" ? record["accessToken"].trim() : "";
			const refreshToken = typeof record["refreshToken"] === "string" ? record["refreshToken"].trim() : "";
			if (accessToken === "") {
				skipped += 1;
				continue;
			}
			const facts = decodeJwtFacts(accessToken);
			const refreshFacts = refreshToken === "" ? {} : decodeJwtFacts(refreshToken);
			const key = facts.accountKey ?? refreshFacts.accountKey ?? accessToken;
			const sourceRaw = record["source"];
			const source = sourceRaw === "web" || sourceRaw === "qr" || sourceRaw === "desktop" || sourceRaw === "import" ? sourceRaw : "import";
			const nicknameRaw = record["nickname"];
			await options.vault.save({
				schemaVersion: 1,
				id: accountIdFor(key),
				accountKey: key,
				accessToken,
				refreshToken,
				expiresAtMs: facts.expiresAtMs ?? 0,
				refreshExpiresAtMs: refreshFacts.expiresAtMs ?? 0,
				source,
				savedAtMs: now(),
				...typeof nicknameRaw === "string" && nicknameRaw !== "" ? { nickname: nicknameRaw } : {}
			});
			imported += 1;
		}
		if (imported === 0) throw actionError("bad-request", "没有可导入的账号：粘贴的记录里没有访问令牌（脱敏导出不能回灌）");
		return {
			imported,
			skipped
		};
	}
}
function todayAlreadyClaimed(bills, nowMs) {
	const beijing = new Date(nowMs + 288e5).toISOString().slice(0, 10);
	return JSON.stringify(bills).includes(beijing);
}
// src/host/routes.ts
/** 动作白名单（路由层校验用，与类型同源）。 */
const ACTIONS = [
	"refresh",
	"login-web",
	"login-qr",
	"login-status",
	"login-code",
	"cancel-login",
	"adopt-desktop",
	"switch-account",
	"remove-account",
	"members",
	"settings",
	"test-account",
	"checkin",
	"import-accounts",
	"export-accounts"
];
/** 请求体上限：这条路由只收开关，不该有更大的东西。 */
const MAX_BODY_BYTES$1 = 65536;
/**
* 判断 Host 头是不是本机。
*
* `127.0.0.0/8` 的任意地址、`localhost`、`[::1]` / `::1` 都算；其余一律不算
* （宁可误拒，不可误放）。
*
* @param host - `Host` 头原值（可能带端口）。
* @returns 本机为 true。
*/
function isLoopbackHost(host) {
	if (host === void 0) return false;
	const trimmed = host.trim().toLowerCase();
	if (trimmed === "") return false;
	if (trimmed === "::1") return true;
	const name = trimmed.replace(/:\d+$/, "");
	if (name === "localhost" || name === "[::1]" || name === "::1") return true;
	const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name);
	if (ipv4 === null) return false;
	return Number(ipv4[1]) === 127;
}
/** 写一个 JSON 响应。 */
function sendJson(res, status, payload) {
	if (res.headersSent) return;
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		"Content-Length": Buffer.byteLength(body)
	});
	res.end(body);
}
/** 读请求体，超上限就截断（body 只是开关，截断足够安全）。 */
function readBody$1(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES$1) {
				chunks.push(chunk.subarray(0, Math.max(0, MAX_BODY_BYTES$1 - (size - chunk.length))));
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			resolve(Buffer.concat(chunks).toString("utf8"));
		});
		req.on("error", reject);
	});
}
/** 把 `{action, ...}` 请求体解析成结构化输入；坏输入返回错误响应所需的信息。 */
function parseAction(raw) {
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { error: "请求体不是合法 JSON" };
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "请求体必须是 JSON 对象" };
	const record = parsed;
	const action = record["action"];
	if (typeof action !== "string" || !ACTIONS.includes(action)) return { error: `未知动作：${String(action)}` };
	return {
		action,
		body: record
	};
}
/**
* 注册两条路由。
*
* @param ctx - 宿主上下文（只用到 `inject(['webServer'])`）。
* @param deps - 状态与动作的实现。
*/
function registerRoutes(ctx, deps) {
	ctx.inject(["webServer"], (webCtx) => {
		webCtx.effect(() => webCtx.webServer.register({
			kind: "exact",
			path: STATUS_PATH,
			handler: (req, res) => {
				if (!isLoopbackHost(req.headers.host)) {
					sendJson(res, 403, {
						ok: false,
						error: {
							code: "loopback-only",
							message: "只接受本机请求"
						}
					});
					return;
				}
				if (req.method !== "GET") {
					sendJson(res, 405, {
						ok: false,
						error: {
							code: "method-not-allowed",
							message: "只接受 GET"
						}
					});
					return;
				}
				deps.status().then((status) => {
					sendJson(res, 200, status);
				}).catch((error) => {
					sendJson(res, 500, {
						ok: false,
						error: {
							code: "status-failed",
							message: error instanceof Error ? error.message : String(error)
						}
					});
				});
			}
		}));
		webCtx.effect(() => webCtx.webServer.register({
			kind: "exact",
			path: ACTION_PATH,
			handler: (req, res) => {
				if (!isLoopbackHost(req.headers.host) && !isLoopbackOrigin(req.headers.origin)) {
					sendJson(res, 403, {
						ok: false,
						error: {
							code: "loopback-only",
							message: "只接受本机请求"
						}
					});
					return;
				}
				if (req.method !== "POST") {
					sendJson(res, 405, {
						ok: false,
						error: {
							code: "method-not-allowed",
							message: "只接受 POST"
						}
					});
					return;
				}
				readBody$1(req).then((raw) => {
					const parsed = parseAction(raw);
					if ("error" in parsed) {
						sendJson(res, 400, {
							ok: false,
							error: {
								code: "bad-request",
								message: parsed.error
							}
						});
						return;
					}
					return deps.action(parsed.action, parsed.body).then((result) => {
						sendJson(res, 200, result);
					}, (error) => {
						sendJson(res, 200, {
							ok: false,
							error: {
								code: typeof error.code === "string" ? error.code : "action-failed",
								message: error instanceof Error ? error.message : String(error)
							}
						});
					});
				}).catch((error) => {
					sendJson(res, 400, {
						ok: false,
						error: {
							code: "bad-request",
							message: error instanceof Error ? error.message : String(error)
						}
					});
				});
			}
		}));
	});
}
/** 动作路由放宽的条件：Host 缺失时还有 Origin 可判（某些客户端不回传 Host）。 */
function isLoopbackOrigin(origin) {
	if (origin === void 0) return false;
	try {
		return isLoopbackHost(new URL(origin).host);
	} catch {
		return false;
	}
}
/** 打包成 `PiAiAdapterOptions.auth`。 */
const INERT_AUTH = {
	credentials: {
		async read() {},
		async list() {
			return [];
		},
		async modify() {
			throw new Error("dsh-connect-raccoon: 小浣熊路由没有 pi-ai 凭据生命周期");
		},
		async delete() {}
	},
	authContext: {
		async env() {},
		async fileExists() {
			return false;
		}
	}
};
// src/llm/adapter.ts
/**
* DSH LLM 接入层：把本地 shim 包成一个 pi-ai provider。
*
* 这一层刻意很薄：协议翻译不存在（上游本就是 OpenAI 兼容），真正的工作在
* `shim/server.ts`（换号）与 `protocol/`（上游契约）。这里只负责三件事：
* 把目录映射成 pi-ai 的 `Model`；构造 `PiAiAdapterOptions`；每次请求用 shim 的
* 共享密钥当 apiKey —— 真实的令牌不出宿主进程。
*
* @module dsh-connect-raccoon/llm/adapter
*/
/** 小浣熊按积分计费，没有可得的按 token 单价：报 0（不伪造价格）。 */
const NO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
/** provider 展示名。 */
const DISPLAY_NAME = "商汤小浣熊";
/**
* 思考档位映射。
*
* 上游对 `reasoning_effort` 只做**部分**校验：随便写的哨兵值也返回 200，
* 所以「某档返回 200」证明不了它被真正执行（见 `docs/PROTOCOL.md`）。
* 因此这里不声明任何档位，只在模型自身声明 reasoning 时把开关打开 ——
* 宁可没有档位控制，也不给五个看起来能用、实际被忽略的选项。
*/
const THINKING_LEVELS = {
	low: "low",
	medium: "medium",
	high: "high"
};
/** 把一个目录条目变成 pi-ai 的 chat model。 */
function toPiModel(info, baseUrl) {
	return {
		id: info.id,
		name: info.name,
		api: "openai-completions",
		provider: PROVIDER,
		baseUrl,
		input: info.vision ? ["text", "image"] : ["text"],
		cost: NO_COST,
		contextWindow: info.contextWindow,
		maxTokens: info.maxTokens,
		reasoning: info.reasoning,
		...info.reasoning ? {
			thinkingLevelMap: { ...THINKING_LEVELS },
			compat: { supportsReasoningEffort: true }
		} : {}
	};
}
/**
* 构造 pi-ai provider + PiAiAdapter。
*
* @param options - 目录与 shim 身份的读取器。
* @returns 可直接交给 `ctx.llm.registerAdapter` 的 adapter。
*/
function createRaccoonAdapter(options) {
	const modelsBase = () => `${options.baseUrl()}/v1`;
	const buildProvider = () => createProvider({
		id: PROVIDER,
		name: DISPLAY_NAME,
		auth: { apiKey: {
			name: "小浣熊（本地 shim）",
			async resolve({ credential }) {
				const key = credential?.key;
				return key === void 0 || key.length === 0 ? void 0 : {
					auth: { apiKey: key },
					source: DISPLAY_NAME
				};
			}
		} },
		models: options.catalog().map((info) => toPiModel(info, modelsBase())),
		api: openAICompletionsApi()
	});
	const profileFor = (providerKey) => {
		const provider = buildProvider();
		return {
			provider: providerKey,
			displayName: DISPLAY_NAME,
			streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
			retryPolicy: resolveRetryPolicy(void 0, "dsh-connect-raccoon retryPolicy"),
			configuredMaxTokens: /* @__PURE__ */ new Map(),
			modelErrors: /* @__PURE__ */ new Map(),
			...REQUEST_IMAGE_BUDGETS,
			piProvider: providerKey === "raccoon" ? provider : {
				...provider,
				id: providerKey
			}
		};
	};
	let profiles = /* @__PURE__ */ new Map([[PROVIDER, profileFor(PROVIDER)]]);
	return {
		adapter: new PiAiAdapter({
			profiles: () => profiles,
			auth: INERT_AUTH,
			resolveApiKey: async () => options.token()
		}),
		invalidate: () => {
			profiles = /* @__PURE__ */ new Map([[PROVIDER, profileFor(PROVIDER)]]);
		}
	};
}
/**
* 把目录条目转成 DSH 的 `LlmModelInfo`（模型发现接口要用）。
*
* @param models - 目录。
* @returns DSH 侧的模型描述；`badge` 用上游促销文案。
*/
function toLlmModelInfos(models) {
	return models.map((model) => ({
		provider: PROVIDER,
		id: model.id,
		name: model.name,
		description: model.multiplier === "" ? `${String(Math.round(model.contextWindow / 1e3))}K 上下文` : `${String(Math.round(model.contextWindow / 1e3))}K 上下文 · 倍率 ${model.multiplier}`,
		inputModalities: model.vision ? ["text", "image"] : ["text"],
		...model.promo === void 0 ? {} : { badge: {
			text: model.promo,
			tone: "info"
		} }
	}));
}
// src/shim/server.ts
/**
* 本地回环 shim：唯一目的在于「让换号发生在第一个字节之前」。
*
* 小浣熊的对话网关本来就是 OpenAI 兼容的，所以这里**不做协议翻译** ——
* 不做字段改名、不改 SSE 帧、不折叠流。它只做 pi-ai 做不到的三件事：
*   1. 按账号池挑身份（pi-ai 一个调用只冻结一个身份）；
*   2. 未吐出任何字节前，可换号重试（ADR-6）；
*   3. 把上游错误归一成稳定的 `error.code` 交给宿主。
*
* 安全：`listen(0, '127.0.0.1')` 随机端口 + 进程内随机 secret；未带正确
* secret 的请求一律 401。即使别的进程扫到端口也调不动它。
*
* @module dsh-connect-raccoon/shim/server
*/
const MAX_BODY_BYTES = 33554432;
const SHIM_PATH = "/v1/chat/completions";
/** 读完整请求体；超过上限直接失败。 */
function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new RaccoonError({
					code: "bad-request",
					message: "请求体过大",
					status: 413
				}));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			resolve(Buffer.concat(chunks).toString("utf8"));
		});
		req.on("error", reject);
	});
}
/** 写一个 OpenAI 形状的错误响应。 */
function writeError(res, status, code, message) {
	if (res.headersSent) return;
	const body = JSON.stringify({ error: {
		message,
		type: code,
		code
	} });
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(body)
	});
	res.end(body);
}
/** 上游错误 → 对下游的状态码与文案（换号已在此前决定过，这里只负责告知）。 */
function statusOf(error) {
	const status = error.status;
	return typeof status === "number" && status >= 400 && status <= 599 ? status : 502;
}
/** HTTP 状态 → 换号分类码。分类决定宿主给这个账号记多久冷却。 */
function codeForStatus(status) {
	if (status === 401 || status === 403) return "authorization-verify";
	if (status === 429) return "rate-limited";
	if (status === 400) return "bad-request";
	if (status === 404) return "model-not-found";
	return "upstream-error";
}
/** 该失败是否值得换下一个账号。 */
function worthFailover(error) {
	if (error instanceof RaccoonError) return error.retriableWithOtherAccount;
	return false;
}
/** 从一次上游响应里读出一句可读的错误说明。 */
async function upstreamMessage(response) {
	try {
		const text = await response.text();
		if (text.length === 0) return `上游返回 HTTP ${String(response.status)}`;
		try {
			const parsed = JSON.parse(text);
			if (parsed !== null && typeof parsed === "object") {
				const record = parsed;
				const direct = record["message"];
				if (typeof direct === "string" && direct.length > 0) return direct;
				const nested = record["error"];
				if (nested !== null && typeof nested === "object") {
					const inner = nested["message"];
					if (typeof inner === "string" && inner.length > 0) return inner;
				}
			}
		} catch {}
		return text.slice(0, 300);
	} catch {
		return `上游返回 HTTP ${String(response.status)}`;
	}
}
/**
* 启动 shim。
*
* @param options - 尝试序列、上游调用与日志。
* @returns 句柄；`baseUrl` 与 `token` 交给 adapter。
*/
async function startShim(options) {
	const token = randomBytes(32).toString("base64url");
	const warn = options.onWarn ?? (() => {});
	const server = createServer((req, res) => {
		handle(req, res).catch((error) => {
			writeError(res, 502, "shim-error", error instanceof Error ? error.message : String(error));
		});
	});
	/** 把一次上游响应透传下去；从这一刻起不再换号。 */
	async function relay(response, res) {
		const contentType = response.headers.get("content-type") ?? "application/json";
		const isEventStream = contentType.includes("text/event-stream");
		res.writeHead(200, {
			"Content-Type": contentType,
			"Cache-Control": "no-cache",
			...isEventStream ? { Connection: "keep-alive" } : {}
		});
		if (response.body === null) {
			res.end();
			return;
		}
		const reader = response.body.getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				res.write(value);
			}
			res.end();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!res.writableEnded) {
				res.write(`data: ${JSON.stringify({ error: {
					message,
					type: "upstream_error"
				} })}\n\n`);
				res.end();
			}
		} finally {
			reader.releaseLock();
		}
	}
	async function handle(req, res) {
		if (new URL(req.url ?? "/", "http://127.0.0.1").pathname !== SHIM_PATH) {
			writeError(res, 404, "not-found", "not found");
			return;
		}
		if (req.method !== "POST") {
			writeError(res, 405, "method-not-allowed", "method not allowed");
			return;
		}
		if ((/^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1]?.trim() ?? "") !== token) {
			writeError(res, 401, "unauthorized", "unauthorized");
			return;
		}
		const raw = await readBody(req);
		let body;
		try {
			const parsed = JSON.parse(raw);
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
				writeError(res, 400, "bad-request", "请求体必须是 JSON 对象");
				return;
			}
			body = parsed;
		} catch {
			writeError(res, 400, "bad-request", "请求体不是合法 JSON");
			return;
		}
		const model = typeof body["model"] === "string" ? body["model"] : "";
		const attempts = await options.attempts({ model });
		if (attempts.length === 0) {
			writeError(res, 503, "not-configured", "没有可用的小浣熊账号，请先在插件设置里登录");
			return;
		}
		const controller = new AbortController();
		req.on("aborted", () => {
			controller.abort();
		});
		let lastError;
		/**
		* 记一次「这个账号这次没成」。
		*
		* 每次**放弃一个账号**就报一次，而不是等下一个账号成功才报：
		* 全池都失败时也必须让宿主知道每个账号都试过（冷却要按账号记），
		* 否则下一个请求会从头再烧一遍同样的失败。
		*/
		const reportGiveUp = (accountId, nextId, error) => {
			if (nextId === void 0) return;
			options.onFailover?.({
				fromId: accountId,
				toId: nextId,
				reason: messageOf(error),
				code: errorCodeOf(error)
			});
		};
		for (let index = 0; index < attempts.length; index += 1) {
			const attempt = attempts[index];
			const nextId = attempts[index + 1]?.accountId;
			let accessToken;
			try {
				accessToken = await attempt.accessToken();
			} catch (error) {
				lastError = error;
				reportGiveUp(attempt.accountId, nextId, error);
				continue;
			}
			let response;
			try {
				response = await options.chat({
					accessToken,
					body,
					signal: controller.signal
				});
			} catch (error) {
				lastError = error;
				if (controller.signal.aborted) break;
				if (!worthFailover(error)) {
					writeError(res, statusOf(error), errorCodeOf(error), messageOf(error));
					return;
				}
				warn(`账号 ${attempt.accountId} 失败（${messageOf(error)}），尝试换号`);
				reportGiveUp(attempt.accountId, nextId, error);
				continue;
			}
			if (!response.ok) {
				const message = await upstreamMessage(response);
				lastError = new RaccoonError({
					code: codeForStatus(response.status),
					message,
					status: response.status
				});
				if (response.status === 400 || response.status === 404) {
					writeError(res, response.status, "upstream-error", message);
					return;
				}
				reportGiveUp(attempt.accountId, nextId, lastError);
				continue;
			}
			await relay(response, res);
			return;
		}
		writeError(res, statusOf(lastError), errorCodeOf(lastError), messageOf(lastError));
	}
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (address === null) {
		server.close();
		throw new Error("shim 未能取得监听端口");
	}
	return {
		baseUrl: `http://127.0.0.1:${String(address.port)}`,
		token,
		close: () => new Promise((resolve) => {
			server.closeAllConnections?.();
			server.close(() => {
				resolve();
			});
		})
	};
}
/** 错误里的稳定分类码。 */
function errorCodeOf(error) {
	if (error instanceof RaccoonError) return error.code;
	return "upstream-error";
}
/** 错误里的可读文案（已是中文的不再包装）。 */
function messageOf(error) {
	if (error instanceof Error) return error.message;
	return String(error);
}
// src/index.ts
/**
* Cordis 插件入口：装配仓库、账号、运行时、LLM 注册与宿主路由。
*
* 装配顺序很重要：**adapter 注册不能等网络** —— 目录先用内置兜底注册上，
* 登录态可用时再替换。否则「刚装好还没登录」的用户会看到选择器里一个模型都没有，
* 而那个空选择器不会自己变好（除非重启）。
*
* 这里只负责接线：谁先谁后、谁在卸载时释放什么。真正的行为在
* `host/runtime.ts`（状态与动作）、`protocol/`（上游契约）、
* `credentials/`（登录态）、`shim/server.ts`（换号）里，各自可单测。
*
* @module dsh-connect-raccoon
*/
/** 插件名（Cordis 用它做诊断前缀）。 */
const name = "dsh-connect-raccoon";
/** 依赖的服务：没有 llm 就没有模型路由可注册。 */
const inject = ["llm"];
/**
* 用系统默认浏览器打开一个 URL。
*
* Windows 上**不能**走 `cmd /c start`：cmd 会把 URL 里的 `&` 当成命令分隔符，
* 浏览器只拿到 `?login_source=desktop` 那一段（缺 redirect 与 state），授权页会
* 直接判为普通网页登录、不再回调本地端口。
*
* 用两条路径，因为单靠一条会静默失败：`rundll32` 稳定返回 0，
* `explorer.exe` 有时浏览器仍然弹出来但退出码是 1。
*
* @param url - 要打开的地址。
* @returns 是否至少有一条启动路径被系统接受。
*/
function openBrowser(url) {
	if (process.platform !== "win32") {
		const command = process.platform === "darwin" ? "open" : "xdg-open";
		try {
			spawn(command, [url], {
				detached: true,
				stdio: "ignore"
			}).unref();
			return true;
		} catch {
			return false;
		}
	}
	const launchers = [["rundll32.exe", ["url.dll,FileProtocolHandler", url]], ["explorer.exe", [url]]];
	let opened = false;
	for (const [file, args] of launchers) try {
		const child = spawn(file, args, {
			detached: true,
			stdio: "ignore",
			windowsHide: true
		});
		child.on("error", () => void 0);
		child.unref();
		opened = true;
	} catch {}
	return opened;
}
/**
* 插件应用函数。
*
* @param ctx - Cordis 上下文。
* @param rawConfig - 用户在设置页填的配置。
*/
async function apply(ctx, rawConfig) {
	const config = {
		...Config({}),
		...rawConfig
	};
	const warn = (message) => {
		ctx.logger.warn(`[${name}] ${message}`);
	};
	const home = dshHome();
	const vault = createVault({ home });
	const client = createRaccoonClient({
		warn,
		siteOrigin: config.siteOrigin
	});
	const refresher = createRefresher({
		warn,
		siteOrigin: config.siteOrigin
	});
	const accountState = { current: await readState({ home }) };
	/** 目录：先兜底，登录态可用后换成网关那份。 */
	let catalog = [...FALLBACK_CATALOG];
	let shim;
	let runtime;
	let adapter;
	let disposed = false;
	const accounts = createAccounts({
		vault,
		client,
		refresher,
		warn,
		reuseDesktop: () => config.reuseDesktop,
		writeBackDesktop: () => config.writeBackDesktop
	});
	runtime = createRuntime({
		vault,
		accounts,
		client,
		warn,
		openBrowser,
		state: () => accountState.current,
		async saveState(patch) {
			accountState.current = await writeState(patch, { home });
			return accountState.current;
		},
		config: () => ({
			enabled: config.enabled,
			reuseDesktop: config.reuseDesktop
		}),
		onCatalog: (models) => {
			catalog = [...models];
			adapter?.invalidate();
		}
	});
	shim = await startShim({
		attempts: async ({ model }) => {
			const state = accountState.current;
			const all = await vault.list();
			const selected = await vault.readSelected();
			const candidates = all.map((account) => ({
				id: account.id,
				inPool: state.enabledAccounts.includes(account.id),
				usable: accounts.usability(account).usable,
				credits: void 0,
				nearestExpiryMs: void 0,
				expiresAtMs: account.expiresAtMs
			}));
			const choice = pickAccount({
				poolEnabled: state.accountPoolEnabled,
				currentId: selected,
				candidates
			});
			return [choice.id, ...failoverCandidates({
				poolEnabled: state.accountPoolEnabled,
				currentId: selected,
				candidates,
				firstId: choice.id
			})].filter((id) => id !== void 0).slice(0, Math.max(1, config.maxFailoverAttempts)).map((id) => ({
				accountId: id,
				accessToken: () => accounts.accessToken(id)
			}));
		},
		chat: (input) => client.chatStream({
			accessToken: input.accessToken,
			body: input.body,
			signal: input.signal
		}),
		onFailover: (detail) => {
			warn(`自动换号：${detail.fromId} → ${detail.toId}（${detail.code}：${detail.reason}）`);
			const ms = detail.code === "rate-limited" || detail.code === "authorization-verify" ? 6e5 : 6e4;
			accounts.markCooldown(detail.fromId, ms);
		},
		onWarn: warn
	});
	adapter = createRaccoonAdapter({
		catalog: () => catalog,
		baseUrl: () => shim?.baseUrl ?? "http://127.0.0.1:1",
		token: () => shim?.token ?? ""
	});
	const releaseAdapter = ctx.llm.registerAdapter([PROVIDER], adapter.adapter);
	const releaseDirectory = ctx.llm.registerConfigurableProviders([{
		provider: PROVIDER,
		displayName: "商汤小浣熊",
		settingsNs: SETTINGS_NS,
		settingsPath: [],
		declared: false
	}]);
	ctx.llm.registerModelDiscovery(SETTINGS_NS, async (request) => {
		if (request.provider !== void 0 && request.provider !== "raccoon") return [];
		if (!config.enabled) return [];
		return toLlmModelInfos(catalog);
	});
	registerRoutes(ctx, {
		status: () => runtime?.status() ?? Promise.resolve({}),
		action: (action, body) => runtime?.run(action, body) ?? Promise.resolve({ ok: false })
	});
	ctx.effect(() => async () => {
		disposed = true;
		runtime?.dispose();
		releaseDirectory();
		releaseAdapter();
		const closing = shim?.close();
		shim = void 0;
		adapter = void 0;
		runtime = void 0;
		if (closing !== void 0) await closing;
	});
	if (config.warmOnStart) setTimeout(() => {
		if (disposed) return;
		runtime?.warm().catch((error) => {
			warn(`预热失败（不影响模型路由）：${error instanceof Error ? error.message : String(error)}`);
		});
	}, 0).unref?.();
	const offUpdate = ctx.on("loader/volatile-update", () => {
		if (disposed) return;
		runtime?.warm().catch(() => void 0);
	});
	if (typeof offUpdate === "function") ctx.effect(() => offUpdate);
	ctx.logger.info(`[${name}] v${VERSION} 已启动：${String(catalog.length)} 个模型（shim ${shim.baseUrl}）`);
}
export { apply, inject, name };
