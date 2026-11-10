/**
 * 文档契约检查：CONTRACT 里承诺的东西必须在代码里真实存在。
 *
 * 上一类事故是「文档写着、代码没有」：用户按文档点按钮，没有任何反应也不报错。
 * 这里只校验**可以机械验证**的那部分承诺：动作名、登录相位、两条路由路径。
 *
 * 用法：`node scripts/check-doc-contract.mjs`
 */

import { readFileSync } from 'node:fs';

const contract = readFileSync('docs/CONTRACT.md', 'utf8');
const routes = readFileSync('src/host/routes.ts', 'utf8');
const login = readFileSync('src/host/login.ts', 'utf8');
const constants = readFileSync('src/constants.ts', 'utf8');
const problems = [];

/** 取出 CONTRACT 里某个二级标题下的内容（到下一个二级标题为止）。 */
function section(title) {
  const start = contract.indexOf(`## ${title}`);
  if (start === -1) return undefined;
  const next = contract.indexOf('\n## ', start + 3);
  return next === -1 ? contract.slice(start) : contract.slice(start, next);
}

// 1. 动作白名单：代码里的 ACTIONS 与 CONTRACT §三 的表格必须逐个对应。
const actionSection = section('三、动作白名单');
if (actionSection === undefined) problems.push('CONTRACT 里找不到「## 三、动作白名单」');
const documentedActions = new Set(
  [...(actionSection ?? '').matchAll(/^\| `([a-z][a-z-]+)` \|/gm)].map((match) => match[1]),
);
const actionsBlock = /export const ACTIONS: readonly RaccoonAction\[\] = \[([\s\S]*?)\];/.exec(routes);
if (actionsBlock === null) {
  problems.push('src/host/routes.ts 里找不到 ACTIONS 白名单');
} else {
  const implemented = new Set([...actionsBlock[1].matchAll(/'([a-z][a-z-]+)'/g)].map((match) => match[1]));
  const missing = [...documentedActions].filter((action) => !implemented.has(action));
  const extra = [...implemented].filter((action) => !documentedActions.has(action));
  if (missing.length > 0) problems.push(`CONTRACT 里写了但代码里没有的动作：${missing.join(', ')}`);
  if (extra.length > 0) problems.push(`代码里有但 CONTRACT 没写的动作：${extra.join(', ')}`);
  console.log(`ok   动作 ${String(implemented.size)} 个，与 CONTRACT 一致`);
}

// 2. 登录相位：CONTRACT §四 的表格与 LoginPhase 联合必须逐个对应。
const phaseSection = section('四、登录会话的六个相位');
const documentedPhases = new Set(
  [...(phaseSection ?? '').matchAll(/^\| `([a-z]+)` \|/gm)].map((match) => match[1]),
);
const phaseBlock = /export type LoginPhase =\s*([\s\S]*?);/.exec(login);
if (phaseBlock === null) {
  problems.push('src/host/login.ts 里找不到 LoginPhase');
} else {
  const implemented = new Set([...phaseBlock[1].matchAll(/'([a-z]+)'/g)].map((match) => match[1]));
  const missing = [...documentedPhases].filter((phase) => !implemented.has(phase));
  const extra = [...implemented].filter((phase) => !documentedPhases.has(phase));
  if (missing.length > 0) problems.push(`CONTRACT 里写了但 LoginPhase 没有：${missing.join(', ')}`);
  if (extra.length > 0) problems.push(`LoginPhase 有但 CONTRACT 没写：${extra.join(', ')}`);
  console.log(`ok   登录相位 ${String(implemented.size)} 个，与 CONTRACT 一致`);
}

// 3. 两条路由路径必须与 constants.ts 逐字一致。
for (const key of ['STATUS_PATH', 'ACTION_PATH']) {
  const value = new RegExp(`export const ${key} = '([^']+)'`).exec(constants)?.[1];
  if (value === undefined) problems.push(`constants.ts 缺 ${key}`);
  else if (!contract.includes(value)) problems.push(`CONTRACT 里没写 ${key} 的实际值 ${value}`);
  else console.log(`ok   ${key} 与 CONTRACT 一致（${value}）`);
}

// 4. 契约里声明「浏览器侧硬编码」的四个字符串，必须真的出现在浏览器半边。
const client = readFileSync('src/client/bundle.js', 'utf8');
const hardcoded = section('六、浏览器侧硬编码常量') ?? '';
for (const match of hardcoded.matchAll(/var (\w+) = '([^']+)';/g)) {
  const [, , value] = match;
  if (!client.includes(`'${value}'`)) problems.push(`CONTRACT 声明浏览器侧硬编码 ${value}，但 bundle 里没有`);
}
console.log('ok   CONTRACT 声明的浏览器侧常量都在 bundle 里');

if (problems.length > 0) {
  console.error('\n文档契约检查失败：');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
} else {
  console.log('\n文档契约检查全部通过。');
}
