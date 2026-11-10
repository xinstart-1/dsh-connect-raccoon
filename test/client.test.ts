import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import { createRaccoonClient } from '../src/protocol/client.ts';
import type { QrSession, RaccoonClient } from '../src/protocol/client.ts';
import { RaccoonError } from '../src/protocol/errors.ts';
import { CLIENT_LANGUAGE, CLIENT_VERSION, SITE_ORIGIN } from '../src/constants.ts';

/** 服务端收到的一次请求（已经读完 body）。 */
interface Recorded {
  method: string;
  path: string;
  headers: Headers;
  body: string;
}

/** 服务端要回的一次响应。 */
interface Reply {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}

/** 一个跑在 127.0.0.1:0 上的桩服务，记录请求并把上游绝对地址改写到本地。 */
interface Stub {
  fetchImpl: typeof fetch;
  requests: Recorded[];
  close: () => Promise<void>;
}

/** 起桩服务；`handler` 按请求返回响应体。 */
async function startStub(handler: (request: Recorded) => Reply): Promise<Stub> {
  const requests: Recorded[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const recorded: Recorded = {
        method: req.method ?? '',
        path: req.url ?? '',
        headers: new Headers(
          Object.entries(req.headers).flatMap(([name, value]) =>
            value === undefined ? [] : [[name, Array.isArray(value) ? value.join(', ') : value] as [string, string]],
          ),
        ),
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(recorded);
      const reply = handler(recorded);
      res.writeHead(reply.status ?? 200, {
        'content-type': 'application/json',
        ...(reply.headers ?? {}),
      });
      res.end(reply.body ?? '');
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object', '桩服务应已绑定到 127.0.0.1 端口');
  const origin = `http://127.0.0.1:${String(address.port)}`;

  const fetchImpl: typeof fetch = (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    assert.ok(
      raw.startsWith(SITE_ORIGIN),
      `被测客户端只应请求 ${SITE_ORIGIN}，实际 ${raw}（测试不允许访问公网）`,
    );
    const url = new URL(raw);
    return fetch(`${origin}${url.pathname}${url.search}`, init);
  };

  const close = async (): Promise<void> => {
    // 先断开 keep-alive 连接，否则未消费 body 的用例会卡在 close 上。
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return { fetchImpl, requests, close };
}

/** 造一个客户端，只做一件事：把请求打到桩服务。 */
function makeClient(fetchImpl: typeof fetch): RaccoonClient {
  return createRaccoonClient({ fetchImpl, timeoutMs: 5_000 });
}

/** 断言异步调用抛 RaccoonError。 */
async function expectRaccoonError(run: () => Promise<unknown>): Promise<RaccoonError> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof RaccoonError, `期望抛出 RaccoonError，实际抛出 ${String(error)}`);
    return error;
  }
  assert.fail('期望抛出 RaccoonError，但调用成功返回了');
}

/** 断言请求的身份头齐全；`token` 省略时不带 authorization。 */
function expectIdentityHeaders(request: Recorded, token?: string): void {
  assert.equal(
    request.headers.get('x-client-version'),
    CLIENT_VERSION,
    `x-client-version 头应为 ${CLIENT_VERSION}，实际 ${String(request.headers.get('x-client-version'))}`,
  );
  assert.equal(
    request.headers.get('x-raccoon-language'),
    CLIENT_LANGUAGE,
    `x-raccoon-language 头应为 ${CLIENT_LANGUAGE}，实际 ${String(request.headers.get('x-raccoon-language'))}`,
  );
  if (token === undefined) {
    assert.equal(
      request.headers.get('authorization'),
      null,
      '不带令牌的请求不应发送 authorization 头',
    );
  } else {
    assert.equal(
      request.headers.get('authorization'),
      `Bearer ${token}`,
      `authorization 头应为 Bearer ${token}，实际 ${String(request.headers.get('authorization'))}`,
    );
  }
}

const CATALOG_BODY = JSON.stringify({
  code: 0,
  data: {
    categories: [
      { models: [{ name: 'glm-5-3', model_name: 'glm-5-3', params: { context_window: 200000, max_tokens: 8192 } }] },
    ],
  },
});

const QR_SESSION_BODY = JSON.stringify({
  code: 'OK',
  data: { qrcode_code: 'qr-x', scan_path: '/login/mp', expires_in: 300, poll_interval: 2 },
});

test('fetchCatalog：GET /api/web/llm/v2/model_catalog 且带身份头 → 解析出目录', async () => {
  const stub = await startStub(() => ({ body: CATALOG_BODY }));
  try {
    const catalog = await makeClient(stub.fetchImpl).fetchCatalog('tok-1');
    assert.equal(stub.requests.length, 1, `应只发 1 个请求，实际 ${stub.requests.length} 个`);
    const request = stub.requests[0]!;
    assert.equal(request.method, 'GET', `方法应为 GET，实际 ${request.method}`);
    assert.equal(
      request.path,
      '/api/web/llm/v2/model_catalog',
      `路径应为 /api/web/llm/v2/model_catalog，实际 ${request.path}`,
    );
    expectIdentityHeaders(request, 'tok-1');
    assert.equal(catalog.models.length, 1, `应解析出 1 条模型，实际 ${catalog.models.length} 条`);
    assert.equal(catalog.models[0]!.id, 'glm-5-3', `模型 id 应为 glm-5-3，实际 ${catalog.models[0]!.id}`);
    assert.equal(catalog.source, 'live', `目录来源应为 live，实际 ${catalog.source}`);
  } finally {
    await stub.close();
  }
});

test('fetchCatalog：上游回 401 带业务码 200003 → 抛 authorization-verify 且标记可换号', async () => {
  const stub = await startStub(() => ({
    status: 401,
    body: JSON.stringify({ code: 200003, message: 'authorization_verify_error' }),
  }));
  try {
    const error = await expectRaccoonError(() => makeClient(stub.fetchImpl).fetchCatalog('tok-bad'));
    assert.equal(error.code, 'authorization-verify', `401 + 200003 应分类为 authorization-verify，实际 ${error.code}`);
    assert.equal(
      error.retriableWithOtherAccount,
      true,
      '登录态失效应允许换一个账号重试（retriableWithOtherAccount=true）',
    );
    assert.equal(error.status, 401, `错误应保留上游 HTTP 401，实际 ${String(error.status)}`);
  } finally {
    await stub.close();
  }
});

test('fetchBalance：GET /api/web/points/v1/balance → total 取余额、过期额度与最近到期时间有值', async () => {
  const futureSec = Math.floor(Date.now() / 1000) + 5 * 24 * 3600;
  const stub = await startStub(() => ({
    body: JSON.stringify({ data: { balance: 1234, packages: [{ amount: 500, expires_at: futureSec }] } }),
  }));
  try {
    const balance = await makeClient(stub.fetchImpl).fetchBalance('tok-2');
    const request = stub.requests[0]!;
    assert.equal(request.method, 'GET', `方法应为 GET，实际 ${request.method}`);
    assert.equal(
      request.path,
      '/api/web/points/v1/balance',
      `路径应为 /api/web/points/v1/balance，实际 ${request.path}`,
    );
    expectIdentityHeaders(request, 'tok-2');
    assert.equal(balance.total, 1234, `total 应为 1234，实际 ${String(balance.total)}`);
    assert.ok(balance.expiringSoon >= 0, `expiringSoon 不应为负数，实际 ${String(balance.expiringSoon)}`);
    assert.ok(
      typeof balance.nearestExpiryMs === 'number' && Number.isFinite(balance.nearestExpiryMs),
      `有带到期时间的套餐时 nearestExpiryMs 应有值，实际 ${String(balance.nearestExpiryMs)}`,
    );
  } finally {
    await stub.close();
  }
});

test('chatStream：POST /api/web/llm/v2/chat/completions 回 200 text/event-stream → 直接返回 Response.ok=true', async () => {
  const stub = await startStub(() => ({
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
  }));
  try {
    const response = await makeClient(stub.fetchImpl).chatStream({
      accessToken: 'tok-3',
      body: { model: 'glm-5-3', messages: [{ role: 'user', content: '你好' }], stream: true },
    });
    const request = stub.requests[0]!;
    assert.equal(request.method, 'POST', `方法应为 POST，实际 ${request.method}`);
    assert.equal(
      request.path,
      '/api/web/llm/v2/chat/completions',
      `路径应为 /api/web/llm/v2/chat/completions，实际 ${request.path}`,
    );
    expectIdentityHeaders(request, 'tok-3');
    assert.equal(
      request.headers.get('content-type'),
      'application/json',
      `带 body 的请求应声明 content-type: application/json，实际 ${String(request.headers.get('content-type'))}`,
    );
    assert.deepEqual(
      JSON.parse(request.body) as unknown,
      { model: 'glm-5-3', messages: [{ role: 'user', content: '你好' }], stream: true },
      '请求体应原样序列化传入的 body',
    );
    assert.equal(response.ok, true, `200 响应应原样交给调用方（ok=true），实际 ok=${String(response.ok)}`);
  } finally {
    await stub.close();
  }
});

test('chatStream：上游回 400 带业务码 200003 → 抛 RaccoonError', async () => {
  const stub = await startStub(() => ({
    status: 400,
    body: JSON.stringify({ code: 200003, message: 'authorization_verify_error' }),
  }));
  try {
    const error = await expectRaccoonError(() =>
      makeClient(stub.fetchImpl).chatStream({ accessToken: 'tok-4', body: { model: 'glm-5-3' } }),
    );
    assert.equal(error.code, 'authorization-verify', `400 + 200003 应分类为 authorization-verify，实际 ${error.code}`);
  } finally {
    await stub.close();
  }
});

test('startQr：POST /api/iam/v1/auth/mp/qrcode → 取到 qrcode_code 且轮询间隔换算成毫秒', async () => {
  const stub = await startStub(() => ({ body: QR_SESSION_BODY }));
  try {
    const session = await makeClient(stub.fetchImpl).startQr();
    const request = stub.requests[0]!;
    assert.equal(request.method, 'POST', `方法应为 POST，实际 ${request.method}`);
    assert.equal(
      request.path,
      '/api/iam/v1/auth/mp/qrcode',
      `路径应为 /api/iam/v1/auth/mp/qrcode，实际 ${request.path}`,
    );
    expectIdentityHeaders(request);
    assert.equal(session.code, 'qr-x', `二维码 code 应为 qr-x，实际 ${session.code}`);
    assert.equal(session.pollIntervalMs, 2000, `poll_interval=2 秒应换算成 2000 毫秒，实际 ${String(session.pollIntervalMs)}`);
    assert.equal(session.expiresInSec, 300, `expires_in 应为 300，实际 ${String(session.expiresInSec)}`);
  } finally {
    await stub.close();
  }
});

test('startQr：scan_path 非本站相对路径（绝对 URL / 协议相对 / 含空格） → 三次都抛 invalid-response', async () => {
  const badPaths = ['https://evil.com/x', '//evil.com/x', '/a b'];
  for (const scanPath of badPaths) {
    const stub = await startStub(() => ({
      body: JSON.stringify({
        code: 'OK',
        data: { qrcode_code: 'qr-x', scan_path: scanPath, expires_in: 300, poll_interval: 2 },
      }),
    }));
    try {
      const error = await expectRaccoonError(() => makeClient(stub.fetchImpl).startQr());
      assert.equal(
        error.code,
        'invalid-response',
        `scan_path=${JSON.stringify(scanPath)} 应判为 invalid-response，实际 ${error.code}`,
      );
    } finally {
      await stub.close();
    }
  }
});

test('qrContent：会话里有码 → 输出本站扫码地址且带 code/appname/source=platform', () => {
  const client = makeClient((() => assert.fail('qrContent 不应发网络请求')) as unknown as typeof fetch);
  const session: QrSession = { code: 'qr-x', scanPath: '/login/mp', expiresInSec: 300, pollIntervalMs: 2000 };
  const content = client.qrContent(session);
  assert.ok(
    content.startsWith('https://xiaohuanxiong.com/login/mp?'),
    `二维码内容应以 https://xiaohuanxiong.com/login/mp? 开头，实际 ${content}`,
  );
  const url = new URL(content);
  assert.equal(url.searchParams.get('code'), 'qr-x', `query 应带 code=qr-x，实际 ${String(url.searchParams.get('code'))}`);
  assert.equal(
    url.searchParams.get('appname'),
    '商汤小浣熊',
    `query 应带 appname=商汤小浣熊，实际 ${String(url.searchParams.get('appname'))}`,
  );
  assert.equal(
    url.searchParams.get('source'),
    'platform',
    `query 应带 source=platform，实际 ${String(url.searchParams.get('source'))}`,
  );
});

test('pollQr：服务端回 500 → 返回 pending（一次抖动不算失败）', async () => {
  const stub = await startStub(() => ({ status: 500, body: JSON.stringify({ message: 'internal error' }) }));
  try {
    const poll = await makeClient(stub.fetchImpl).pollQr('qr-x');
    const request = stub.requests[0]!;
    assert.equal(request.method, 'POST', `方法应为 POST，实际 ${request.method}`);
    assert.equal(
      request.path,
      '/api/iam/v1/auth/mp/qrcode/login',
      `路径应为 /api/iam/v1/auth/mp/qrcode/login，实际 ${request.path}`,
    );
    assert.deepEqual(request.body, JSON.stringify({ qrcode_code: 'qr-x' }), '请求体应为 {"qrcode_code":"qr-x"}');
    assert.equal(poll.status, 'pending', `服务端 500 时应保持 pending 继续轮询，实际 ${poll.status}`);
  } finally {
    await stub.close();
  }
});

test('pollQr：服务端回 AUTH_QRCODE_EXPIRED → status=expired', async () => {
  const stub = await startStub(() => ({
    status: 401,
    body: JSON.stringify({ code: 'AUTH_QRCODE_EXPIRED', message: 'mini-program QR code expired' }),
  }));
  try {
    const poll = await makeClient(stub.fetchImpl).pollQr('qr-x');
    assert.equal(poll.status, 'expired', `二维码过期应终止轮询为 expired，实际 ${poll.status}`);
  } finally {
    await stub.close();
  }
});

test('pollQr：服务端回 status=success 且 access_token 带 Bearer 前缀 → success 且令牌被 strip', async () => {
  const stub = await startStub(() => ({
    body: JSON.stringify({
      code: 'OK',
      data: { status: 'success', access_token: 'Bearer tok', token_type: 'bearer' },
    }),
  }));
  try {
    const poll = await makeClient(stub.fetchImpl).pollQr('qr-x');
    assert.equal(poll.status, 'success', `扫码成功应返回 success，实际 ${poll.status}`);
    assert.equal(poll.accessToken, 'tok', `access_token 应去掉 Bearer 前缀为 tok，实际 ${String(poll.accessToken)}`);
  } finally {
    await stub.close();
  }
});

test('exchangeAuthorizationCode：POST /api/web/auth/v1/login_with_authorization_code 带授权码 → 三个字段都 strip 后读出', async () => {
  const stub = await startStub(() => ({
    body: JSON.stringify({
      code: 0,
      data: { access_token: 'Bearer a', refresh_token: 'Bearer r', office_identity: 'personal' },
    }),
  }));
  try {
    const pair = await makeClient(stub.fetchImpl).exchangeAuthorizationCode('the-code');
    const request = stub.requests[0]!;
    assert.equal(request.method, 'POST', `方法应为 POST，实际 ${request.method}`);
    assert.equal(
      request.path,
      '/api/web/auth/v1/login_with_authorization_code',
      `路径应为 /api/web/auth/v1/login_with_authorization_code，实际 ${request.path}`,
    );
    expectIdentityHeaders(request);
    assert.deepEqual(
      JSON.parse(request.body) as unknown,
      { authorization_code: 'the-code' },
      '请求体应为 {"authorization_code":"the-code"}',
    );
    assert.equal(pair.accessToken, 'a', `accessToken 应 strip 成 a，实际 ${String(pair.accessToken)}`);
    assert.equal(pair.refreshToken, 'r', `refreshToken 应 strip 成 r，实际 ${String(pair.refreshToken)}`);
    assert.equal(pair.identity, 'personal', `identity 应为 personal，实际 ${String(pair.identity)}`);
  } finally {
    await stub.close();
  }
});

test('fetchUserInfo：GET /api/web/auth/v1/user_info → 读出 nickname', async () => {
  const stub = await startStub(() => ({ body: JSON.stringify({ code: 0, data: { name: '小浣熊用户' } }) }));
  try {
    const info = await makeClient(stub.fetchImpl).fetchUserInfo('tok-5');
    const request = stub.requests[0]!;
    assert.equal(request.method, 'GET', `方法应为 GET，实际 ${request.method}`);
    assert.equal(
      request.path,
      '/api/web/auth/v1/user_info',
      `路径应为 /api/web/auth/v1/user_info，实际 ${request.path}`,
    );
    expectIdentityHeaders(request, 'tok-5');
    assert.equal(info.nickname, '小浣熊用户', `nickname 应为 小浣熊用户，实际 ${String(info.nickname)}`);
  } finally {
    await stub.close();
  }
});
