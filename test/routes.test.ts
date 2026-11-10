import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';

import { ACTION_PATH, STATUS_PATH } from '../src/constants.ts';
import {
  isLoopbackHost,
  registerRoutes,
  type RaccoonAction,
  type RouteDeps,
  type RoutesHost,
  type WebServerEntry,
} from '../src/host/routes.ts';

type Handler = WebServerEntry['handler'];

/** 假宿主上下文：只实现 routes.ts 用到的 inject / effect / register。 */
function fakeHost(): {
  host: RoutesHost;
  handlers: Map<string, Handler>;
  cleanups: Array<() => void>;
} {
  const handlers = new Map<string, Handler>();
  const cleanups: Array<() => void> = [];
  const host: RoutesHost = {
    inject: (_services, cb) => {
      cb({
        effect: (fn) => { cleanups.push(fn()); },
        webServer: {
          register: (entry) => {
            handlers.set(entry.path, entry.handler);
            return () => { handlers.delete(entry.path); };
          },
        },
      });
    },
  };
  return { host, handlers, cleanups };
}

/** 把一个 handler 挂到真实的回环 HTTP 服务器上；每个 test 自建自关。 */
async function serve(
  handlers: Map<string, Handler>,
  t: { after: (fn: () => Promise<void>) => void },
): Promise<number> {
  const server = createServer((req, res) => {
    const handler = handlers.get(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
    if (handler === undefined) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    void handler(req, res);
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => { resolve(); });
      }),
  );
  return (server.address() as AddressInfo).port;
}

/** 发一次请求；Host 头可覆盖（`node:http` 允许，`fetch` 不允许）。 */
function call(
  port: number,
  options: { method?: string; path: string; host?: string; origin?: string; body?: string },
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (options.host !== undefined) headers['Host'] = options.host;
    if (options.origin !== undefined) headers['Origin'] = options.origin;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(options.body));
    }
    const req = httpRequest(
      { host: '127.0.0.1', port, method: options.method ?? 'GET', path: options.path, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => { chunks.push(chunk); });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

test('isLoopbackHost：回环 Host → 为 true；非回环与空值 → 为 false', () => {
  for (const host of ['127.0.0.1:8080', 'localhost:1', '[::1]:1', '::1', '127.5.5.5']) {
    assert.equal(isLoopbackHost(host), true, `${host} 是本机地址，应判为 true`);
  }
  for (const host of ['192.168.1.1', 'evil.com', undefined, '']) {
    assert.equal(isLoopbackHost(host), false, `${String(host)} 不是本机地址，应判为 false`);
  }
});

test('registerRoutes：用假 ctx 注册 → 拿到 status 与 action 两条 handler', () => {
  const { host, handlers, cleanups } = fakeHost();
  const deps: RouteDeps = {
    status: async () => ({ ok: true }),
    action: async () => ({ ok: true }),
  };
  registerRoutes(host, deps);
  assert.equal(handlers.size, 2, `应注册恰好两条路由，实际 ${String(handlers.size)} 条`);
  assert.deepEqual(
    [...handlers.keys()].sort(),
    [ACTION_PATH, STATUS_PATH].sort(),
    '两条路由的路径应是 STATUS_PATH 与 ACTION_PATH',
  );
  assert.equal(cleanups.length, 2, '每条路由都应挂一个收尾函数（ctx.effect）');
  assert.equal(typeof cleanups[0], 'function', 'effect 回调应返回清理函数');
});

test('GET /status：非回环 Host → 403 且 error.code 为 loopback-only', async (t) => {
  const { host, handlers } = fakeHost();
  let called = 0;
  registerRoutes(host, {
    status: async () => { called += 1; return { hello: 'world' }; },
    action: async () => ({ ok: true }),
  });
  const port = await serve(handlers, t);
  const res = await call(port, { path: STATUS_PATH, host: '192.168.1.1:8080' });
  assert.equal(res.status, 403, '非回环 Host 必须 403，否则同网段机器能读状态');
  const body = JSON.parse(res.text) as { error?: { code?: string } };
  assert.equal(body.error?.code, 'loopback-only', `error.code 应为 loopback-only，实际是 ${String(body.error?.code)}`);
  assert.equal(called, 0, '被拒绝的请求不应触达 deps.status');
});

test('GET /status：回环 Host → 200 且 body 原样等于 deps.status()', async (t) => {
  const { host, handlers } = fakeHost();
  const expected = { hello: 'world' };
  registerRoutes(host, {
    status: async () => expected,
    action: async () => ({ ok: true }),
  });
  const port = await serve(handlers, t);
  const res = await call(port, { path: STATUS_PATH });
  assert.equal(res.status, 200, '回环请求应 200');
  assert.deepEqual(JSON.parse(res.text), expected, 'body 应就是 deps.status() 的返回，不做再包装');
});

test('POST /action：未知动作 → 400 且 error.code 为 bad-request', async (t) => {
  const { host, handlers } = fakeHost();
  let called = 0;
  registerRoutes(host, {
    status: async () => ({ ok: true }),
    action: async () => { called += 1; return { ok: true }; },
  });
  const port = await serve(handlers, t);
  const res = await call(port, {
    method: 'POST',
    path: ACTION_PATH,
    body: JSON.stringify({ action: 'rm -rf' }),
  });
  assert.equal(res.status, 400, '白名单外的动作应 400');
  const body = JSON.parse(res.text) as { ok?: boolean; error?: { code?: string } };
  assert.equal(body.ok, false, 'ok 应为 false');
  assert.equal(body.error?.code, 'bad-request', `error.code 应为 bad-request，实际是 ${String(body.error?.code)}`);
  assert.equal(called, 0, '白名单外的动作不得进入 deps.action');
});

test('POST /action：坏 JSON → 400 且 error.code 为 bad-request', async (t) => {
  const { host, handlers } = fakeHost();
  registerRoutes(host, {
    status: async () => ({ ok: true }),
    action: async () => ({ ok: true }),
  });
  const port = await serve(handlers, t);
  const res = await call(port, { method: 'POST', path: ACTION_PATH, body: '{"action":' });
  assert.equal(res.status, 400, '解析不了的请求体应 400');
  const body = JSON.parse(res.text) as { error?: { code?: string } };
  assert.equal(body.error?.code, 'bad-request', `error.code 应为 bad-request，实际是 ${String(body.error?.code)}`);
});

test('POST /action：合法动作 → 调用 deps.action 并原样返回 200', async (t) => {
  const { host, handlers } = fakeHost();
  const seen: Array<{ action: RaccoonAction; body: Record<string, unknown> }> = [];
  registerRoutes(host, {
    status: async () => ({ ok: true }),
    action: async (action, body) => {
      seen.push({ action, body });
      return { ok: true, echo: action };
    },
  });
  const port = await serve(handlers, t);
  const res = await call(port, {
    method: 'POST',
    path: ACTION_PATH,
    body: JSON.stringify({ action: 'switch-account', accountId: 'acc_a' }),
  });
  assert.equal(res.status, 200, '合法动作应 200');
  assert.deepEqual(JSON.parse(res.text), { ok: true, echo: 'switch-account' }, 'deps.action 的结果应原样下发');
  assert.deepEqual(seen.map((item) => item.action), ['switch-account'], 'deps.action 应收到请求里的动作名');
  assert.equal(seen[0]?.body['accountId'], 'acc_a', '请求体其余字段应原样传给 deps.action');
});

test('POST /action：deps.action 抛 code-expired → 200 且 ok=false、error.code 保持 code-expired', async (t) => {
  const { host, handlers } = fakeHost();
  registerRoutes(host, {
    status: async () => ({ ok: true }),
    action: async () => {
      const error = new Error('授权码已失效') as Error & { code: string };
      error.code = 'code-expired';
      throw error;
    },
  });
  const port = await serve(handlers, t);
  const res = await call(port, {
    method: 'POST',
    path: ACTION_PATH,
    body: JSON.stringify({ action: 'login-code', text: 'x' }),
  });
  assert.equal(res.status, 200, '业务错误是可预期结果，应 200 而不是 5xx');
  const body = JSON.parse(res.text) as { ok?: boolean; error?: { code?: string; message?: string } };
  assert.equal(body.ok, false, 'ok 应为 false');
  assert.equal(body.error?.code, 'code-expired', `error.code 应透传 code-expired，实际是 ${String(body.error?.code)}`);
  assert.equal(body.error?.message, '授权码已失效', 'error.message 应是原始错误信息');
});

test('GET /action：方法错 → 405 且 error.code 为 method-not-allowed', async (t) => {
  const { host, handlers } = fakeHost();
  let called = 0;
  registerRoutes(host, {
    status: async () => ({ ok: true }),
    action: async () => { called += 1; return { ok: true }; },
  });
  const port = await serve(handlers, t);
  const res = await call(port, { path: ACTION_PATH });
  assert.equal(res.status, 405, '动作路由只接受 POST，GET 应 405');
  const body = JSON.parse(res.text) as { error?: { code?: string } };
  assert.equal(body.error?.code, 'method-not-allowed', `error.code 应为 method-not-allowed，实际是 ${String(body.error?.code)}`);
  assert.equal(called, 0, '方法错的请求不得进入 deps.action');
});
