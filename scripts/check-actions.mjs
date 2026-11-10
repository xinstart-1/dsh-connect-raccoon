/**
 * 动作契约的双向校验：浏览器半边**调用的**与宿主**实现的**必须一一对上。
 *
 * 为什么需要它：这两半之间只有一个 JSON 边界，没有类型检查、没有编译期校验。
 * 拼错一个选项名（`accountId` 写成 `account_id`）在两端各自都「语法正确」，
 * 只有用户点下按钮的那一刻才会炸，而这恰恰是最难在开发时发现的一类。
 *
 * 三个方向都查：
 * 1. **宿主实现的每个动作，浏览器都要么调用、要么明确登记为「仅 API」** ——
 *    否则就是死代码（`logout` 曾是这样，已删除）。
 * 2. **浏览器调用的每个动作，宿主都必须实现** —— 否则点下去就是 unknown-action。
 * 3. **浏览器传的字段名，宿主必须真的读** —— 否则参数被静默忽略。
 *    反向也查：宿主读的字段，浏览器至少要在某个动作里传过（防止忘接线）。
 *
 * 用法：`node scripts/check-actions.mjs`
 */

import { readFileSync } from 'node:fs';

/**
 * 只在 API 上存在、界面上刻意不提供的动作，附理由。**空集合是目标状态。**
 *
 * 曾有 `logout` 在这里登记过 —— 后来发现它和 `remove-account` 实现完全一样，
 * 是重复出口，直接删掉比留个例外更干净。
 */
const API_ONLY = new Map();

const problems = [];
const notes = [];

const bundle = readFileSync('src/client/bundle.js', 'utf8');
const routes = readFileSync('src/host/routes.ts', 'utf8');
const runtime = readFileSync('src/host/runtime.ts', 'utf8');

// ── 宿主侧：类型联合 + ACTIONS 白名单 + switch 分支，三者必须一致 ──────────
const unionBlock = /export type RaccoonAction =([\s\S]*?);/.exec(routes);
if (unionBlock === null) {
  console.error('找不到 RaccoonAction 类型联合');
  process.exit(1);
}
const declared = [...unionBlock[1].matchAll(/'([a-z-]+)'/g)].map((match) => match[1]);

const actionsBlock = /export const ACTIONS[^=]*=\s*\[([\s\S]*?)\]/.exec(routes);
if (actionsBlock === null) {
  console.error('找不到 ACTIONS 白名单');
  process.exit(1);
}
const whitelisted = [...actionsBlock[1].matchAll(/'([a-z-]+)'/g)].map((match) => match[1]);

/**
 * 只取**动作分发**那个 switch 的分支。
 *
 * 直接扫全文 `case '...'` 会把别的 switch（例如 `desktopHint` 里按原因码分派）
 * 也算进来 —— 那种误报会让人以为少写了动作。
 */
function implementedActions(source) {
  const start = source.indexOf('switch (action)');
  if (start < 0) return [];
  // 从 switch 起点做花括号配平，切出这个块。
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
const implemented = implementedActions(runtime);

const sameSet = (left, right, label) => {
  const onlyLeft = left.filter((item) => !right.includes(item));
  const onlyRight = right.filter((item) => !left.includes(item));
  if (onlyLeft.length > 0) problems.push(`${label}：只在左边有 ${onlyLeft.join(', ')}`);
  if (onlyRight.length > 0) problems.push(`${label}：只在右边有 ${onlyRight.join(', ')}`);
};
sameSet(declared, whitelisted, 'RaccoonAction 类型 vs ACTIONS 白名单');
sameSet(declared, implemented, 'RaccoonAction 类型 vs runtime switch 分支');
notes.push(`宿主声明 ${String(declared.length)} 个动作`);

// ── 浏览器侧：`act('x'` 与 `perform('x'` 两种调用形式 ─────────────────────
const called = new Set();
for (const match of bundle.matchAll(/\b(?:act|perform)\(\s*'([a-z-]+)'/g)) called.add(match[1]);
// 三元表达式里的动作名（如 login-qr / login-web）也要算上。
for (const match of bundle.matchAll(/kind === 'qr' \? '([a-z-]+)' : '([a-z-]+)'/g)) {
  called.add(match[1]);
  called.add(match[2]);
}
const calledList = [...called].sort();
notes.push(`浏览器调用 ${String(calledList.length)} 个动作`);

// 1. 宿主有、浏览器没调 → 死代码，必须登记理由。
for (const action of declared) {
  if (called.has(action)) continue;
  if (API_ONLY.has(action)) continue;
  problems.push(`宿主实现了 '${action}'，但浏览器从不调用（死代码）—— 要么接上界面，要么在 API_ONLY 里写明理由`);
}
// 2. 浏览器调、宿主没实现 → 点下去就 unknown-action。
for (const action of calledList) {
  if (!whitelisted.includes(action)) problems.push(`浏览器调用 '${action}'，但宿主 ACTIONS 白名单里没有它`);
  if (!implemented.includes(action)) problems.push(`浏览器调用 '${action}'，但 runtime 没有对应分支`);
}
// 3. API_ONLY 里登记的动作必须真的存在（否则登记本身就是过期的）。
for (const action of API_ONLY.keys()) {
  if (!declared.includes(action)) problems.push(`API_ONLY 登记的 '${action}' 在宿主上不存在（登记过期了）`);
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
  console.log('\n动作契约校验通过：宿主实现与浏览器调用在动作名与字段名上双向一致。');
}
