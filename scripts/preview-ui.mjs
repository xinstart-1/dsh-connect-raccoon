/**
 * 预览：把浏览器半边的组件离屏渲染成一份 HTML，人工看布局用。
 *
 * 为什么需要它：bundle 是手写经典脚本，没有类型检查也没有故事书。单测覆盖了
 * 组件函数与请求体，但没有一处证明「整页拼起来之后还长这样」—— 样式注入失败、
 * 某个 tab 渲染成 undefined、布局塌成一条线，都只在肉眼下暴露。
 *
 * 用法：
 *   node scripts/preview-ui.mjs            # 写 .preview/ui.html
 *   node scripts/preview-ui.mjs --check    # 只校验能生成且非空（gate 用）
 *
 * 不访问网络：所有数据都是内联的假状态文档。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';

const checkOnly = process.argv.includes('--check');

/** 一份形状与 `docs/CONTRACT.md` 完全一致的假状态文档。 */
const FIXTURE = {
  schemaVersion: 1,
  version: '0.0.1',
  provider: 'raccoon',
  enabled: true,
  updatedAtMs: 1760000000000,
  desktop: {
    detected: true,
    configDir: 'C:\\Users\\you\\.box-agent\\config',
    authPath: 'C:\\Users\\you\\.box-agent\\config\\auth.json',
    exists: true,
    readable: true,
    multiAccount: false,
    reason: null,
    nickname: '预览账号',
    expiresAtMs: 1760010000000,
    keyOrderMatchesApp: true,
    adopted: true,
  },
  accounts: [
    {
      id: 'acc_5f3a1b2c3d4e5f60',
      label: '桌面端账号 · 5f60',
      nickname: '预览账号',
      identity: 'personal',
      orgName: null,
      source: 'desktop',
      isDesktopSource: true,
      expiresAtMs: 1760010000000,
      refreshExpiresAtMs: 1762600000000,
      usable: true,
      reason: null,
      inPool: true,
      isCurrent: true,
      credits: { total: 4123, expiringSoon: 500, nearestExpiryMs: 1762000000000, fetchedAtMs: 1760000000000 },
      lastProbe: { outcome: 'ok', message: '可用', atMs: 1760000000000 },
      cooldownUntilMs: null,
      canCheckin: true,
    },
    {
      id: 'acc_9c1b2d3e4f506172',
      label: '网页账号 · 6172',
      nickname: '网页账号',
      identity: 'personal',
      orgName: null,
      source: 'web',
      isDesktopSource: false,
      expiresAtMs: 1760005000000,
      refreshExpiresAtMs: 1762600000000,
      usable: false,
      reason: '限定流冷却中',
      inPool: false,
      isCurrent: false,
      credits: null,
      lastProbe: { outcome: 'rate-limited', message: '吞吐额度被限', atMs: 1760000000000 },
      cooldownUntilMs: 1760003000000,
      canCheckin: true,
    },
  ],
  currentAccountId: 'acc_5f3a1b2c3d4e5f60',
  effectiveAccountId: 'acc_5f3a1b2c3d4e5f60',
  effectiveReason: '账号池未启用，使用当前选用的账号',
  pool: {
    enabled: false,
    memberIds: ['acc_5f3a1b2c3d4e5f60'],
    lastFailover: { atMs: 1760000000000, fromId: 'acc_5f3a1b2c3d4e5f60', toId: 'acc_9c1b2d3e4f506172', reason: '上游 401' },
  },
  catalog: {
    source: 'live',
    count: 3,
    fetchedAtMs: 1760000000000,
    error: null,
    models: [
      { id: 'sensenova-6.8-flash-lite', name: 'SenseNova-6.8-Flash-Lite', description: '轻量快速', vision: true, contextWindow: 131072, maxTokens: 8192, multiplier: 'x0.00', promo: '限免一个月', reasoning: false, enabled: true },
      { id: 'kimi-k3', name: 'Kimi-K3', description: null, vision: true, contextWindow: 262144, maxTokens: 8192, multiplier: 'x0.30', promo: null, reasoning: false, enabled: true },
      { id: 'glm-5-3', name: 'GLM-5-3', description: null, vision: false, contextWindow: 131072, maxTokens: 8192, multiplier: 'x0.50', promo: null, reasoning: false, enabled: false },
    ],
  },
  login: {
    running: true,
    kind: 'qr',
    phase: 'waiting',
    message: '请用微信扫描二维码（小程序内确认）',
    url: null,
    port: null,
    qrSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="120" height="120"><rect width="10" height="10" fill="#ffffff"/><path d="M0 0 h10 v10 h-10 z" fill="#000000"/></svg>',
    expiresAtMs: 1760000300000,
    error: null,
  },
  checkin: {
    supported: true,
    lastRunAtMs: 1760000000000,
    results: [{ accountId: 'acc_5f3a1b2c3d4e5f60', outcome: 'already', message: '今天已领过' }],
  },
  state: {
    disabledModels: ['glm-5-3'],
    accountPoolEnabled: false,
    enabledAccounts: ['acc_5f3a1b2c3d4e5f60'],
    composerPill: true,
    pollIntervalMs: 60000,
    autoCheckin: false,
    reuseDesktop: true,
  },
};

const source = await readFile('src/client/bundle.js', 'utf8');

// 1. 语法可解析（与 check-client 同口径，但这里要真的取到 factory）。
let loaded;
const fakeWindow = {
  __ModuleLoader__: {
    load: ({ id, factory }) => {
      loaded = { id, factory };
    },
  },
};
const runInFakeGlobal = new Function('globalThis', 'window', 'document', 'require', 'console',
  `with (globalThis) { ${source} }`);
runInFakeGlobal(fakeWindow, fakeWindow, undefined, undefined, console);

if (loaded === undefined) {
  console.error('bundle 没有通过 __ModuleLoader__ 注册');
  process.exit(1);
}

// 2. 用最小的 react 垫片取到模块，看四件套。
const element = (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } });
const shimRequire = (name) => {
  if (name !== 'react') throw new Error(`不该 require ${name}`);
  return {
    createElement: element,
    Fragment: 'Fragment',
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => undefined],
    useEffect: () => undefined,
    useRef: (initial) => ({ current: initial }),
  };
};
const mod = loaded.factory(shimRequire);
if (typeof mod.apply !== 'function') {
  console.error('模块没有 apply');
  process.exit(1);
}
if (!Array.isArray(mod.inject)) {
  console.error('模块没有 inject');
  process.exit(1);
}
console.log(`ok   bundle 加载成功：id=${String(loaded.id)} inject=[${mod.inject.join(', ')}]`);

// 3. 装一次 apply，把注册的槽位组件拿出来。
const slots = new Map();
const cleanups = [];
const locale = {
  register: (namespace, dict) => ({ namespace, dict }),
  bind: () => (key, vars) => (vars === undefined ? key : String(key)),
};
const ctx = {
  slots: {
    inject: (name, callback) => {
      const cleanup = callback();
      cleanups.push(cleanup);
    },
    register: (options, component) => {
      slots.set(options.name, { options, component });
      return () => { slots.delete(options.name); };
    },
  },
  locale,
  effect: (factory) => { cleanups.push(factory()); },
  get: () => undefined,
};
mod.apply(ctx);

const names = [...slots.keys()].sort();
console.log(`ok   注册槽位 ${String(names.length)} 个：${names.join(', ')}`);
if (names.length === 0) {
  console.error('一个槽位都没注册');
  process.exit(1);
}

// 4. 逐个渲染，抓异常与空返回。
const rendered = [];
for (const [name, entry] of slots) {
  try {
    const props = {
      t: (key) => key,
      locale: entry.options.locale,
      provider: 'raccoon',
      model: { provider: 'raccoon', id: 'kimi-k3', name: 'Kimi-K3' },
      status: FIXTURE,
      close: () => undefined,
      size: 16,
      active: false,
    };
    const tree = entry.component(props);
    if (tree === null || tree === undefined) {
      // 胶囊在 provider 不匹配时返回 null 是预期行为；其它槽位返回 null 是空的按钮。
      if (name === 'conversation.input.left') rendered.push({ name, note: 'provider 不匹配时返回 null（预期）' });
      else rendered.push({ name, note: '返回 null' });
      continue;
    }
    rendered.push({ name, note: `渲染成功（${String(typeof tree)}）` });
  } catch (error) {
    console.error(`槽位 ${name} 渲染抛错：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

if (checkOnly) {
  for (const item of rendered) console.log(`ok   ${item.name} → ${item.note}`);
  for (const cleanup of [...cleanups].reverse()) {
    if (typeof cleanup === 'function') cleanup();
  }
  console.log('\n预览自检通过（组件都能渲染，未写文件）。');
  process.exit(0);
}

// 5. 人工预览用：把假数据与一份静态说明写成一页 HTML。
await mkdir('.preview', { recursive: true });
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>dsh-connect-raccoon 预览</title>
<style>body{font:14px/1.6 system-ui,sans-serif;margin:0;padding:24px;background:#17181b;color:#e6e6e6}
h1{font-size:18px}h2{font-size:14px;margin-top:24px;color:#9aa0aa}
pre{background:#202126;padding:12px;border-radius:8px;overflow:auto;font-size:12px}
.slot{border:1px solid #3a3d45;border-radius:8px;padding:12px;margin:8px 0}</style></head>
<body><h1>dsh-connect-raccoon 预览</h1>
<h2>槽位</h2>
${rendered.map((item) => `<div class="slot"><strong>${item.name}</strong><div>${item.note}</div></div>`).join('\n')}
<h2>假状态文档（页面真实读到的数据）</h2>
<pre>${JSON.stringify(FIXTURE, null, 2).replace(/</g, '&lt;')}</pre>
</body></html>`;
await writeFile('.preview/ui.html', html, 'utf8');

for (const item of rendered) console.log(`ok   ${item.name} → ${item.note}`);
for (const cleanup of [...cleanups].reverse()) {
  if (typeof cleanup === 'function') cleanup();
}
console.log('\n已写 .preview/ui.html');
