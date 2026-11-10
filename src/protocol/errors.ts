/**
 * 上游失败的稳定分类。
 *
 * 换号策略与界面文案都按 `code` 判断，**不看文案** —— 上游的中文说明会变，
 * 且 `user_model_rate_limited` 的文案（「请求频率超限」）本身就是错的
 * （实测是吞吐墙，见 `docs/PROTOCOL.md`）。
 *
 * @module dsh-connect-raccoon/protocol/errors
 */

/** 上游失败的稳定分类。 */
export type UpstreamErrorCode =
  | 'authorization-empty'
  | 'authorization-verify'
  | 'token-invalid'
  | 'code-not-found'
  | 'rate-limited'
  | 'out-of-credit'
  | 'model-not-found'
  | 'bad-request'
  | 'qr-invalid'
  | 'qr-expired'
  | 'network-error'
  | 'timeout'
  | 'invalid-response'
  | 'upstream-error';

/** 小浣熊协议层的唯一错误类型。 */
export class RaccoonError extends Error {
  /** 稳定分类码；界面与换号策略都读它。 */
  readonly code: UpstreamErrorCode;
  /** 上游 HTTP 状态；本地错误为 0。 */
  readonly status: number;
  /** 上游业务码原文（`200035`、`user_model_rate_limited` 之类）；没有则为 `null`。 */
  readonly upstreamCode: string | number | null;
  /** 这个失败是否值得换一个账号重试。 */
  readonly retriableWithOtherAccount: boolean;

  /**
   * @param input.code - 稳定分类码。
   * @param input.message - 给用户看的中文；上游原文在未知码时保留。
   * @param input.status - 上游 HTTP 状态，本地错误省略。
   * @param input.upstreamCode - 上游业务码原文。
   * @param input.cause - 底层异常。
   */
  constructor(input: {
    code: UpstreamErrorCode;
    message: string;
    status?: number;
    upstreamCode?: string | number | null;
    cause?: unknown;
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = 'RaccoonError';
    this.code = input.code;
    this.status = input.status ?? 0;
    this.upstreamCode = input.upstreamCode ?? null;
    this.retriableWithOtherAccount = RETRIABLE.has(input.code);
  }
}

/**
 * 哪些分类值得换号。
 *
 * 400 一类不在此列：同一个请求体换谁都是 400，重试只会白等（ADR-6）。
 */
const RETRIABLE: ReadonlySet<UpstreamErrorCode> = new Set<UpstreamErrorCode>([
  'authorization-verify',
  'rate-limited',
  'out-of-credit',
  'upstream-error',
  'network-error',
  'timeout',
]);

/** 上游业务码 → 分类。每条都来自真实探针或上游代码取证。 */
export const UPSTREAM_CODE_MAP: Readonly<Record<string, UpstreamErrorCode>> = Object.freeze({
  // 业务鉴权（`docs/evidence/` 里的真实响应）
  '200001': 'authorization-empty',
  '200003': 'authorization-verify',
  '100002': 'token-invalid',
  '200035': 'code-not-found',
  // LLM 网关的吞吐墙（文案说「请求频率超限」，实测按体积触发）
  user_model_rate_limited: 'rate-limited',
  // 积分
  points_insufficient: 'out-of-credit',
  insufficient_points: 'out-of-credit',
  // 扫码
  AUTH_QRCODE_INVALID: 'qr-invalid',
  AUTH_QRCODE_EXPIRED: 'qr-expired',
  AUTH_QRCODE_NOT_FOUND: 'qr-expired',
});

/** 业务码原值 → 给人看的中文；未知码走「原文直出」。 */
const CODE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  '200001': '请求没有携带登录令牌',
  '200003': '登录态已失效，请换一个账号或重新登录',
  '100002': '续期凭据格式非法，请重新登录',
  '200035': '授权码已失效（一次性，可能已用过），请重新发起登录',
  user_model_rate_limited: '该模型的吞吐额度被限（不是请求频率），请稍后重发或换一个模型',
  AUTH_QRCODE_INVALID: '二维码无效，请重新发起扫码登录',
  AUTH_QRCODE_EXPIRED: '二维码已过期，请重新发起扫码登录',
  AUTH_QRCODE_NOT_FOUND: '二维码不存在或已失效，请重新发起扫码登录',
});

/** 从任意值里取一个字符串字段。 */
function stringOf(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** 从上游信封里取出 `code` 与 `message`（信封可能是 `{code,message}` 或 `{error:{...}}`）。 */
function envelopeOf(payload: unknown): { code: string | undefined; message: string | undefined } {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { code: undefined, message: undefined };
  }
  const record = payload as Record<string, unknown>;
  const nested = record['error'];
  const inner =
    nested !== null && typeof nested === 'object' && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : undefined;
  return {
    code: stringOf(record['code']) ?? (inner === undefined ? undefined : stringOf(inner['code'])),
    message: stringOf(record['message']) ?? (inner === undefined ? undefined : stringOf(inner['message'])),
  };
}

/** HTTP 状态 → 分类（业务码缺席或未知时的兜底）。 */
function classifyStatus(status: number): UpstreamErrorCode {
  if (status === 400) return 'bad-request';
  if (status === 401 || status === 403) return 'authorization-verify';
  if (status === 404) return 'model-not-found';
  if (status === 429) return 'rate-limited';
  // 5xx、以及任何没有专门分支的状态（3xx/418/…）都归到上游错误：
  // 它们是「这次请求没成」而不是「这个请求不合法」。
  return 'upstream-error';
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
export function classifyUpstream(input: {
  status: number;
  payload?: unknown;
  fallback?: string;
}): RaccoonError {
  const envelope = envelopeOf(input.payload);
  const upstreamCode = envelope.code;

  if (upstreamCode !== undefined) {
    const mapped = UPSTREAM_CODE_MAP[upstreamCode];
    if (mapped !== undefined) {
      return new RaccoonError({
        code: mapped,
        message: CODE_MESSAGES[upstreamCode] ?? envelope.message ?? input.fallback ?? `上游返回 ${upstreamCode}`,
        status: input.status,
        upstreamCode,
      });
    }
    // 未知业务码：原文直出，不猜语义（ADR-8）。
    return new RaccoonError({
      code: classifyStatus(input.status),
      message: envelope.message ?? input.fallback ?? `上游返回 ${upstreamCode}`,
      status: input.status,
      upstreamCode,
    });
  }

  return new RaccoonError({
    code: classifyStatus(input.status),
    message: envelope.message ?? input.fallback ?? `上游返回 HTTP ${String(input.status)}`,
    status: input.status,
  });
}

/**
 * 把 fetch 抛出的异常归一成 {@link RaccoonError}。
 *
 * @param error - 原始异常。
 * @param fallback - 兜底说明。
 * @returns 归一后的错误；已是 `RaccoonError` 时原样返回。
 */
export function classifyThrown(error: unknown, fallback?: string): RaccoonError {
  if (error instanceof RaccoonError) return error;
  const name = (error as { name?: unknown })?.name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new RaccoonError({
      code: 'timeout',
      message: fallback ?? '请求小浣熊超时',
      cause: error,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  // `fetch` 的失败一律是网络层：DNS、TLS、连接被重置都在这里。
  return new RaccoonError({
    code: 'network-error',
    message: fallback ?? `无法连接小浣熊服务：${message}`,
    cause: error,
  });
}
