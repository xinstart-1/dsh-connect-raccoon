/**
 * SSE 流里的事件解析：上游把「限流」藏在 200 响应的 error 帧里。
 *
 * 为什么单开一个模块：同一个限流条件会以**两种形态**到达 ——
 * HTTP 429（好处理，响应头就能看出来）和 200 流里的一帧
 * `data: {"error":{"code":"user_model_rate_limited"}}`。后者最容易被漏掉：
 * HTTP 是成功的、连接正常关闭，看起来像一次正常结束，用户只看到回复被截断。
 *
 * 这里只做「这一帧是不是错误帧」的判断，不改写流 —— 透传是 shim 的职责，
 * 一旦开始重写字节就有把正常响应改坏的风险。
 *
 * @module dsh-connect-raccoon/protocol/sse
 */

/** 从一帧 SSE 数据里读出的失败信息。 */
export interface FrameFailure {
  /** 上游业务码（可能没有）。 */
  code?: string;
  /** 上游说明（可能没有）。 */
  message?: string;
}

/** 限流码：文案说「请求频率超限」，实测是吞吐墙（见 `docs/PROTOCOL.md`）。 */
const RATE_LIMIT_CODE = 'user_model_rate_limited';

/** 出现这些词也算限流（上游文案换过几次）。 */
const RATE_LIMIT_WORDS: readonly string[] = [RATE_LIMIT_CODE, 'rate_limit', '频率超限'];

/**
 * 从一帧 SSE 的 `data:` 负载里取出失败信息。
 *
 * 上游可能给的形状：
 * - `{"error":{"code":"…","message":"…"}}` —— 标准帧；
 * - `{"error":"…"}` —— 只有一句话；
 * - `{"code":200003,"message":"…"}` —— 信封直接放顶层（网关有时这么发）。
 *
 * @param payload - 已解析的 frame 对象。
 * @returns 失败信息；这一帧不是错误帧时返回 `undefined`。
 */
export function frameFailure(payload: unknown): FrameFailure | undefined {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;

  const nested = record['error'];
  if (nested !== undefined) {
    if (typeof nested === 'string') return nested === '' ? undefined : { message: nested };
    if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
      const inner = nested as Record<string, unknown>;
      const code = typeof inner['code'] === 'string' ? inner['code'] : undefined;
      const message = typeof inner['message'] === 'string' ? inner['message'] : undefined;
      if (code === undefined && message === undefined) return undefined;
      return { ...(code === undefined ? {} : { code }), ...(message === undefined ? {} : { message }) };
    }
    return undefined;
  }

  // 顶层的 {code, message} 只在「没有 choices」时才算失败：
  // 正常帧也有 code 字段的话，误判会把成功的回复当成错误。
  if (Array.isArray(record['choices'])) return undefined;
  const code = typeof record['code'] === 'string' || typeof record['code'] === 'number' ? String(record['code']) : undefined;
  const message = typeof record['message'] === 'string' ? record['message'] : undefined;
  if (code === undefined && message === undefined) return undefined;
  return { ...(code === undefined ? {} : { code }), ...(message === undefined ? {} : { message }) };
}

/**
 * 这一帧是不是「令牌吞吐墙」。
 *
 * 为什么单独判：这个条件下换号**有意义**（另一个账号可能还有额度），
 * 而普通的 4xx 换谁都一样。判错方向会让好账号被无谓地冷却。
 *
 * @param failure - {@link frameFailure} 的结果。
 * @returns 是限流为 true。
 */
export function isRateLimitedFrame(failure: FrameFailure | undefined): boolean {
  if (failure === undefined) return false;
  const haystack = `${failure.code ?? ''} ${failure.message ?? ''}`.toLowerCase();
  return RATE_LIMIT_WORDS.some((word) => haystack.includes(word.toLowerCase()));
}

/**
 * 从一段 SSE 原始文本里找出第一个错误帧。
 *
 * 只在**需要诊断**时调用（正常路径直接透传，不做逐帧解析，避免给每块数据
 * 都付一次 JSON.parse 的钱）。
 *
 * @param chunk - 一段 SSE 文本（可能只含半帧）。
 * @returns 找到的失败信息；没有则 `undefined`。
 */
export function findFailureInChunk(chunk: string): FrameFailure | undefined {
  for (const line of chunk.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const raw = trimmed.slice(5).trim();
    if (raw === '' || raw === '[DONE]') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      // 半帧（跨块被切断）解析失败是正常的，跳过。
      continue;
    }
    const failure = frameFailure(parsed);
    if (failure !== undefined) return failure;
  }
  return undefined;
}
