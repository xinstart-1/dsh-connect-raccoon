/**
 * 打包检查：`files` 白名单漏一个目录 = 本地全绿、装的人拿到一个没界面的包。
 *
 * 本机 PATH 上没有 npm，所以这里按 npm 的规则自己算一遍清单（`files` 里的目录
 * 递归、文件精确匹配，外加始终包含的 `package.json` / `README` / `LICENSE`），
 * 再对结果做正向与反向断言。算错的可能只有「白名单写法」，所以另有一条断言：
 * `files` 里每一项在磁盘上都必须真实存在。
 *
 * 用法：`node scripts/check-pack.mjs`
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

/** 递归列出目录下的文件（相对路径，用 `/` 分隔）。 */
function walk(root, prefix = '') {
  const out = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(root, rel));
    else out.push(rel);
  }
  return out;
}

const problems = [];
const files = Array.isArray(pkg.files) ? pkg.files : [];
if (files.length === 0) problems.push('package.json 没有 files 白名单（会把 src/docs/test 一起发出去）');

/** 白名单条目对应的实际文件。 */
const listed = new Set(['package.json']);
for (const entry of files) {
  const cleaned = entry.replace(/^\.\//, '').replace(/\/$/, '');
  let info;
  try {
    info = statSync(cleaned);
  } catch {
    problems.push(`files 里的条目在磁盘上不存在：${entry}`);
    continue;
  }
  if (info.isDirectory()) {
    for (const file of walk(cleaned)) listed.add(posix.join(cleaned, file));
  } else {
    listed.add(cleaned);
  }
}
// 这三个 npm 始终包含（存在时）。
for (const auto of ['README.md', 'LICENSE', 'README.en.md']) {
  try {
    statSync(auto);
    listed.add(auto);
  } catch {
    // 不存在就不加。
  }
}

const REQUIRED = ['lib/index.js', 'lib/index.d.ts', 'lib/client.js', 'cordis.patch.yml', 'package.json'];
const missing = REQUIRED.filter((file) => !listed.has(file));
if (missing.length > 0) problems.push(`打包缺文件：${missing.join(', ')}`);

const FORBIDDEN = ['src/', 'test/', 'docs/', 'scripts/', 'tools/', 'node_modules/'];
const leaked = FORBIDDEN.filter((prefix) => [...listed].some((file) => file.startsWith(prefix)));
if (leaked.length > 0) problems.push(`包里混进了不该发的路径：${leaked.join(', ')}`);

// `lib/` 下不许有 source map：它们会把源码路径泄露进包，也让包变大。
const maps = [...listed].filter((file) => file.startsWith('lib/') && file.endsWith('.map'));
if (maps.length > 0) problems.push(`lib/ 下有 source map：${maps.join(', ')}`);

if (problems.length > 0) {
  console.error('打包检查失败：');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
} else {
  console.log(`ok   pack 将含 ${String(listed.size)} 个文件，必需项齐全，未混入源码/测试/文档`);
  console.log(`ok   包名 ${pkg.name}@${pkg.version}`);
}
