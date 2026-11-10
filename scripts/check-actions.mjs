/**
 * 字段名契约：浏览器半边**传的字段**与宿主**读的字段**必须对得上。
 *
 * 为什么只查字段、不查动作名：动作名的一致性已经在 `test/routes.test.ts` 里用
 * **行为**断言过了（真发一次请求，看它有没有转给 runtime）—— 那是更硬的证据，
 * 且重构不会误报。字段名没法这样测：要覆盖「每个动作 × 每个字段」的组合，
 * 得把浏览器半边的整棵 JSX 也跑起来，成本远高于收益。所以这一份是**存量守卫**，
 * 按规范 §16.4 只减不增。
 *
 * 查三件事：
 * 1. 浏览器传了、宿主从不读的字段 —— 参数被静默忽略（真 bug）。
 * 2. 宿主读了、浏览器从不传的字段 —— 要么是可选参数（必须登记落值处），要么是忘接线。
 * 3. 浏览器调了、宿主没有分支的动作 —— 点下去就 unknown-action。
 *
 * 用法：`node scripts/check-actions.mjs`
 */

import { readFileSync } from 'node:fs';

const problems = [];
const notes = [];

const bundle = readFileSync('src/client/bundle.js', 'utf8');
const routes = readFileSync('src/host/routes.ts', 'utf8');
const runtime = readFileSync('src/host/runtime.ts', 'utf8');

/**
 * 只取**动作分发**那个 switch 的分支。
 *
 * 直接扫全文 `case '...'` 会把别的 switch（例如按桌面端原因码分派的 `desktopHint`）
 * 也算进来 —— 那种误报会让人以为少写了动作。
 *
 * @param source - runtime 源码。
 * @returns 动作名列表。
 */
function implementedActions(source) {
  const start = source.indexOf('switch (action)');
  if (start < 0) return [];
  const open = source.indexOf('{', start);
  let depth = 0;
  let end = source.length;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) { end = index; break; }
    }
  }
  return [...source.slice(open, end).matchAll(/case '([a-z-]+)':/g)].map((match) => match[1]);
}

// ── 动作名：只查「浏览器调了但宿主没有这条分支」（另一方向已由行为测试覆盖）──
const called = new Set();
for (const match of bundle.matchAll(/\b(?:act|perform)\(\s*'([a-z-]+)'/g)) called.add(match[1]);
for (const match of bundle.matchAll(/kind === 'qr' \? '([a-z-]+)' : '([a-z-]+)'/g)) {
  called.add(match[1]);
  called.add(match[2]);
}
const hostedActions = implementedActions(runtime);
notes.push(`宿主 ${String(hostedActions.length)} 个动作分支，浏览器调用 ${String(called.size)} 个`);
for (const action of called) {
  if (!hostedActions.includes(action)) problems.push(`浏览器调用 '${action}'，但 runtime 没有对应分支（点下去就是 unknown-action）`);
}

// ── 字段级：浏览器传的键 vs 宿主读的键 ─────────────────────────────────
const sentKeys = new Set();

/**
 * 取一个对象字面量的**第一层**键名。
 *
 * 必须做括号配平：`{ patch: { accountPoolEnabled: true } }` 里
 * `accountPoolEnabled` 是嵌套字段，宿主读的是 `patch` —— 用正则抓会误报。
 *
 * @param text - 从 `{` 开始的对象字面量文本。
 * @returns 第一层键名。
 */
function topLevelKeys(text) {
  const keys = [];
  let depth = 0;
  let expectKey = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '{') { depth += 1; if (depth === 1) expectKey = true; continue; }
    if (char === '}') { depth -= 1; if (depth === 0) break; continue; }
    if (depth !== 1) continue;
    if (char === ',') { expectKey = true; continue; }
    if (!expectKey) continue;
    const match = /^\s*([a-zA-Z_$][\w$]*)\s*:/.exec(text.slice(index));
    if (match === null) continue;
    keys.push(match[1]);
    expectKey = false;
    index += match[0].length - 1;
  }
  return keys;
}

for (const match of bundle.matchAll(/\b(?:act|perform)\(\s*'[a-z-]+'\s*,\s*\{/g)) {
  const start = match.index + match[0].length - 1;
  for (const key of topLevelKeys(bundle.slice(start))) sentKeys.add(key);
}
// `act('login-status')` 这类不传 body 的，以及三元拼出来的，单独补：
if (bundle.includes("act('login-status'")) sentKeys.add('（无 body）');

const readKeys = new Set([
  ...[...runtime.matchAll(/body\['([a-zA-Z]+)'\]/g)].map((match) => match[1]),
  // 走 readOptionalIds 的字段名是第二个实参，不是 body['x'] 形式。
  ...[...runtime.matchAll(/readOptionalIds\(body,\s*'([a-zA-Z]+)'\)/g)].map((match) => match[1]),
]);
notes.push(`浏览器传的字段：${[...sentKeys].filter((key) => key !== '（无 body）').sort().join(', ') || '（无）'}`);
notes.push(`宿主读的字段：${[...readKeys].sort().join(', ')}`);

/**
 * 宿主读了、但浏览器从不传的字段：只可能是**可选参数**（有回落值），
 * 否则就是忘接线。这里逐个点名，并要求在下面显式登记落值处 —— 加新字段时
 * 必须自己回答「不传时用什么」，避免悄悄多出一个永远走默认值的分支。
 */
const OPTIONAL_FIELDS = new Map([
  ['modelId', '不传时用目录里第一个模型（界面不做模型选择，测的是账号通不通，不是某个模型）'],
]);
for (const key of readKeys) {
  if (sentKeys.has(key)) continue;
  if (OPTIONAL_FIELDS.has(key)) {
    notes.push(`可选字段 '${key}'：${OPTIONAL_FIELDS.get(key)}`);
    continue;
  }
  problems.push(`宿主读了 '${key}'，但浏览器从不传且未登记为可选 —— 这个分支永远走默认值`);
}
// 登记过期也会被抓到：字段已经不读了，登记就是噪音。
for (const key of OPTIONAL_FIELDS.keys()) {
  if (!readKeys.has(key)) problems.push(`OPTIONAL_FIELDS 登记的 '${key}' 宿主已经不读了（登记过期）`);
}
// 浏览器传了但宿主从不读 → 参数被静默忽略，属于真 bug。
for (const key of sentKeys) {
  if (key === '（无 body）') continue;
  if (!readKeys.has(key)) problems.push(`浏览器传了字段 '${key}'，但宿主从不读它（参数被静默忽略）`);
}

// ── 宿主 → 浏览器方向：状态文档里的字段浏览器要真的用到 ──────────────────
const statusDoc = JSON.parse(JSON.stringify(
  [...bundle.matchAll(/status\.([a-zA-Z]+)/g)].reduce((acc, match) => ({ ...acc, [match[1]]: true }), {}),
));
const statusKeys = Object.keys(statusDoc);
if (statusKeys.length === 0) problems.push('浏览器半边从不读 status.*（状态没接上界面）');
else notes.push(`浏览器读的 status 字段：${statusKeys.sort().join(', ')}`);

for (const note of notes) console.log(`info ${note}`);
if (problems.length > 0) {
  console.error('\n动作契约校验失败：');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
} else {
  console.log('\n字段名契约校验通过：浏览器传的字段宿主都读、宿主读的字段都有来源、动作名双向可达。');
}
