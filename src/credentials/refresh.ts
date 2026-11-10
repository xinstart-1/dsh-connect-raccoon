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

import { REFRESH_COOLDOWN_MS, REQUEST_TIMEOUT_MS } from '../constants.ts';
import { endpointsOf } from '../protocol/client.ts';
import { decodeJwtFacts } from './vault.ts';

/** 一次成功续期的结果。 */
export interface RefreshOutcome {
  accessToken: string;
  refreshToken: string;
  /** 新访问令牌的到期时间（毫秒）；解不出时为 `now + 1h`。 */
  expiresAtMs: number;
}

/** 上游明确拒绝了这个续期凭据（要重新登录，不是重试）。 */
export class RefreshRejectedError extends Error {
  /** 稳定分类码；界面据此引导「重新登录」而不是「重试」。 */
  readonly code = 'refresh-rejected';
  /** 上游业务码原文。 */
  readonly upstreamCode: string | number | null;

  constructor(message: string, upstreamCode: string | number | null = null) {
    super(message);
    this.name = 'RefreshRejectedError';
    this.upstreamCode = upstreamCode;
  }
}

/** 刷新被限流，冷却中。 */
export class RefreshCooldownError extends Error {
  /** 稳定分类码。 */
  readonly code = 'refresh-cooldown';
  /** 还要等多少毫秒。 */
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(`小浣熊续期端点限流中，请 ${String(Math.ceil(retryAfterMs / 60_000))} 分钟后再试`);
    this.name = 'RefreshCooldownError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** 续期器。 */
export interface Refresher {
  /**
   * 刷新一个账号的令牌对；同 `accountKey` 的并发调用共享同一次请求。
   *
   * @param account - 账号标识与当前的续期令牌。
   * @param options.signal - 外部取消信号。
   * @returns 新的令牌对。
   * @throws {RefreshRejectedError} 上游拒绝该续期凭据时。
   * @throws {RefreshCooldownError} 处于 429 冷却期时。
   */
  refresh(
    account: { accountKey: string; refreshToken: string },
    options?: { signal?: AbortSignal },
  ): Promise<RefreshOutcome>;

  /** 该账号是否在冷却中；返回剩余毫秒数，不在冷却返回 0。 */
  cooldownMs(accountKey: string): number;
}

/** 去掉上游附带的 `Bearer ` 前缀。 */
function stripBearer(value: unknown): string {
  return typeof value === 'string' ? value.replace(/^Bearer\s+/i, '').trim() : '';
}

/** 取嵌套对象。 */
function obj(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * 建续期器。
 *
 * @param deps.fetchImpl - 注入的 fetch（测试用）。
 * @param deps.now - 注入时钟（测试用）。
 * @param deps.warn - 诊断日志。
 * @returns 续期器实例；生命周期与插件一致。
 */
export function createRefresher(deps: {
  fetchImpl?: typeof fetch;
  now?: () => number;
  warn?: (message: string) => void;
  /** 主站 origin；留空用内置地址。必须与上游客户端用同一个值，否则续期会打到别处。 */
  siteOrigin?: string;
} = {}): Refresher {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? ((): number => Date.now());
  const warn = deps.warn ?? ((): void => {});
  const endpoints = endpointsOf(deps.siteOrigin);
  /** 进行中的刷新：同账号的后来者直接等这一次。 */
  const inflight = new Map<string, Promise<RefreshOutcome>>();
  /** 冷却截止时间：限流是「此刻」的事实，不落盘。 */
  const cooldownUntil = new Map<string, number>();

  const cooldownMs = (accountKey: string): number => {
    const until = cooldownUntil.get(accountKey);
    if (until === undefined) return 0;
    const remaining = until - now();
    if (remaining <= 0) {
      cooldownUntil.delete(accountKey);
      return 0;
    }
    return remaining;
  };

  const once = async (refreshToken: string): Promise<RefreshOutcome> => {
    const response = await fetchImpl(`${endpoints.auth}/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'error',
    });
    const text = await response.text().catch(() => '');
    let parsed: unknown;
    try {
      parsed = text === '' ? undefined : (JSON.parse(text) as unknown);
    } catch {
      parsed = undefined;
    }
    const root = obj(parsed) ?? {};
    const code = root['code'];

    if (response.status === 429) {
      throw new RefreshCooldownError(REFRESH_COOLDOWN_MS);
    }
    if (!response.ok) {
      throw new RefreshRejectedError(
        `小浣熊续期失败（HTTP ${String(response.status)}）：${typeof root['message'] === 'string' ? root['message'] : '无错误说明'}`,
        typeof code === 'string' || typeof code === 'number' ? code : null,
      );
    }
    const data = obj(root['data']) ?? {};
    const accessToken = stripBearer(data['access_token']);
    if (accessToken === '') {
      throw new RefreshRejectedError(
        `小浣熊续期响应里没有访问令牌（code=${String(code ?? 'null')}）`,
        typeof code === 'string' || typeof code === 'number' ? code : null,
      );
    }
    // `refresh_token` 为空时沿用旧值：上游可能只轮转 access token。
    const rotated = stripBearer(data['refresh_token']);
    const facts = decodeJwtFacts(accessToken);
    return {
      accessToken,
      refreshToken: rotated === '' ? refreshToken : rotated,
      expiresAtMs: facts.expiresAtMs ?? now() + 3_600_000,
    };
  };

  return {
    cooldownMs,

    refresh(account, options) {
      const remaining = cooldownMs(account.accountKey);
      if (remaining > 0) return Promise.reject(new RefreshCooldownError(remaining));
      const existing = inflight.get(account.accountKey);
      if (existing !== undefined) return existing;

      if (account.refreshToken === '') {
        return Promise.reject(new RefreshRejectedError('这个账号没有续期凭据，请重新登录'));
      }

      const task = once(account.refreshToken)
        .catch((error: unknown) => {
          if (error instanceof RefreshCooldownError) {
            cooldownUntil.set(account.accountKey, now() + error.retryAfterMs);
            warn(`账号 ${account.accountKey} 续期被限流，冷却 ${String(Math.round(error.retryAfterMs / 60_000))} 分钟`);
          }
          throw error;
        })
        .finally(() => {
          inflight.delete(account.accountKey);
        });
      inflight.set(account.accountKey, task);
      void options; // 外部 signal 只影响单次调用方；共享的那次不能被任一调用方取消。
      return task;
    },
  };
}