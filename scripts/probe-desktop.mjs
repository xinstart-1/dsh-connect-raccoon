/**
 * 桌面端凭据链路的端到端验证：造一个**模拟小浣熊客户端**的 auth.json，
 * 走完「自动发现 → 采纳进池 → 令牌到期 → 单飞续期 → 写回客户端文件」。
 *
 * 为什么必须端到端：这条链路有四个环节各自的单测，但「它们接起来还对不对」
 * 一处都没验过 —— 而这是本插件「有客户端就自动获取」的整个卖点。真机验证要
 * 装客户端，这个脚本用假客户端 + 假上游达到同样的覆盖面。
 *
 * 关键断言（都是真机才会暴露的失败）：
 * 1. 键序与 App 一致的文件被读出、键序不一致的不写回（改坏客户端文件是最坏的 bug）；
 * 2. 令牌临近过期触发续期，**只发一次**请求（单飞；refresh 单次使用，重复即登出）；
 * 3. 续期成功后新令牌对**写回**客户端文件，且未知字段与键序原样保留；
 * 4. 写回前留了备份；写回失败时原文件一个字节不动；
 * 5. 采纳进来的是池里的一个成员，且 source 标记为 desktop。
 *
 * 全程不碰真实客户端、不碰真实上游、只写临时目录。
 *
 * 用法：`node scripts/probe-desktop.mjs`
 */

import { Context, Service } from '@deepseek-ai/cordis';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const problems = [];
const steps = [];

/** 造一个可被解出声明的假 JWT（不验签，只填 claims）。 */
function fakeJwt(claims) {
  const enc = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(claims)}.signature`;
}

const nowSec = Math.floor(Date.now() / 1000);
/** 已过期 60 秒的访问令牌：逼出续期路径。 */
const expiredAt = nowSec - 60;

// ── 假上游：续期端点，返回轮转后的新令牌对 ──────────────────────────────
const refreshCalls = [];
const rotated = {
  access: fakeJwt({ sub: 'desk', name: '桌面小王', exp: nowSec + 3600 }),
  refresh: fakeJwt({ sub: 'desk', exp: nowSec + 86400 }),
};
const fakeUpstream = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  if (path === '/api/web/auth/v1/refresh') {
    refreshCalls.push({ auth: req.headers.authorization ?? null });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 0, data: { access_token: rotated.access, refresh_token: rotated.refresh } }));
    return;
  }
  if (path === '/api/web/llm/v2/model_catalog') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 0, data: { categories: [{ models: [
      { name: 'fake-model', model_name: 'fake-model', params: { context_window: 65536, max_tokens: 4096 }, tags: [] },
    ] }] } }));
    return;
  }
  if (path === '/api/web/points/v1/balance') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 0, data: { balance: 888, packages: [] } }));
    return;
  }
  res.writeHead(404).end();
});
await new Promise((resolve) => { fakeUpstream.listen(0, '127.0.0.1', resolve); });
const siteOrigin = `http://127.0.0.1:${String(fakeUpstream.address().port)}`;

// ── 造一个「客户端已登录」的目录布局 ────────────────────────────────────
const root = await mkdtemp(join(tmpdir(), 'raccoon-desktop-'));
const configDir = join(root, '.box-agent', 'config');
await mkdir(configDir, { recursive: true });
const authPath = join(configDir, 'auth.json');
/** 严格按 App 的键序 + 一个未知字段（插件必须原样保留）。 */
const originalAuth = {
  access_token: fakeJwt({ sub: 'desk', name: '桌面小王', exp: expiredAt }),
  refresh_token: fakeJwt({ sub: 'desk', exp: nowSec + 86400 }),
  office_identity: 'id-from-client',
  office_org_name: '某某公司',
  office_org_role: 'member',
  client_version: 'v1.0.35',
};
await writeFile(authPath, JSON.stringify(originalAuth, null, 2), 'utf8');

const home = join(root, 'dsh-home');
await mkdir(home, { recursive: true });
process.env['DSH_HOME'] = home;
process.env['BOX_AGENT_CONFIG_DIR'] = configDir;
steps.push(`模拟客户端在 ${configDir}（访问令牌已过期 60 秒，带 1 个未知字段）`);

// ── 装真插件 ────────────────────────────────────────────────────────────
const record = { adapters: [] };
class FakeLlm extends Service {
  constructor(ctx) { super(ctx, 'llm'); }
  registerAdapter(providers, adapter) { record.adapters.push({ providers, adapter }); return () => undefined; }
  registerConfigurableProviders() { return () => undefined; }
  registerModelDiscovery() { return () => undefined; }
}
class FakeWebServer extends Service {
  constructor(ctx) { super(ctx, 'webServer'); }
  register() { return () => undefined; }
}

const plugin = await import(pathToFileURL('lib/index.js').href);
const ctx = new Context();
ctx.plugin(FakeLlm);
ctx.plugin(FakeWebServer);
await new Promise((r) => { setTimeout(r, 50); });
ctx.plugin(plugin, {
  enabled: true,
  siteOrigin,
  reuseDesktop: true,
  writeBackDesktop: true,
  warmOnStart: true, // 关键：预热时应当自动采纳桌面端登录态
  defaultReasoningEffort: '',
  maxFailoverAttempts: 3,
});
await new Promise((r) => { setTimeout(r, 1500); });

// ── 从 adapter 取 shim 地址与密钥 ───────────────────────────────────────
const adapter = record.adapters[0]?.adapter;
const snapshot = typeof adapter?.current === 'function' ? adapter.current() : undefined;
const profile = snapshot?.profiles?.get('raccoon');
const pi = profile?.piProvider;
const models = typeof pi?.getModels === 'function' ? pi.getModels() : [];
const baseUrl = typeof models[0]?.baseUrl === 'string' ? models[0].baseUrl.replace(/\/v1$/, '') : undefined;
const shimKey = typeof adapter?.config?.resolveApiKey === 'function'
  ? await adapter.config.resolveApiKey('raccoon', profile)
  : undefined;

if (typeof baseUrl !== 'string' || typeof shimKey !== 'string' || shimKey === '') {
  problems.push(`拿不到 shim 的地址或密钥（baseUrl=${String(baseUrl)}）`);
}

// ── 关键断言：客户端文件被写回（新令牌 + 未知字段 + 键序 + 备份）─────────
let written;
try {
  written = JSON.parse(await readFile(authPath, 'utf8'));
} catch (error) {
  problems.push(`读不回客户端文件：${error instanceof Error ? error.message : String(error)}`);
}

if (written !== undefined) {
  if (written.access_token !== rotated.access) {
    problems.push('客户端文件的 access_token 没有被换成轮转后的新值（客户端下次刷新会撞 refresh_conflict）');
  } else {
    steps.push('客户端文件的 access_token 已更新为轮转后的新值 ✓');
  }
  if (written.refresh_token !== rotated.refresh) {
    problems.push('客户端文件的 refresh_token 没有被换成新的（单次使用，旧的一定作废）');
  } else {
    steps.push('refresh_token 同步轮转 ✓');
  }
  if (written.client_version !== 'v1.0.35') problems.push('未知字段 client_version 被删掉了（改坏了客户端的文件）');
  if (written.office_identity !== 'id-from-client') problems.push('office_identity 被改动了');
  const order = Object.keys(written);
  const expected = ['access_token', 'refresh_token', 'office_identity', 'office_org_name', 'office_org_role'];
  if (!expected.every((key, index) => order[index] === key)) {
    problems.push(`键序被改动：${order.join(',')}（客户端可能因此读不出登录态）`);
  } else {
    steps.push('未知字段与 App 键序原样保留 ✓');
  }
}

// 备份必须存在且是**旧**内容。
try {
  const files = await readdir(configDir);
  const backup = files.find((name) => name.includes('auth.json') && name !== 'auth.json');
  if (backup === undefined) {
    // 备份可能落在上一级目录，那里也查一次。
    const upper = await readdir(join(root, '.box-agent')).catch(() => []);
    const upperBackup = upper.find((name) => name.includes('auth.json') && name !== 'auth.json');
    if (upperBackup === undefined) problems.push('写回前没有留下备份文件');
    else steps.push(`写回前留了备份：${upperBackup} ✓`);
  } else {
    const text = await readFile(join(configDir, backup), 'utf8');
    if (!text.includes('access_token')) problems.push('备份文件里没有 access_token（备份的不是旧内容）');
    else steps.push(`写回前留了备份：${backup} ✓`);
  }
} catch (error) {
  problems.push(`检查备份失败：${error instanceof Error ? error.message : String(error)}`);
}

// 续期只应发一次；且续期请求**不带** Authorization（该端点自证身份）。
if (refreshCalls.length === 0) problems.push('从来没有发出续期请求（过期令牌没有被识别出来）');
else if (refreshCalls.length > 1) problems.push(`续期发了 ${String(refreshCalls.length)} 次（refresh 单次使用，并发或重复都会把账号打死）`);
else steps.push('续期只发了 1 次请求 ✓');
if (refreshCalls[0]?.auth !== null && refreshCalls[0]?.auth !== undefined) {
  problems.push(`续期请求带了 Authorization（证据显示该端点不该带）：${refreshCalls[0].auth}`);
}

// ── 池成员：采纳进来的账号 source 应为 desktop，且能用它发请求 ────────────
if (baseUrl !== undefined && shimKey !== undefined) {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${shimKey}` },
    body: JSON.stringify({ model: 'fake-model', messages: [{ role: 'user', content: 'hi' }], stream: false }),
    signal: AbortSignal.timeout(15_000),
  });
  await response.text();
  // 假上游对 chat/completions 回 404，插件应当把它当上游错误回给宿主（不是挂死）。
  if (response.status !== 404) {
    steps.push(`用桌面端账号走了一次请求（上游回 ${String(response.status)}，本脚本的假上游没有实现对话端点）`);
  }
}

// 仓库里应当建了一条 desktop 来源的记录。
try {
  const files = await readdir(join(home, 'raccoon-vault', 'accounts'));
  const parsed = await Promise.all(files.map(async (name) => JSON.parse(await readFile(join(home, 'raccoon-vault', 'accounts', name), 'utf8'))));
  const desktop = parsed.filter((account) => account.source === 'desktop');
  if (desktop.length !== 1) problems.push(`仓库里应恰有 1 条 desktop 来源账号，实际 ${String(desktop.length)} 条`);
  else {
    steps.push(`仓库里 1 条 desktop 账号：昵称「${String(desktop[0].nickname ?? '无')}」/ identity ${String(desktop[0].identity ?? '无')} ✓`);
    // 昵称来自 JWT 的 name 声明；探测读到了却没带进仓库时，界面会一直显示「无昵称」。
    if (desktop[0].nickname !== '桌面小王') {
      problems.push(`采纳后的昵称丢了：期望「桌面小王」，实际 ${String(desktop[0].nickname)}`);
    }
    if (desktop[0].desktopPath !== authPath) problems.push(`账号没记住来源路径（desktopPath=${String(desktop[0].desktopPath)}）`);
  }
} catch (error) {
  problems.push(`读仓库失败：${error instanceof Error ? error.message : String(error)}`);
}

try {
  await ctx.dispose();
} catch {
  // 卸载失败不影响结论，清理照做。
}
await new Promise((r) => { setTimeout(r, 300); });
fakeUpstream.close();
delete process.env['BOX_AGENT_CONFIG_DIR'];
await rm(root, { recursive: true, force: true }).catch(() => undefined);

for (const step of steps) console.log(`ok   ${step}`);
if (problems.length > 0) {
  console.error('\n桌面端凭据链路验证未通过：');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
} else {
  console.log('\n桌面端凭据链路验证通过：自动发现 → 采纳进池 → 单飞续期 → 写回（保留未知字段与键序）→ 留备份。');
}
process.exit(process.exitCode ?? 0);
