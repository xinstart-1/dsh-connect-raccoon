/**
 * 客户端 bundle 的静态自检。
 *
 * 浏览器半边是**手写的经典脚本**、从不进打包器（进了会引入第二份 React），
 * 所以没有类型检查兜底。这个脚本补上最要紧的四类检查：
 *
 * 1. **能解析**：用 `new Function` 让引擎真的解析一遍（语法错立刻暴露）。
 * 2. **没有模块语法**：`import` / `export` 会让它不再是经典脚本，加载即失败。
 * 3. **引用的 i18n 键都存在**：`t('xxx')` 里写了不存在的键，界面会显示原始键名。
 * 4. **硬编码的宿主路径与包名与 `src/constants.ts` 逐字一致**：
 *    写错一个字符不会报错，只会让整个界面永远读不到状态（白屏）。
 *
 * 用法：`node scripts/check-client.mjs`
 */

import { readFileSync } from 'node:fs';

const CLIENT_PATH = 'src/client/bundle.js';
const CONSTANTS_PATH = 'src/constants.ts';

const source = readFileSync(CLIENT_PATH, 'utf8');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const problems = [];

// 1. 能解析。
try {
  new Function(source);
  console.log('ok   语法可解析');
} catch (error) {
  problems.push(`语法错误：${error instanceof Error ? error.message : String(error)}`);
}

// 2. 没有模块语法。只匹配行首：字符串与注释里的同名内容不该误报。
const moduleSyntax = [];
source.split(/\r?\n/).forEach((line, index) => {
  const trimmed = line.trim();
  if (/^(import|export)\s/.test(trimmed) || /^(import|export)\{/.test(trimmed)) {
    moduleSyntax.push(`${String(index + 1)}: ${trimmed.slice(0, 60)}`);
  }
});
if (moduleSyntax.length === 0) console.log('ok   没有 import/export');
else problems.push(`发现模块语法（必须改掉）：\n    ${moduleSyntax.join('\n    ')}`);

// 3. i18n 键齐全。字典是 `var zh = { ... }` / `var en = { ... }`。
function keysOf(dictName) {
  const start = source.indexOf(`var ${dictName} = {`);
  if (start === -1) return undefined;
  const end = source.indexOf('\n  };', start);
  if (end === -1) return undefined;
  const body = source.slice(start, end);
  const keys = new Set();
  for (const match of body.matchAll(/^\s{4}([A-Za-z_][\w]*):/gm)) keys.add(match[1]);
  return keys;
}

const zh = keysOf('zh');
const en = keysOf('en');
if (zh === undefined || en === undefined) {
  problems.push('找不到 zh / en 字典');
} else {
  console.log(`ok   zh 键 ${String(zh.size)} 个，en 键 ${String(en.size)} 个`);
  const onlyZh = [...zh].filter((key) => !en.has(key));
  const onlyEn = [...en].filter((key) => !zh.has(key));
  if (onlyZh.length === 0 && onlyEn.length === 0) console.log('ok   zh 与 en 键一致');
  else {
    if (onlyZh.length > 0) problems.push(`只有 zh 有：${onlyZh.join(', ')}`);
    if (onlyEn.length > 0) problems.push(`只有 en 有：${onlyEn.join(', ')}`);
  }

  const used = new Set();
  for (const match of source.matchAll(/\bt\('([A-Za-z_][\w]*)'/g)) used.add(match[1]);
  const missing = [...used].filter((key) => !zh.has(key) || !en.has(key));
  if (missing.length === 0) console.log(`ok   用到的 ${String(used.size)} 个 i18n 键都存在`);
  else problems.push(`t() 引用了不存在的键：${missing.join(', ')}`);

  const unused = [...zh].filter((key) => !used.has(key));
  if (unused.length > 0) console.log(`note ${String(unused.length)} 个键未被 t() 引用：${unused.slice(0, 12).join(', ')}${unused.length > 12 ? ' …' : ''}`);
}

// 4. 关键契约：bundle id 必须是包名，且通过宿主的模块加载器注册。
//    两种写法都合法：`__ModuleLoader__.load({…})` 直调，或先取 `globalThis.__ModuleLoader__`
//    再 `loader.load({…})`（后者便于在加载器缺席时干净退出）。
const hasLoader =
  source.includes('__ModuleLoader__.load') ||
  (/__ModuleLoader__/.test(source) && /\bloader\.load\s*\(/.test(source));
if (!hasLoader) problems.push('没有通过 __ModuleLoader__ 注册（宿主不会加载这个 bundle）');
else console.log('ok   通过 __ModuleLoader__ 注册');
if (!source.includes(`'${pkg.name}'`)) problems.push(`没有出现包名 '${pkg.name}'`);
else console.log(`ok   出现包名 ${pkg.name}`);

// 5. 宿主路径逐字一致：从 constants.ts 抽值，再在 bundle 里找同名常量。
const constants = readFileSync(CONSTANTS_PATH, 'utf8');
for (const key of ['STATUS_PATH', 'ACTION_PATH']) {
  const match = new RegExp(`export const ${key} = '([^']+)'`).exec(constants);
  if (match === null) {
    problems.push(`src/constants.ts 里找不到 ${key}`);
    continue;
  }
  const expected = match[1];
  if (source.includes(expected)) console.log(`ok   ${key} 与宿主一致（${expected}）`);
  else problems.push(`bundle 里没有宿主路径 ${expected}`);
}

// 6. 令牌字段绝不该出现在浏览器半边。
const leaked = [...source.matchAll(/\b(accessToken|refreshToken|access_token|refresh_token)\b/g)].length;
if (leaked === 0) console.log('ok   bundle 里没有令牌字段');
else problems.push(`bundle 里出现令牌字段 ${String(leaked)} 处（必须删掉）`);

if (problems.length > 0) {
  console.error('\n发现问题：');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
} else {
  console.log('\n客户端 bundle 自检全部通过。');
}
