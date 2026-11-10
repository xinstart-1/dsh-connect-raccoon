/**
 * 装载冒烟：用真的 `apply()` 装一次，再打两条路由与 shim。
 *
 * 单测覆盖各层，但没有一处证明 `apply()` 真把它们接起来了 —— shim 有没有起、
 * adapter 有没有注册、路由有没有挂上、卸载后端口有没有关，只有真装一次才知道。
 *
 * 本脚本**不访问公网**：上游客户端在没登录时一个请求都不发（配置里关掉预热）。
 *
 * 用法：`node scripts/smoke-apply.mjs`
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const problems = [];
const home = await mkdtemp(join(tmpdir(), 'raccoon-smoke-'));
process.env['DSH_HOME'] = home;

/** 收集注册结果与清理函数。 */
const registered = { adapters: [], providers: [], discoveries: [], routes: new Map() };
const cleanups = [];
const logs = [];

const fakeCtx = {
  logger: {
    info: (message) => { logs.push(message); },
    warn: (message) => { logs.push(message); },
    error: (message) => { logs.push(message); },
  },
  llm: {
    registerAdapter: (providers, adapter) => {
      registered.adapters.push({ providers, adapter });
      return () => { registered.adapters.length = 0; };
    },
    registerConfigurableProviders: (list) => {
      registered.providers.push(...list);
      return () => { registered.providers.length = 0; };
    },
    registerModelDiscovery: (ns, fn) => {
      registered.discoveries.push({ ns, fn });
    },
  },
  inject: (services, callback) => {
    if (!services.includes('webServer')) return;
    callback({
      effect: (fn) => { cleanups.push(fn()); },
      webServer: {
        register: (entry) => {
          registered.routes.set(entry.path, entry.handler);
          return () => { registered.routes.delete(entry.path); };
        },
      },
    });
  },
  effect: (factory) => { cleanups.push(factory()); },
  on: () => () => undefined,
  get: () => undefined,
};

const module = await import(pathToFileURL('lib/index.js').href);

if (module.name !== 'dsh-connect-raccoon') problems.push(`name 导出不对：${String(module.name)}`);
if (!Array.isArray(module.inject) || !module.inject.includes('llm')) problems.push('inject 缺 llm');
if (typeof module.apply !== 'function') problems.push('缺 apply');

await module.apply(fakeCtx, {
  enabled: true,
  siteOrigin: '',
  reuseDesktop: false, // 测试机可能没装客户端：避免读真实家目录
  writeBackDesktop: false,
  warmOnStart: false, // 关键：不发热身请求
  defaultReasoningEffort: '',
  maxFailoverAttempts: 3,
});

// 1. LLM 面。
if (registered.adapters.length !== 1) problems.push(`registerAdapter 应被调用一次，实际 ${registered.adapters.length}`);
else if (!registered.adapters[0].providers.includes('raccoon')) problems.push('adapter 的 provider 不是 raccoon');
if (registered.providers.length !== 1) problems.push('registerConfigurableProviders 应被调用一次');
if (registered.discoveries.length !== 1) problems.push('registerModelDiscovery 应被调用一次');
else {
  // 模型发现必须**同步可用**：宿主装配期间就要能列出模型（兜底目录），否则选择器整组消失。
  const models = await registered.discoveries[0].fn({ provider: 'raccoon' });
  if (!Array.isArray(models) || models.length === 0) problems.push('模型发现在还没登录时返回空（应该有内置兜底）');
  else console.log(`ok   模型发现返回 ${String(models.length)} 个兜底模型`);
  const others = await registered.discoveries[0].fn({ provider: 'someone-else' });
  if (!Array.isArray(others) || others.length !== 0) problems.push('别的 provider 不该拿到模型');
}

// 2. 两条路由：起一个真的 HTTP 服务器把它们挂上去。
//    为什么不用请求替身：路由 handler 是「fire-and-forget」的（`void deps.status().then(...)`），
//    替身拿不到延迟到达的响应，会把「还没写完」误判成失败。
const routes = registered.routes;
const server = createServer((request, response) => {
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  const handler = routes.get(path);
  if (handler === undefined) {
    response.writeHead(404).end();
    return;
  }
  void handler(request, response);
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const base = `http://127.0.0.1:${String(server.address().port)}`;
const closeServer = () => new Promise((resolve) => {
  server.closeAllConnections?.();
  server.close(() => { resolve(); });
});

if (routes.get('/plugins/dsh-connect-raccoon/status') === undefined) problems.push('status 路由没注册');
if (routes.get('/plugins/dsh-connect-raccoon/action') === undefined) problems.push('action 路由没注册');
if (problems.length === 0) console.log('ok   两条宿主路由已注册');

if (routes.get('/plugins/dsh-connect-raccoon/status') !== undefined) {
  const response = await fetch(`${base}/plugins/dsh-connect-raccoon/status`);
  if (response.status !== 200) problems.push(`/status 应回 200，实际 ${String(response.status)}`);
  else {
    const doc = await response.json();
    const required = ['schemaVersion', 'version', 'provider', 'desktop', 'accounts', 'pool', 'catalog', 'login', 'checkin', 'state'];
    const missing = required.filter((key) => !(key in doc));
    if (missing.length > 0) problems.push(`/status 缺字段：${missing.join(', ')}`);
    else console.log('ok   /status 返回契约形状');
    if (JSON.stringify(doc).includes('accessToken')) problems.push('/status 里出现了 accessToken 字段');
    if (doc.login?.phase !== 'idle') problems.push(`/status 的登录相位应为 idle，实际 ${String(doc.login?.phase)}`);
    if (doc.desktop?.multiAccount !== false) problems.push('/status 的 desktop.multiAccount 必须是 false');
  }
}

if (routes.get('/plugins/dsh-connect-raccoon/action') !== undefined) {
  const post = (body) =>
    fetch(`${base}/plugins/dsh-connect-raccoon/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const bad = await post({ action: 'no-such-action' });
  if (bad.status !== 400) problems.push(`未知动作应回 400，实际 ${String(bad.status)}`);

  const good = await post({ action: 'login-status' });
  const payload = good.status === 200 ? await good.json() : {};
  if (good.status !== 200) problems.push(`login-status 应回 200，实际 ${String(good.status)}`);
  else if (payload.ok !== true) problems.push('login-status 应回 ok');
  else console.log('ok   动作路由：白名单内放行、白名单外 400');
}

await closeServer();

// 3. shim 真的在监听，且没有密钥就打不动。
const log = logs.find((line) => line.includes('shim http://'));
const shimUrl = /shim (http:\/\/127\.0\.0\.1:\d+)/.exec(logs.join('\n'))?.[1];
if (shimUrl === undefined) problems.push('启动日志里没有 shim 地址（shim 没起来？）');
else {
  const unauthorized = await fetch(`${shimUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }).catch((error) => ({ status: 0, error }));
  if (unauthorized.status !== 401) problems.push(`shim 无密钥应回 401，实际 ${String(unauthorized.status)}`);
  else console.log('ok   shim 在监听，未带密钥被 401 拒绝');
}

// 4. 卸载：所有 disposer 要被调用，端口要真的关掉。
for (const cleanup of cleanups) {
  if (typeof cleanup !== 'function') continue;
  await cleanup();
}
if (shimUrl !== undefined) {
  const afterClose = await fetch(`${shimUrl}/v1/chat/completions`, { method: 'POST', body: '{}' }).then(
    (response) => response.status,
    () => 'closed',
  );
  if (afterClose !== 'closed') problems.push(`卸载后 shim 仍可访问（${String(afterClose)}）`);
  else console.log('ok   卸载后 shim 端口已关闭');
}

await rm(home, { recursive: true, force: true });

if (problems.length > 0) {
  console.error('\n装载冒烟失败：');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
} else {
  console.log('\n装载冒烟全部通过（apply 真的把各层接起来了）。');
}
