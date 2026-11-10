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

test('工具调用：tools / tool_choice 原样透传给上游，shim 不改写请求体', async (t) => {
  // DSH 的 agent 能力全靠工具调用。shim 只要动一下请求体，工具就从「能用」变成「永远不调用」，
  // 而且这种失败是静默的 —— 模型会正常回话，只是永远不调工具。
  const received: Array<Record<string, unknown>> = [];
  const shim = await startShim({
    attempts: async () => [{ accountId: 'acc_a', accessToken: async () => 'token-a' }],
    chat: async (input) => {
      received.push(input.body as Record<string, unknown>);
      return new Response(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\\"p\\":\\"a"}}]}}]}\n\n'
        + 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":".txt\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n'
        + 'data: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    },
    onWarn: () => undefined,
  });
  t.after(async () => { await shim.close(); });

  const tools = [{
    type: 'function',
    function: {
      name: 'read_file',
      description: '读文件',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  }];
  const response = await fetch(`${shim.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${shim.token}` },
    body: JSON.stringify({
      model: 'sensenova-6.8-flash-lite',
      messages: [{ role: 'user', content: '读 a.txt' }],
      tools,
      tool_choice: 'auto',
      stream: true,
    }),
  });
  const text = await response.text();

  assert.equal(response.status, 200);
  assert.deepEqual(received[0]?.['tools'], tools, 'tools 必须原样到达上游（改写会让模型永远不调工具）');
  assert.equal(received[0]?.['tool_choice'], 'auto', 'tool_choice 必须原样透传');
  assert.ok(text.includes('tool_calls'), 'tool_calls 分片必须原样转发给宿主');
  assert.ok(text.includes('read_file'), '工具名不能在转发时丢');
  assert.ok(text.includes('[DONE]'), 'SSE 结束标记必须保留');
});

test('非流式请求：上游回 application/json 时按普通响应透传，不当成半截事件流', async (t) => {
  // stream:false 时上游回一整个 JSON。若转发逻辑假定「一定是 SSE」，
  // 宿主会收到内容对不上 content-type 的响应，解析报错。
  const payload = { id: 'x', choices: [{ message: { role: 'assistant', content: '你好' }, finish_reason: 'stop' }] };
  const shim = await startShim({
    attempts: async () => [{ accountId: 'acc_a', accessToken: async () => 'token-a' }],
    chat: async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    onWarn: () => undefined,
  });
  t.after(async () => { await shim.close(); });

  const response = await fetch(`${shim.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${shim.token}` },
    body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false }),
  });
  const text = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /application\/json/, 'content-type 必须跟随上游');
  assert.deepEqual(JSON.parse(text), payload, '非流式响应体必须逐字保留');
});

test('流内错误帧：200 响应里的限流帧被认出来，并上报「这个账号这次失败了」', async (t) => {
  // 上游把限流藏在 200 流里（HTTP 是成功的、连接正常关闭）。不认这一帧的话：
  // 不记冷却、不告警，用户只看到回复被截断，下一个请求还会挑同一个账号白烧一遍。
  const failures: Array<{ fromId: string; toId: string; code: string; reason: string }> = [];
  const shim = await startShim({
    attempts: async () => [{ accountId: 'acc_a', accessToken: async () => 'token-a' }],
    chat: async () => new Response(
      'data: {"choices":[{"delta":{"content":"半句"}}]}\n\n'
      + 'data: {"error":{"code":"user_model_rate_limited","message":"频率超限"}}\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ),
    onFailover: (detail) => { failures.push(detail); },
    onWarn: () => undefined,
  });
  t.after(async () => { await shim.close(); });

  const response = await fetch(`${shim.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${shim.token}` },
    body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true }),
  });
  const text = await response.text();

  // 1. 字节必须原样转发（认帧不等于改写流）。
  assert.ok(text.includes('半句'), '正常内容不能被丢掉');
  assert.ok(text.includes('user_model_rate_limited'), '错误帧也要原样给宿主，它可能自己会处理');

  // 2. 必须上报，且分类成 rate-limited（决定冷却时长）。
  assert.equal(failures.length, 1, `应恰好上报一次，实际上报 ${String(failures.length)} 次`);
  assert.equal(failures[0]?.code, 'rate-limited', '限流帧必须归成 rate-limited，否则冷却算错');
  assert.equal(failures[0]?.fromId, 'acc_a');
  assert.equal(failures[0]?.toId, 'acc_a', '流已开始、换不了号，from 与 to 应相等');
});

test('流内错误帧：正常结束的流不误报', async (t) => {
  const failures: unknown[] = [];
  const shim = await startShim({
    attempts: async () => [{ accountId: 'acc_a', accessToken: async () => 'token-a' }],
    chat: async () => new Response(
      'data: {"choices":[{"delta":{"content":"完整回复"}}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ),
    onFailover: (detail) => { failures.push(detail); },
    onWarn: () => undefined,
  });
  t.after(async () => { await shim.close(); });

  const response = await fetch(`${shim.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${shim.token}` },
    body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true }),
  });
  await response.text();

  assert.deepEqual(failures, [], '正常流一次都不该上报换号/失败，否则好账号会被无谓冷却');
});

test('流内错误帧：非流式 JSON 响应不逐帧扫描（不白花 JSON.parse 的钱）', async (t) => {
  const failures: unknown[] = [];
  const shim = await startShim({
    attempts: async () => [{ accountId: 'acc_a', accessToken: async () => 'token-a' }],
    chat: async () => new Response(
      JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
    onFailover: (detail) => { failures.push(detail); },
    onWarn: () => undefined,
  });
  t.after(async () => { await shim.close(); });

  const response = await fetch(`${shim.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${shim.token}` },
    body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false }),
  });
  await response.text();

  assert.deepEqual(failures, []);
});

test('用户按停止：请求体读完后客户端断开，上游请求必须被 abort（否则白烧额度）', async (t) => {
  // 只挂 req.on('aborted') 不够：那个事件只在请求体没读完时触发。
  // 对话请求的 body 通常一次发完，之后用户按停止 → aborted 永远不来 →
  // 上游继续跑到结束、继续扣这个账号的额度。已在 Node 24 实测复现。
  let aborted = false;
  let chatResolve;
  const chatSettled = new Promise((resolve) => { chatResolve = resolve; });

  const shim = await startShim({
    attempts: async () => [{ accountId: 'acc_a', accessToken: async () => 'token-a' }],
    chat: async (input) => {
      // 一个「永远不主动结束」的上游：只有 signal 被 abort 才会退出。
      input.signal.addEventListener('abort', () => {
        aborted = true;
        chatResolve?.('aborted');
      });
      await new Promise((resolve) => {
        input.signal.addEventListener('abort', resolve);
        setTimeout(resolve, 3_000); // 兜底：万一没 abort，测试不要挂 3 秒以上
      });
      chatResolve?.('timeout');
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
    onWarn: () => undefined,
  });
  t.after(async () => { await shim.close(); });

  const controller = new AbortController();
  const pending = fetch(`${shim.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${shim.token}` },
    body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    signal: controller.signal,
  }).catch(() => undefined);

  // 等上游请求真的发出去（说明请求体已读完），再断开。
  await new Promise((resolve) => { setTimeout(resolve, 200); });
  controller.abort();
  await pending;
  await Promise.race([chatSettled, new Promise((resolve) => { setTimeout(resolve, 1_500); })]);

  assert.equal(aborted, true, '客户端断开后必须 abort 上游请求；否则上游跑完、额度照扣');
});

test('并发 8 个请求：各自独立选号、互不串号（池是共享状态，最容易在这里出错）', async (t) => {
  // 每个请求都调 `attempts()` 自己算一次候选序列 —— 如果实现里把「本次选中的账号」
  // 存在模块级变量上，并发时后一个请求会覆盖前一个，A 的令牌被用在 B 的回复上。
  const usedTokens: string[] = [];
  const shim = await startShim({
    attempts: async () => [
      { accountId: 'acc_a', accessToken: async () => 'token-a' },
      { accountId: 'acc_b', accessToken: async () => 'token-b' },
    ],
    chat: async (input) => {
      usedTokens.push(input.accessToken);
      // 故意让每个请求的完成顺序打乱：快的先回、慢的后回。
      await new Promise((resolve) => { setTimeout(resolve, Math.floor(Math.random() * 40)); });
      return new Response(`data: {"choices":[{"delta":{"content":"${input.accessToken}"}}]}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    },
    onWarn: () => undefined,
  });
  t.after(async () => { await shim.close(); });

  const replies = await Promise.all(Array.from({ length: 8 }, async () => {
    const response = await fetch(`${shim.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${shim.token}` },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });
    return await response.text();
  }));

  assert.equal(replies.length, 8);
  assert.equal(usedTokens.length, 8, '每个请求都该发一次上游请求');
  // 每个回复里的内容必须等于它自己那次用的令牌：串号会让回复内容是别人的。
  for (const reply of replies) {
    const which = reply.includes('token-a') ? 'token-a' : reply.includes('token-b') ? 'token-b' : 'none';
    assert.notEqual(which, 'none', `回复里没有预期的令牌标记：${reply.slice(0, 120)}`);
  }
  // 首号永远可用，所以每个请求都该只用 acc_a（不触发换号）。
  assert.ok(usedTokens.every((token) => token === 'token-a'), `应全部用首选账号，实际：${usedTokens.join(',')}`);
});
