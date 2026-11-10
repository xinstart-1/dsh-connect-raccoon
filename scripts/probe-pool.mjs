/**
 * 账号池 + 自动换号的端到端验证：用一台**本地假小浣熊**当上游。
 *
 * 为什么值得单开一个脚本：池的挑选逻辑有纯函数单测、shim 的换号有协议层单测，
 * 但「真插件装进真 Cordis 之后，一次真实请求到底用了哪个账号、失败时有没有换」
 * 这条链路没有一处证明过 —— 而它正是本插件的核心卖点。
 *
 * 做法：`siteOrigin` 指向本地假服务器 → 临时 DSH_HOME → 两个假账号 → 装真插件 →
 * 第一个账号返回 401 → 断言请求落到了第二个账号，且第二次请求不再重复烧失败。
 *
 * 全程不碰真实上游、不碰真实账号、不写用户目录。
 *
 * 用法：`node scripts/probe-pool.mjs`
 */

import { Context, Service } from '@deepseek-ai/cordis';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const problems = [];
const steps = [];

/** 造一个可被 `decodeJwtFacts` 读出声明的假 JWT（不验签，只填 claims）。 */
function fakeJwt(claims) {
  const enc = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(claims)}.signature`;
}

const nowSec = Math.floor(Date.now() / 1000);
const accountId = (key) => `acc_${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
const buildAccount = (key, nickname) => ({
  schemaVersion: 1,
  id: accountId(key),
  accountKey: key,
  accessToken: fakeJwt({ sub: key, name: nickname, exp: nowSec + 3600 }),
  refreshToken: fakeJwt({ sub: key, exp: nowSec + 86400 }),
  // 凭据更新者排前面：两个账号其余条件相同时，排序键落到 `expiresAtMs`，
  // 所以要「谁先被选中」就必须让它更晚过期 —— 否则顺序取决于读目录顺序。
  expiresAtMs: (nowSec + 3600) * 1000,
  refreshExpiresAtMs: (nowSec + 86400) * 1000,
  source: 'web',
  savedAtMs: Date.now(),
  nickname,
});
// A 凭据更新（排序的最末一级），B 余额更高 —— 用来验证「余额高优先」压过「凭据新」。
const accountA = { ...buildAccount('sub-A', '账号A'), expiresAtMs: (nowSec + 7200) * 1000 };
const accountB = buildAccount('sub-B', '账号B');

// ── 假上游 ──────────────────────────────────────────────────────────────
const seen = [];
/** 让哪个账号这次回 401（默认 A：B 是首选，先验正常路径）。 */
let failNext = 'A';
const fakeUpstream = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  if (path === '/api/web/llm/v2/model_catalog') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      code: 0,
      data: { categories: [{ models: [
        { name: 'fake-model', model_name: 'fake-model', params: { context_window: 65536, max_tokens: 4096 }, tags: [] },
      ] }] },
    }));
    return;
  }
  if (path === '/api/web/points/v1/balance') {
    // 余额按令牌区分：B 更高。池排序里「余额高优先」若没接线，会恒选 A（凭据更新者）。
    const auth = req.headers.authorization ?? '';
    const who = auth.includes(accountB.accessToken) ? 'B' : 'A';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 0, data: { balance: who === 'B' ? 9000 : 100, packages: [] } }));
    return;
  }
  if (path === '/api/web/llm/v2/chat/completions') {
    const auth = req.headers.authorization ?? '';
    const who = auth.includes(accountA.accessToken) ? 'A' : auth.includes(accountB.accessToken) ? 'B' : 'unknown';
    seen.push(who);
    if (who === failNext) {
      // 令牌失效：属于「换号有意义」的分类（ADR-6）。
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 200003, message: 'authorization_verify_error' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
    return;
  }
  res.writeHead(404).end();
});
await new Promise((resolve) => { fakeUpstream.listen(0, '127.0.0.1', resolve); });
const siteOrigin = `http://127.0.0.1:${String(fakeUpstream.address().port)}`;
steps.push(`假上游 ${siteOrigin}`);

// ── 临时 DSH_HOME：两个账号、池已开启、当前选 A ─────────────────────────
const home = await mkdtemp(join(tmpdir(), 'raccoon-pool-'));
const vaultDir = join(home, 'raccoon-vault');
await mkdir(join(vaultDir, 'accounts'), { recursive: true });
for (const account of [accountA, accountB]) {
  await writeFile(join(vaultDir, 'accounts', `${account.id}.json`), JSON.stringify(account, null, 2), 'utf8');
}
await writeFile(join(vaultDir, 'selected.json'), JSON.stringify({ version: 1, accountId: accountA.id }), 'utf8');
await writeFile(join(home, 'dsh-connect-raccoon-state.json'), JSON.stringify({
  schemaVersion: 1,
  disabledModels: [],
  accountPoolEnabled: true,
  enabledAccounts: [accountA.id, accountB.id],
  composerPill: true,
  pollIntervalMs: 60000,
  autoCheckin: false,
}, null, 2), 'utf8');
process.env['DSH_HOME'] = home;
steps.push('临时 DSH_HOME 里 2 个账号，池已开启；A 凭据更新、B 余额更高（9000 vs 100）');

// ── 用真的 Cordis 装载真插件 ────────────────────────────────────────────
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
  reuseDesktop: false,
  writeBackDesktop: false,
  warmOnStart: false,
  defaultReasoningEffort: '',
  maxFailoverAttempts: 3,
});
await new Promise((r) => { setTimeout(r, 1200); });

const adapter = record.adapters[0]?.adapter;
// PiAiAdapter 的读法：`current()` 拿快照，再按 provider 取 profile。
// 直接 `config.profiles()` 也拿得到 Map，但那绕过了 adapter 自己的解析规则。
const snapshot = typeof adapter?.current === 'function' ? adapter.current() : undefined;
if (snapshot === undefined) {
  problems.push(`adapter 上没有 current()（形状变了：${Object.keys(adapter ?? {}).join(',')}）`);
}
const profile = snapshot?.profiles?.get('raccoon');
const pi = profile?.piProvider;
const models = typeof pi?.getModels === 'function' ? pi.getModels() : [];
const modelBase = models[0]?.baseUrl;
const baseUrl = typeof modelBase === 'string' ? modelBase.replace(/\/v1$/, '') : undefined;
const shimKey = typeof adapter?.config?.resolveApiKey === 'function'
  ? await adapter.config.resolveApiKey('raccoon', profile)
  : undefined;

if (typeof baseUrl !== 'string' || typeof shimKey !== 'string' || shimKey === '') {
  problems.push(`拿不到 shim 的地址或密钥（baseUrl=${String(baseUrl)}）`);
} else {
  steps.push(`shim ${baseUrl}（地址由插件自己起，密钥长度 ${String(shimKey.length)}）`);

  const chat = async () => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${shimKey}` },
      body: JSON.stringify({ model: 'fake-model', messages: [{ role: 'user', content: 'hi' }], stream: true }),
      signal: AbortSignal.timeout(20_000),
    });
    return { status: response.status, text: await response.text() };
  };

  // 关键断言①：余额高的 B 先被选中。
  // 此前 index.ts 把 credits 硬编码成 undefined，池排序里「快过期先花」与
  // 「余额高优先」两条规则从未生效，选号退化成只看凭据新旧 ——
  // 用户以为在按余额调度，其实没有。
  const first = await chat();
  if (first.status !== 200) problems.push(`首个请求应成功，实际 ${String(first.status)}：${first.text.slice(0, 160)}`);
  else if (!first.text.includes('ok')) problems.push(`没拿到正文：${first.text.slice(0, 160)}`);
  if (seen.length !== 1 || seen[0] !== 'B') {
    problems.push(`应直接用余额更高的 B（余额高优先），实际上游调用序列 ${seen.join(',') || '（无）'}`);
  } else {
    steps.push('余额更高的 B 先被选中（「余额高优先」真的接上了）✓');
  }

  // 关键断言②：把 B 打成 401，同一请求内换到 A。
  seen.length = 0;
  failNext = 'B';
  const second = await chat();
  if (second.status !== 200) problems.push(`换号后应回 200，实际 ${String(second.status)}`);
  if (seen.length !== 2 || seen[0] !== 'B' || seen[1] !== 'A') {
    problems.push(`换号序列应为 B→A，实际 ${seen.join('→') || '（无）'}`);
  } else {
    steps.push(`换号 B(401) → A(200) ✓ 上游调用序列 ${seen.join('→')}`);
  }

  // 关键断言③：B 已进冷却，下次直接用 A，不再重复烧失败。
  seen.length = 0;
  const third = await chat();
  if (third.status !== 200) problems.push(`第三次请求应回 200，实际 ${String(third.status)}`);
  if (seen.length !== 1 || seen[0] !== 'A') {
    problems.push(`B 冷却后应直接只用 A 一次，实际 ${seen.join(',') || '（没有调用）'}`);
  } else {
    steps.push('第三次请求直接用 A（B 在冷却中，没重复烧失败）✓');
  }
}

try {
  await ctx.dispose();
} catch {
  // 卸载失败不影响结论，下面的清理照样要做。
}
await new Promise((r) => { setTimeout(r, 300); });
fakeUpstream.close();
await rm(home, { recursive: true, force: true }).catch(() => undefined);

for (const step of steps) console.log(`ok   ${step}`);
if (problems.length > 0) {
  console.error('\n账号池 / 自动换号验证未通过：');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
} else {
  console.log('\n账号池 / 自动换号验证通过：余额高的先选、失败自动换号、冷却后不再重复烧。');
}
// 显式退出：插件起过监听端口与定时器，不主动退出时进程会一直挂着。
process.exit(process.exitCode ?? 0);
