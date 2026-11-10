import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RefreshCooldownError,
  RefreshRejectedError,
  createRefresher,
} from '../src/credentials/refresh.ts';
import { AUTH_BASE, REFRESH_COOLDOWN_MS } from '../src/constants.ts';

/** 一个够用的 fetch 响应形状：被测代码只用 ok / status / text()。 */
interface FakeResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}

function respond(status: number, payload: unknown): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  };
}

/** 记录调用次数的 fetch 替身；`reply` 决定第 n 次调用拿到什么。 */
function countingFetch(reply: () => FakeResponse | Promise<FakeResponse>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return await reply();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test('正常刷新：200 且 data 带两个新 token → strip Bearer 前缀、沿用新 refresh、expiresAtMs 在未来', async () => {
  const { impl, calls } = countingFetch(() => respond(200, {
    code: 0,
    data: { access_token: 'Bearer newA', refresh_token: 'newR' },
  }));
  const refresher = createRefresher({ fetchImpl: impl });
  const before = Date.now();

  const outcome = await refresher.refresh({ accountKey: 'k-normal', refreshToken: 'oldR' });

  assert.equal(outcome.accessToken, 'newA', 'access_token 的 "Bearer " 前缀应被去掉');
  assert.equal(outcome.refreshToken, 'newR', 'data.refresh_token 有值时应用新值');
  assert.ok(
    outcome.expiresAtMs > before,
    `没有 JWT exp 时 expiresAtMs 应回落到未来时间，实际是 ${outcome.expiresAtMs}（应 > ${before}）`,
  );
  assert.equal(calls.length, 1, '一次刷新只应发一次请求');
  assert.equal(calls[0]?.url, `${AUTH_BASE}/refresh`, '请求应发往续期端点');
});

test('refresh_token 为空：data.refresh_token 为 "" → 沿用传入的旧 refresh token', async () => {
  const { impl } = countingFetch(() => respond(200, {
    code: 0,
    data: { access_token: 'newA', refresh_token: '' },
  }));
  const refresher = createRefresher({ fetchImpl: impl });

  const outcome = await refresher.refresh({ accountKey: 'k-empty-rotated', refreshToken: 'oldR' });

  assert.equal(outcome.accessToken, 'newA', 'access_token 应正常更新');
  assert.equal(outcome.refreshToken, 'oldR', '上游没轮转 refresh_token 时必须沿用旧值，否则该账号立刻失效');
});

test('429 限流：抛 RefreshCooldownError → cooldownMs>0，冷却期内再刷新不再发请求', async () => {
  const { impl, calls } = countingFetch(() => respond(429, { code: 429, message: 'too many requests' }));
  const refresher = createRefresher({ fetchImpl: impl });

  await assert.rejects(
    refresher.refresh({ accountKey: 'k-429', refreshToken: 'r' }),
    (error: unknown) => {
      assert.ok(error instanceof RefreshCooldownError, `应抛 RefreshCooldownError，实际是 ${String(error)}`);
      return true;
    },
  );

  const remaining = refresher.cooldownMs('k-429');
  assert.ok(remaining > 0, `429 之后 cooldownMs 应大于 0，实际是 ${remaining}`);
  assert.ok(
    remaining <= REFRESH_COOLDOWN_MS,
    `冷却时长不应超过 REFRESH_COOLDOWN_MS=${REFRESH_COOLDOWN_MS}，实际是 ${remaining}`,
  );

  await assert.rejects(
    refresher.refresh({ accountKey: 'k-429', refreshToken: 'r' }),
    (error: unknown) => {
      assert.ok(error instanceof RefreshCooldownError, '冷却期内再刷新仍应抛 RefreshCooldownError');
      return true;
    },
  );
  assert.equal(calls.length, 1, '冷却期内不应再发请求（否则会把限流打成封禁）');
});

test('单飞：同 accountKey 并发两次 → fetch 只调 1 次，两次拿到同一份结果', async () => {
  const { impl, calls } = countingFetch(() => respond(200, {
    code: 0,
    data: { access_token: 'sharedA', refresh_token: 'sharedR' },
  }));
  const refresher = createRefresher({ fetchImpl: impl });

  const [first, second] = await Promise.all([
    refresher.refresh({ accountKey: 'k-single', refreshToken: 'r' }),
    refresher.refresh({ accountKey: 'k-single', refreshToken: 'r' }),
  ]);

  assert.equal(calls.length, 1, '同账号并发刷新只应发 1 次请求（refresh token 单次使用）');
  assert.equal(first, second, '两次调用应 resolve 出同一个结果对象');
  assert.equal(first.accessToken, 'sharedA', '结果 accessToken 应为上游给的新值');
  assert.equal(first.refreshToken, 'sharedR', '结果 refreshToken 应为上游轮转的新值');
});

test('401 拒绝：上游回 HTTP 401 + 业务码 → 抛 RefreshRejectedError 并带 upstreamCode', async () => {
  const { impl } = countingFetch(() => respond(401, { code: 200822, message: 'authorization_verify_error' }));
  const refresher = createRefresher({ fetchImpl: impl });

  await assert.rejects(
    refresher.refresh({ accountKey: 'k-401', refreshToken: 'stale' }),
    (error: unknown) => {
      assert.ok(error instanceof RefreshRejectedError, `应抛 RefreshRejectedError，实际是 ${String(error)}`);
      assert.equal(error.upstreamCode, 200822, 'upstreamCode 应保留上游业务码原文');
      assert.equal(error.code, 'refresh-rejected', 'code 应为稳定的 refresh-rejected');
      return true;
    },
  );
});

test('没有续期凭据：refreshToken 为 "" → 抛 RefreshRejectedError 且不发请求', async () => {
  const { impl, calls } = countingFetch(() => respond(200, { code: 0, data: { access_token: 'x' } }));
  const refresher = createRefresher({ fetchImpl: impl });

  await assert.rejects(
    refresher.refresh({ accountKey: 'k-no-token', refreshToken: '' }),
    (error: unknown) => {
      assert.ok(error instanceof RefreshRejectedError, `应抛 RefreshRejectedError，实际是 ${String(error)}`);
      assert.equal(error.code, 'refresh-rejected', 'code 应为 refresh-rejected');
      return true;
    },
  );
  assert.equal(calls.length, 0, '没有凭据时不应发出任何请求');
});

test('锁按账号隔离：不同 accountKey 并发 → fetch 被调用 2 次', async () => {
  const { impl, calls } = countingFetch(() => respond(200, {
    code: 0,
    data: { access_token: 'newA', refresh_token: 'newR' },
  }));
  const refresher = createRefresher({ fetchImpl: impl });

  const [left, right] = await Promise.all([
    refresher.refresh({ accountKey: 'k-a', refreshToken: 'r-a' }),
    refresher.refresh({ accountKey: 'k-b', refreshToken: 'r-b' }),
  ]);

  assert.equal(calls.length, 2, '不同账号是两把独立的锁，应各自发一次请求');
  assert.equal(left.accessToken, 'newA', 'k-a 的结果应正常返回');
  assert.equal(right.accessToken, 'newA', 'k-b 的结果应正常返回');
  assert.equal(refresher.cooldownMs('k-a'), 0, '成功刷新不应给 k-a 留下冷却');
  assert.equal(refresher.cooldownMs('k-b'), 0, '成功刷新不应给 k-b 留下冷却');
});

test('siteOrigin 生效：配了自建上游 → 续期请求打到那个 origin，而不是内置站点', async () => {
  const { impl, calls } = countingFetch(() => respond(200, {
    code: 0,
    data: { access_token: 'a', refresh_token: 'r' },
  }));
  const refresher = createRefresher({ fetchImpl: impl, siteOrigin: 'http://127.0.0.1:9999' });

  await refresher.refresh({ accountKey: 'k-origin', refreshToken: 'oldR' });

  assert.equal(
    calls[0]?.url,
    'http://127.0.0.1:9999/api/web/auth/v1/refresh',
    '续期必须跟随 siteOrigin，否则改了配置只有对话换地址、续期还打真实站点',
  );
});
