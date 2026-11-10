/**
 * shim 行为测试：换号到底发生在什么时刻、什么时候**不**换。
 *
 * 这一层最贵的一类 bug 是「流中途换号」——宿主会收到两条拼接的回复，比直接失败
 * 糟得多。所以断言的重点不是「换了几次」，而是「什么条件下没有换」。
 *
 * @module dsh-connect-raccoon/test/shim
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startShim, type ShimAttempt } from '../src/shim/server.ts';

/** 起一个 shim，返回句柄与调用断言用的工具。 */
async function withShim(options: {
  attempts: ShimAttempt[];
  chat: (input: { accessToken: string; body: unknown; signal: AbortSignal }) => Promise<Response>;
}) {
  const failovers: Array<{ fromId: string; toId: string; reason: string; code: string }> = [];
  const shim = await startShim({
    attempts: async () => options.attempts,
    chat: options.chat,
    onFailover: (detail) => failovers.push(detail),
  });
  const call = async (body: unknown = { model: 'x', messages: [], stream: true }) => {
    const response = await fetch(`${shim.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${shim.token}` },
      body: JSON.stringify(body),
    });
    return { status: response.status, text: await response.text() };
  };
  return { shim, call, failovers };
}

test('未带密钥：请求被 401 拒绝，且不调用上游', async () => {
  let calls = 0;
  const { shim } = await withShim({
    attempts: [{ accountId: 'a', accessToken: async () => 'tok' }],
    chat: async () => {
      calls += 1;
      return new Response('{}');
    },
  });
  const response = await fetch(`${shim.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(response.status, 401);
  assert.equal(calls, 0, '没有密钥时不该发出上游请求');
  await shim.close();
});

test('首个账号成功：只发一次上游请求，不记换号', async () => {
  const used: string[] = [];
  const { shim, call, failovers } = await withShim({
    attempts: [
      { accountId: 'a', accessToken: async () => 'tok-a' },
      { accountId: 'b', accessToken: async () => 'tok-b' },
    ],
    chat: async (input) => {
      used.push(input.accessToken);
      return new Response('data: {"ok":true}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  const result = await call();
  assert.equal(result.status, 200);
  assert.deepEqual(used, ['tok-a']);
  assert.equal(failovers.length, 0);
  await shim.close();
});

test('首个账号 401：换第二个账号，并记录 from/to 与分类码', async () => {
  const used: string[] = [];
  const { shim, call, failovers } = await withShim({
    attempts: [
      { accountId: 'a', accessToken: async () => 'tok-a' },
      { accountId: 'b', accessToken: async () => 'tok-b' },
    ],
    chat: async (input) => {
      used.push(input.accessToken);
      if (input.accessToken === 'tok-a') {
        return new Response(JSON.stringify({ code: 200003, message: 'authorization_verify_error' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('data: ok\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const result = await call();
  assert.equal(result.status, 200);
  assert.deepEqual(used, ['tok-a', 'tok-b']);
  assert.equal(failovers.length, 1);
  assert.equal(failovers[0]?.fromId, 'a');
  assert.equal(failovers[0]?.toId, 'b');
  assert.equal(failovers[0]?.code, 'authorization-verify', '分类码决定宿主给这个账号记多久冷却');
  await shim.close();
});

test('首个账号 400：**不换号**，把上游原文直接回给宿主', async () => {
  let calls = 0;
  const { shim, call, failovers } = await withShim({
    attempts: [
      { accountId: 'a', accessToken: async () => 'tok-a' },
      { accountId: 'b', accessToken: async () => 'tok-b' },
    ],
    chat: async () => {
      calls += 1;
      return new Response(JSON.stringify({ message: '该模型不存在' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const result = await call();
  assert.equal(calls, 1, '同一个请求体换谁都是 400，不该重试');
  assert.equal(result.status, 400);
  assert.match(result.text, /该模型不存在/, '上游原文要透出去，不能被包装成统一文案');
  assert.equal(failovers.length, 0);
  await shim.close();
});

test('全部账号都 429：返回 429 与最后一次的文案，每次失败都记换号', async () => {
  const { shim, call, failovers } = await withShim({
    attempts: [
      { accountId: 'a', accessToken: async () => 'tok-a' },
      { accountId: 'b', accessToken: async () => 'tok-b' },
    ],
    chat: async () =>
      new Response(JSON.stringify({ message: 'user_model_rate_limited' }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      }),
  });
  const result = await call();
  assert.equal(result.status, 429);
  assert.match(result.text, /user_model_rate_limited/);
  assert.equal(failovers.length, 1, '两个账号各失败一次，只有发生 from→to 时才记一条');
  assert.equal(failovers[0]?.code, 'rate-limited');
  await shim.close();
});

test('取不到令牌：跳到下一个账号，且不因这个账号的失败直接终结', async () => {
  const used: string[] = [];
  const { shim, call } = await withShim({
    attempts: [
      { accountId: 'a', accessToken: async () => { throw new Error('没有续期凭据'); } },
      { accountId: 'b', accessToken: async () => 'tok-b' },
    ],
    chat: async (input) => {
      used.push(input.accessToken);
      return new Response('data: ok\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const result = await call();
  assert.equal(result.status, 200);
  assert.deepEqual(used, ['tok-b'], '取不到令牌的账号不该被发请求');
  await shim.close();
});

test('没有任何可用账号：503 且文案指向登录', async () => {
  const { shim, call } = await withShim({ attempts: [], chat: async () => new Response('{}') });
  const result = await call();
  assert.equal(result.status, 503);
  assert.match(result.text, /登录/, '空白错误会让人去查网络，实际只要登录一次');
  await shim.close();
});

test('路径不对 → 404；方法不对 → 405', async () => {
  const { shim } = await withShim({
    attempts: [{ accountId: 'a', accessToken: async () => 'tok' }],
    chat: async () => new Response('{}'),
  });
  const wrongPath = await fetch(`${shim.baseUrl}/v1/other`, { method: 'POST' });
  assert.equal(wrongPath.status, 404);
  const wrongMethod = await fetch(`${shim.baseUrl}/v1/chat/completions`, { method: 'GET' });
  assert.equal(wrongMethod.status, 405);
  await shim.close();
});

test('请求体不是 JSON 对象 → 400，不打上游', async () => {
  let calls = 0;
  const { shim } = await withShim({
    attempts: [{ accountId: 'a', accessToken: async () => 'tok' }],
    chat: async () => {
      calls += 1;
      return new Response('{}');
    },
  });
  const response = await fetch(`${shim.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${shim.token}` },
    body: '[1,2,3]',
  });
  assert.equal(response.status, 400);
  assert.equal(calls, 0);
  await shim.close();
});

test('卸载：端口真的关掉（再连一次失败）', async () => {
  const { shim } = await withShim({
    attempts: [{ accountId: 'a', accessToken: async () => 'tok' }],
    chat: async () => new Response('{}'),
  });
  const url = `${shim.baseUrl}/v1/chat/completions`;
  await shim.close();
  const status = await fetch(url, { method: 'POST', body: '{}' }).then(
    (response) => response.status,
    () => 'closed',
  );
  assert.equal(status, 'closed', '卸载后不能再接受请求');
});
