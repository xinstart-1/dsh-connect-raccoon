import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAuthorizeUrl,
  createLoginManager,
  extractAuthorizationCode,
  type LoginManager,
  type LoginResult,
} from '../src/host/login.ts';
import type { RaccoonClient } from '../src/protocol/client.ts';
import type { StoredAccount } from '../src/credentials/vault.ts';

const STATE = 'a'.repeat(64);

/** 造一条可保存的账号记录；`source` 由登录路径决定。 */
function accountFor(input: LoginResult): StoredAccount {
  return {
    schemaVersion: 1,
    id: 'acc_0000000000000001',
    accountKey: 'key-web',
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    expiresAtMs: 1_760_000_000_000,
    refreshExpiresAtMs: 1_760_260_000_000,
    source: input.source,
    savedAtMs: 1_759_999_000_000,
  };
}

/** 只实现 login.ts 用到的方法；其余端点这里用不到。 */
function fakeClient(patch: Partial<RaccoonClient> = {}): RaccoonClient {
  return {
    startQr: async () => ({ code: 'qr-x', scanPath: '/login/mp', expiresInSec: 300, pollIntervalMs: 1_000 }),
    pollQr: async () => ({ status: 'pending' }),
    qrContent: () => 'https://xiaohuanxiong.com/login/mp?app=rr',
    exchangeAuthorizationCode: async () => ({ accessToken: 'ACCESS', refreshToken: 'REFRESH' }),
    fetchUserInfo: async () => ({ nickname: '测试账号' }),
    ...patch,
  } as unknown as RaccoonClient;
}

interface Harness {
  manager: LoginManager;
  saved: StoredAccount[];
  warned: string[];
  opened: string[];
}

/** 建一个登录管理器；`validate` 默认通过，`openBrowser` 默认成功。 */
function harness(client: RaccoonClient, patch: { validateOk?: boolean; pollIntervalMs?: () => number } = {}): Harness {
  const saved: StoredAccount[] = [];
  const warned: string[] = [];
  const opened: string[] = [];
  const manager = createLoginManager({
    client,
    toAccount: async (input) => accountFor(input),
    save: async (account) => { saved.push(account); },
    validate: async () => patch.validateOk ?? true,
    openBrowser: (url) => { opened.push(url); return true; },
    warn: (message) => { warned.push(message); },
    ...(patch.pollIntervalMs === undefined ? {} : { pollIntervalMs: patch.pollIntervalMs }),
  });
  return { manager, saved, warned, opened };
}

/** 条件轮询：直到 predicate 为真或超时（默认 3 秒，每 50ms 一次）。 */
async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const startedAt = Date.now();
  for (;;) {
    if (predicate()) return true;
    if (Date.now() - startedAt >= timeoutMs) return false;
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
}

/** 从授权页 URL 里取回 state。 */
function stateOf(url: string | null): string {
  assert.notEqual(url, null, 'startWeb 之后 url 不应为 null');
  return new URL(url as string).searchParams.get('state') ?? '';
}

test('extractAuthorizationCode：裸码 → 直接当授权码', () => {
  const result = extractAuthorizationCode('  CODE-123  ', STATE);
  assert.deepEqual(result, { code: 'CODE-123' }, '没有 :// 也没有 code= 的文本应被当作裸授权码');
});

test('extractAuthorizationCode：整条 office-raccoon 回调 + 正确 state → 取出 code', () => {
  const result = extractAuthorizationCode(`office-raccoon://auth/callback?code=X&state=${STATE}`, STATE);
  assert.deepEqual(result, { code: 'X' }, `state 相符时应只返回 code，实际是 ${JSON.stringify(result)}`);
});

test('extractAuthorizationCode：state 不符 → 返回 error 而非 code', () => {
  const result = extractAuthorizationCode(`office-raccoon://auth/callback?code=X&state=${'b'.repeat(64)}`, STATE);
  assert.ok('error' in result, `state 不符时必须拒绝，实际是 ${JSON.stringify(result)}`);
  assert.match((result as { error: string }).error, /state/, 'error 文案应说明 state 不匹配');
});

test('extractAuthorizationCode：http 回环回调 + 正确 state → 也接受', () => {
  const result = extractAuthorizationCode(`http://127.0.0.1:1234/auth/callback?code=X&state=${STATE}`, STATE);
  assert.deepEqual(result, { code: 'X' }, '手粘整条 http 回调地址应同样能取出 code');
});

test('buildAuthorizeUrl：桌面回环参数齐全、state 为 64 位小写 hex、redirect 指向本机回调', () => {
  const url = new URL(buildAuthorizeUrl({ state: STATE, redirectUrl: 'http://127.0.0.1:53682/auth/callback' }));
  assert.equal(url.searchParams.get('login_source'), 'desktop', 'login_source 必须是 desktop，否则授权页不会走回环分支');
  assert.equal(url.searchParams.get('desktop_callback'), 'loopback', 'desktop_callback 必须是 loopback');
  assert.equal(url.searchParams.get('state'), STATE, 'state 应原样写进查询串');
  assert.match(STATE, /^[a-f0-9]{64}$/, 'state 必须是 64 位小写 hex（授权页硬校验）');
  assert.equal(
    url.searchParams.get('redirect'),
    'http://127.0.0.1:53682/auth/callback',
    'redirect 必须是 http://127.0.0.1:<port>/auth/callback',
  );
});

test('startWeb：注入假 client 与 openBrowser → running、phase、url、port 正确；cancel 后转 cancelled', async (t) => {
  const client = fakeClient();
  const { manager, opened } = harness(client);
  t.after(() => { manager.dispose(); });
  const login = await manager.startWeb();
  assert.equal(login.running, true, 'startWeb 之后应处于运行中');
  assert.equal(login.phase, 'waiting', `刚起本地服务时应是 waiting，实际是 ${login.phase}`);
  assert.equal(login.kind, 'web', '网页登录的 kind 应为 web');
  assert.match(login.url ?? '', /desktop_callback=loopback/, '下发的授权页 URL 必须带 desktop_callback=loopback');
  assert.ok((login.port ?? 0) > 0, `本地回调端口应大于 0，实际是 ${String(login.port)}`);
  assert.equal(opened.length, 1, 'openBrowser 应被调用一次');
  assert.equal(opened[0], login.url, 'openBrowser 应收到与 view 里一致的授权页 URL');

  await manager.cancel();
  const after = manager.view();
  assert.equal(after.running, false, 'cancel 之后不应再有进行中的会话');
  assert.equal(after.phase, 'cancelled', `cancel 之后相位应是 cancelled，实际是 ${after.phase}`);
});

test('端到端回环回调：浏览器带正确 state 回调 → 保存来源为 web 的账号并进入 done', async (t) => {
  let exchanged: string[] = [];
  const saved: StoredAccount[] = [];
  const client = fakeClient({
    exchangeAuthorizationCode: async (code) => {
      exchanged.push(code);
      return { accessToken: 'ACCESS', refreshToken: 'REFRESH' };
    },
  });
  const manager = createLoginManager({
    client,
    toAccount: async (input) => accountFor(input),
    save: async (account) => { saved.push(account); },
    validate: async () => true,
    openBrowser: () => true,
    warn: () => undefined,
  });
  t.after(() => { manager.dispose(); });

  const login = await manager.startWeb();
  const state = stateOf(login.url);
  const port = login.port ?? 0;
  assert.ok(port > 0, '本地回调端口应大于 0');

  const response = await fetch(`http://127.0.0.1:${String(port)}/auth/callback?code=fake-code&state=${state}`);
  assert.equal(response.status, 200, 'state 正确的回调应立刻回 200 的落地页');
  await response.text();

  const reached = await waitFor(() => manager.view().phase === 'done');
  assert.equal(reached, true, `3 秒内应走到 done，实际停在 ${manager.view().phase}（${manager.view().message}）`);
  assert.deepEqual(exchanged, ['fake-code'], '应用回调里的 code 去换令牌');
  assert.equal(saved.length, 1, 'save 应被调用一次');
  assert.equal(saved[0]?.source, 'web', `网页登录保存的账号 source 应为 web，实际是 ${String(saved[0]?.source)}`);
  assert.equal(saved[0]?.accessToken, 'ACCESS', '保存的应是换回来的 access token');
  const view = manager.view();
  assert.equal(view.running, false, 'done 之后不应再报告运行中');
  assert.equal(view.error, null, 'done 时不应带错误');
});

test('端到端回环回调：state 不匹配 → 响应 400 且相位为 error、code 为 state-mismatch', async (t) => {
  const { manager, saved } = harness(fakeClient());
  t.after(() => { manager.dispose(); });
  const login = await manager.startWeb();
  const state = stateOf(login.url);
  const port = login.port ?? 0;
  const wrong = `${state.slice(0, 63)}${state.endsWith('a') ? 'b' : 'a'}`;

  const response = await fetch(`http://127.0.0.1:${String(port)}/auth/callback?code=fake-code&state=${wrong}`);
  assert.equal(response.status, 400, 'state 不匹配的回调必须 400，不能继续换令牌');
  await response.text();

  const reached = await waitFor(() => manager.view().phase === 'error');
  assert.equal(reached, true, `3 秒内应进入 error，实际停在 ${manager.view().phase}`);
  const view = manager.view();
  assert.equal(view.running, false, 'error 之后不应再报告运行中');
  assert.equal(view.error?.code, 'state-mismatch', `error.code 应为 state-mismatch，实际是 ${String(view.error?.code)}`);
  assert.equal(saved.length, 0, 'state 不匹配时不得保存任何账号');
});

test('startQr：扫码成功 → 先给出内联 svg，随后相位走到 done', async (t) => {
  const client = fakeClient({
    startQr: async () => ({ code: 'qr-x', scanPath: '/login/mp', expiresInSec: 300, pollIntervalMs: 1_000 }),
    qrContent: () => 'https://xiaohuanxiong.com/login/mp?app=rr',
    pollQr: async () => ({ status: 'success', accessToken: 'tok' }),
  });
  const { manager, saved } = harness(client);
  t.after(() => { manager.dispose(); });

  const login = await manager.startQr();
  assert.equal(login.kind, 'qr', '扫码登录的 kind 应为 qr');
  assert.equal(login.running, true, '拿到二维码后应处于运行中');
  assert.match(login.qrSvg ?? '', /<svg/, `qrSvg 应是一段内联 <svg>，实际开头是 ${String(login.qrSvg).slice(0, 24)}`);

  const reached = await waitFor(() => manager.view().phase === 'done');
  assert.equal(reached, true, `3 秒内应走到 done，实际停在 ${manager.view().phase}（${manager.view().message}）`);
  assert.equal(saved.length, 1, '扫码成功后应保存一份账号');
  assert.equal(saved[0]?.source, 'qr', `扫码登录保存的账号 source 应为 qr，实际是 ${String(saved[0]?.source)}`);
  assert.equal(saved[0]?.accessToken, 'tok', '保存的应是轮询拿到的 access token');
  assert.equal(manager.view().qrSvg, null, 'done 之后应清掉二维码');
});

test('dispose：之后 startWeb 不再开端口 → running 为 false、port 为 null', async () => {
  const { manager, opened } = harness(fakeClient());
  manager.dispose();
  const login = await manager.startWeb();
  assert.equal(login.running, false, 'dispose 之后 startWeb 不应再启动会话');
  assert.equal(login.port, null, `dispose 之后不应占用端口，实际 port=${String(login.port)}`);
  assert.equal(login.url, null, 'dispose 之后不应生成授权页 URL');
  assert.equal(opened.length, 0, 'dispose 之后不应再调 openBrowser');
});

test('用户设定的轮询间隔真的生效：状态里的值更大时按它轮询，而不是上游建议的 1 秒', async () => {
  // 这条钉住「设置页的值有没有接线」。实现前它只是个被存下的死字段。
  let polls = 0;
  const client = fakeClient({
    pollQr: async () => { polls += 1; return { status: 'pending' as const }; },
  });
  // 上游建议 1 秒；用户设 5 秒 → 取大，5 秒内不应有第二次轮询。
  const { manager } = harness(client, { pollIntervalMs: () => 5_000 });
  await manager.startQr();
  await manager.cancel();

  const before = polls;
  await new Promise((resolve) => { setTimeout(resolve, 1_500); });
  assert.equal(polls, before, '用户把间隔设成 5 秒时，1.5 秒内不该再轮询（说明设置没生效）');
});

test('轮询间隔受下界保护：用户填 100 毫秒也不能把上游打成限流', async () => {
  let polls = 0;
  const client = fakeClient({
    pollQr: async () => { polls += 1; return { status: 'pending' as const }; },
  });
  const { manager } = harness(client, { pollIntervalMs: () => 100 });
  await manager.startQr();
  await manager.cancel();

  const before = polls;
  await new Promise((resolve) => { setTimeout(resolve, 700); });
  // QR_POLL_MIN_MS 是 1000：0.7 秒里不该出现第二次轮询。
  assert.equal(polls, before, '低于下界的设置必须被夹到 QR_POLL_MIN_MS，否则会限流');
});
