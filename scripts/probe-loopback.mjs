/**
 * 回环回调的端到端验证：对着**运行中的 DSH** 真发一次网页登录，再把回调打回去。
 *
 * 这是整条主线里唯一能自动化的部分。它证明的是：
 * ① 插件真的在 127.0.0.1 的随机端口上起了监听；
 * ② 授权页 URL 里的 `state` 与 `redirect` 形状正确；
 * ③ 回调到达时服务器**立即**回一页 HTML（浏览器不会干等）；
 * ④ `state` 逐字校验生效（错的 state 被 400 拒绝）；
 * ⑤ 拿到码之后真的往上游发了一次换码请求，并按上游错误码归类。
 *
 * **它证明不了**「你在授权页里登录之后浏览器会不会跳回来」—— 那一步需要真人。
 * 用一个假授权码，上游会回 `200035 authorization_code_not_found_error`，
 * 这恰好是预期结果（不可恢复的错误码，文案应引导重新登录）。
 *
 * 用法：`node scripts/probe-loopback.mjs [--url http://127.0.0.1:59224]`
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
const args = process.argv.slice(2);
const urlArg = args.includes('--url') ? args[args.indexOf('--url') + 1] : undefined;
const base = (urlArg ?? process.env['DSH_GUI_URL'] ?? 'http://127.0.0.1:59224').replace(/\/+$/, '');
const ACTION = `${base}/plugins/${pkg.name}/action`;

const problems = [];
const steps = [];

/** 发一个动作，返回解析后的 JSON。 */
async function act(action, body = {}) {
  const response = await fetch(ACTION, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...body }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`动作 ${action} 的响应不是 JSON（HTTP ${String(response.status)}）：${text.slice(0, 200)}`);
  }
}

/** 轮询登录相位直到满足条件。 */
async function waitForPhase(predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    const result = await act('login-status');
    last = result.login;
    if (predicate(last)) return last;
    await new Promise((r) => { setTimeout(r, 250); });
  }
  return last;
}

// ── 1. 起一次网页登录 ────────────────────────────────────────────────────
const started = await act('login-web');
const login = started.login;
if (login?.running !== true || login?.phase !== 'waiting') {
  console.error(`无法开始网页登录：${JSON.stringify(login)}`);
  process.exit(1);
}
steps.push(`phase=${login.phase} port=${String(login.port)}`);
if (typeof login.port !== 'number' || login.port < 1024) {
  problems.push(`回环端口不合法：${String(login.port)}（授权页硬校验要求 1024–65535）`);
}
if (typeof login.url !== 'string' || !login.url.includes('desktop_callback=loopback')) {
  problems.push('授权页 URL 里没有 desktop_callback=loopback（主线通道就断了）');
} else {
  const url = new URL(login.url);
  const state = url.searchParams.get('state') ?? '';
  const redirect = url.searchParams.get('redirect') ?? '';
  if (!/^[a-f0-9]{64}$/.test(state)) problems.push(`state 不是 64 位小写十六进制：${state.slice(0, 20)}…（授权页会拒绝回调）`);
  if (!/^http:\/\/127\.0\.0\.1:\d{4,5}\/auth\/callback$/.test(redirect)) problems.push(`redirect 形状不对：${redirect}`);
  if (url.searchParams.get('login_source') !== 'desktop') problems.push('login_source 不是 desktop');
  steps.push(`state 64hex ✓ redirect ✓ (${redirect})`);
}

// ── 2. 错的 state 必须被拒 ──────────────────────────────────────────────
const wrongState = 'f'.repeat(64);
const wrongResponse = await fetch(`http://127.0.0.1:${String(login.port)}/auth/callback?code=fake&state=${wrongState}`, {
  signal: AbortSignal.timeout(10_000),
}).catch((error) => ({ status: 0, text: async () => String(error) }));
if (wrongResponse.status !== 400) {
  problems.push(`错 state 的回调应回 400，实际 ${String(wrongResponse.status)}`);
} else {
  steps.push('错 state → 400 ✓');
}
const afterWrong = await waitForPhase((view) => view?.phase === 'error', 5000);
if (afterWrong?.error?.code !== 'state-mismatch') {
  problems.push(`错 state 之后相位应为 error/state-mismatch，实际 ${String(afterWrong?.phase)}/${String(afterWrong?.error?.code)}`);
}

// ── 3. 对 state 的回调：必须立刻回 HTML，然后走向换码失败 ────────────────
const restarted = await act('login-web');
if (restarted.login?.running !== true) {
  console.error(`第二次无法开始网页登录：${JSON.stringify(restarted.login)}`);
  process.exit(1);
}
const url2 = new URL(restarted.login.url);
const state2 = url2.searchParams.get('state') ?? '';
const port2 = restarted.login.port;
const began = Date.now();
const okResponse = await fetch(`http://127.0.0.1:${String(port2)}/auth/callback?code=fake-code-for-probe&state=${state2}`, {
  signal: AbortSignal.timeout(10_000),
}).catch((error) => ({ status: 0, text: async () => String(error) }));
const elapsedMs = Date.now() - began;
const body = await okResponse.text();
if (okResponse.status !== 200) problems.push(`对 state 的回调应回 200，实际 ${String(okResponse.status)}`);
if (elapsedMs > 2000) problems.push(`回调响应太慢（${String(elapsedMs)}ms）：浏览器会以为页面挂了`);
if (!body.includes('登录')) problems.push('回调页没有提示文案（用户不知道该关页面）');
steps.push(`对 state 回调 → 200，用时 ${String(elapsedMs)}ms，页面 ${String(body.length)} 字节`);

// 换码会打到真实上游；假码必然被拒（200035），这正是预期的不可恢复分支。
const final = await waitForPhase((view) => view?.running === false, 30_000);
if (final?.phase !== 'error') {
  problems.push(`假授权码换码后相位应为 error，实际 ${String(final?.phase)}`);
} else if (final.error?.code !== 'code-expired') {
  problems.push(`假授权码应归成 code-expired（上游 200035），实际 ${String(final.error?.code)}：${String(final.error?.message)}`);
} else {
  steps.push(`换码失败归类 ✓ code=${String(final.error.code)}（上游 ${String(final.error.message).slice(0, 40)}）`);
}

// 收尾：把会话清掉，别让插件停在 error 相位。
await act('cancel-login').catch(() => undefined);

for (const step of steps) console.log(`ok   ${step}`);
if (problems.length > 0) {
  console.error('\n回环回调验证未通过：');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
} else {
  console.log('\n回环回调验证通过：本地监听、state 校验、立即响应、换码归类都对。');
  console.log('唯一没验的一跳是「真人在授权页登录后浏览器跳回来」—— 那需要你本人登录一次。');
}
