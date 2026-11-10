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

import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { RaccoonError } from '../protocol/errors.ts';
import { findFailureInChunk, isRateLimitedFrame } from '../protocol/sse.ts';

/** shim 启动后的句柄。 */
export interface ShimHandle {
  /** `http://127.0.0.1:<port>`；adapter 自己拼 `/v1`（与 `openai-completions` 的约定一致）。 */
  readonly baseUrl: string;
  /** 共享密钥，adapter 用它当 apiKey。 */
  readonly token: string;
  /** 关闭监听并释放端口。 */
  close(): Promise<void>;
}

/** shim 需要的一件事：按池顺序给出这次要试的账号。 */
export interface ShimAttempt {
  /** 账号 id（只用于日志与换号记录）。 */
  accountId: string;
  /** 该账号此刻的访问令牌；拿不到时由调用方抛错。 */
  accessToken: () => Promise<string>;
}

/** shim 的依赖。 */
export interface ShimOptions {
  /**
   * 本次请求的尝试序列（第一个是首选）。
   *
   * 每次请求调用一次 —— 池状态会变（限流冷却、积分变化），不能启动时算死。
   */
  attempts: (input: { model: string }) => Promise<ShimAttempt[]>;
  /** 发一次上游对话请求；返回未消费的响应。 */
  chat: (input: { accessToken: string; body: unknown; signal: AbortSignal }) => Promise<Response>;
  /** 换号发生时通知宿主（卡片上要显示「这次用了谁」，并据此给失败账号记冷却）。 */
  onFailover?: (detail: { fromId: string; toId: string; reason: string; code: string }) => void;
  /** 诊断日志。 */
  onWarn?: (message: string) => void;
}

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const SHIM_PATH = '/v1/chat/completions';

/** 读完整请求体；超过上限直接失败。 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new RaccoonError({ code: 'bad-request', message: '请求体过大', status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

/** 写一个 OpenAI 形状的错误响应。 */
function writeError(res: ServerResponse, status: number, code: string, message: string): void {
  if (res.headersSent) return;
  const body = JSON.stringify({ error: { message, type: code, code } });
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** 上游错误 → 对下游的状态码与文案（换号已在此前决定过，这里只负责告知）。 */
function statusOf(error: unknown): number {
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && status >= 400 && status <= 599 ? status : 502;
}

/** HTTP 状态 → 换号分类码。分类决定宿主给这个账号记多久冷却。 */
function codeForStatus(status: number): RaccoonError['code'] {
  if (status === 401 || status === 403) return 'authorization-verify';
  if (status === 429) return 'rate-limited';
  if (status === 400) return 'bad-request';
  if (status === 404) return 'model-not-found';
  return 'upstream-error';
}

/** 该失败是否值得换下一个账号。 */
function worthFailover(error: unknown): boolean {
  if (error instanceof RaccoonError) return error.retriableWithOtherAccount;
  return false;
}

/** 从一次上游响应里读出一句可读的错误说明。 */
async function upstreamMessage(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (text.length === 0) return `上游返回 HTTP ${String(response.status)}`;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed !== null && typeof parsed === 'object') {
        const record = parsed as Record<string, unknown>;
        const direct = record['message'];
        if (typeof direct === 'string' && direct.length > 0) return direct;
        const nested = record['error'];
        if (nested !== null && typeof nested === 'object') {
          const inner = (nested as Record<string, unknown>)['message'];
          if (typeof inner === 'string' && inner.length > 0) return inner;
        }
      }
    } catch {
      // 不是 JSON：原文就是唯一的信息。
    }
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
export async function startShim(options: ShimOptions): Promise<ShimHandle> {
  const token = randomBytes(32).toString('base64url');
  const warn = options.onWarn ?? ((): void => {});

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      writeError(res, 502, 'shim-error', error instanceof Error ? error.message : String(error));
    });
  });

  /**
   * 把一次上游响应透传下去；从这一刻起不再换号。
   *
   * 但**要认得出流里的错误帧**：上游会把限流藏在 200 响应的
   * `data: {"error":{"code":"user_model_rate_limited"}}` 里。不认的话，
   * 这次失败既不会记冷却、也不会告诉宿主，用户只看到回复被截断，
   * 下一个请求还会再挑同一个账号，白烧一遍。
   *
   * 这里只**观察**、不改写：字节原样转发（改写有把正常响应改坏的风险），
   * 发现错误帧就通过 `onFailover` 报一次「本账号这次失败了、但换不了号」。
   */
  async function relay(response: Response, res: ServerResponse, accountId: string): Promise<void> {
    const contentType = response.headers.get('content-type') ?? 'application/json';
    const isEventStream = contentType.includes('text/event-stream');
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
      ...(isEventStream ? { Connection: 'keep-alive' } : {}),
    });
    if (response.body === null) {
      res.end();
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let failureReported = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
        if (!failureReported && isEventStream && value !== undefined) {
          const found = findFailureInChunk(decoder.decode(value, { stream: true }));
          if (found !== undefined) {
            failureReported = true;
            // 流已经开始，换不了号；但宿主必须知道「这个账号这次失败了」，
            // 否则它不会记冷却，下一个请求还会挑到同一个。
            options.onFailover?.({
              // from === to：这是「本账号这次没成、但已经没法换号」的上报，
              // 宿主据此记冷却，而不是真的换了号。
              fromId: accountId,
              toId: accountId,
              reason: found.message ?? found.code ?? '流内错误帧',
              code: isRateLimitedFrame(found) ? 'rate-limited' : 'upstream-error',
            });
          }
        }
      }
      res.end();
    } catch (error) {
      // 已经写过字节：只能把错误当成流内事件告诉宿主，不能重开一条回复。
      const message = error instanceof Error ? error.message : String(error);
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: { message, type: 'upstream_error' } })}\n\n`);
        res.end();
      }
    } finally {
      reader.releaseLock();
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== SHIM_PATH) {
      writeError(res, 404, 'not-found', 'not found');
      return;
    }
    if (req.method !== 'POST') {
      writeError(res, 405, 'method-not-allowed', 'method not allowed');
      return;
    }
    const presented = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]?.trim() ?? '';
    if (presented !== token) {
      writeError(res, 401, 'unauthorized', 'unauthorized');
      return;
    }

    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        writeError(res, 400, 'bad-request', '请求体必须是 JSON 对象');
        return;
      }
      body = parsed as Record<string, unknown>;
    } catch {
      writeError(res, 400, 'bad-request', '请求体不是合法 JSON');
      return;
    }

    const model = typeof body['model'] === 'string' ? body['model'] : '';
    const attempts = await options.attempts({ model });
    if (attempts.length === 0) {
      writeError(res, 503, 'not-configured', '没有可用的小浣熊账号，请先在插件设置里登录');
      return;
    }

    const controller = new AbortController();
    /**
     * 用户按下「停止」时必须真的把上游请求掐掉。
     *
     * 只挂 `req.on('aborted')` 不够 —— 那个事件**只在请求体还没读完时**触发。
     * 对话请求的请求体通常在一次 TCP 往返里就发完了，之后用户再按停止，
     * `aborted` 永远不会来，上游会继续跑到结束、继续烧这个账号的额度。
     * 已在 Node 24 上实测复现：请求体读完后 destroy 客户端，`aborted` 不触发、
     * 只有响应的 `close` 触发。
     *
     * 两条都挂：`aborted` 覆盖「发送中断」，`res.on('close')` 覆盖「已经写完请求体之后」。
     * `close` 在正常结束时也会触发，所以要判 `writableEnded` 区分。
     */
    req.on('aborted', () => { controller.abort(); });
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    let lastError: unknown;
    /**
     * 记一次「这个账号这次没成」。
     *
     * 每次**放弃一个账号**就报一次，而不是等下一个账号成功才报：
     * 全池都失败时也必须让宿主知道每个账号都试过（冷却要按账号记），
     * 否则下一个请求会从头再烧一遍同样的失败。
     */
    const reportGiveUp = (accountId: string, nextId: string | undefined, error: unknown): void => {
      if (nextId === undefined) return;
      options.onFailover?.({
        fromId: accountId,
        toId: nextId,
        reason: messageOf(error),
        code: errorCodeOf(error),
      });
    };

    for (let index = 0; index < attempts.length; index += 1) {
      const attempt = attempts[index]!;
      const nextId = attempts[index + 1]?.accountId;
      let accessToken: string;
      try {
        accessToken = await attempt.accessToken();
      } catch (error) {
        lastError = error;
        // 取不到令牌的账号有一次额外机会：换号前先让它自己的续期失败一次。
        reportGiveUp(attempt.accountId, nextId, error);
        continue;
      }
      let response: Response;
      try {
        response = await options.chat({ accessToken, body, signal: controller.signal });
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
        // 开关一次响应体不影响 `ok`：这里只为了给出可读文案与正确的分类码。
        // 分类码决定宿主给这个账号记多久冷却，所以不能一律归成 upstream-error。
        lastError = new RaccoonError({
          code: codeForStatus(response.status),
          message,
          status: response.status,
        });
        // 400/404 换谁都是同一个结果，只在这些状态上直接失败。
        if (response.status === 400 || response.status === 404) {
          writeError(res, response.status, 'upstream-error', message);
          return;
        }
        reportGiveUp(attempt.accountId, nextId, lastError);
        continue;
      }
      await relay(response, res, attempt.accountId);
      return;
    }

    const status = statusOf(lastError);
    writeError(res, status, errorCodeOf(lastError), messageOf(lastError));
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo | null;
  if (address === null) {
    server.close();
    throw new Error('shim 未能取得监听端口');
  }

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => { resolve(); });
      }),
  };
}

/** 错误里的稳定分类码。 */
function errorCodeOf(error: unknown): string {
  if (error instanceof RaccoonError) return error.code;
  return 'upstream-error';
}

/** 错误里的可读文案（已是中文的不再包装）。 */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
