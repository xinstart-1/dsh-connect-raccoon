/**
 * 宿主装载检查：宿主能不能真的 import 这个包、读到它的 `dsh` 声明。
 *
 * 「装上去才发现导不出 apply」是最贵的一类错误，因为它只发生在别人机器上。
 *
 * 用法：`node scripts/check-host.mjs`
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const problems = [];

// 1. 清单形状。
if (pkg.type !== 'module') problems.push('type 必须是 module');
if (pkg.main !== 'lib/index.js') problems.push(`main 应为 lib/index.js，实际 ${String(pkg.main)}`);
if (pkg.exports?.['./client'] !== './lib/client.js') problems.push('./client 必须导出 ./lib/client.js');
if (pkg.exports?.['./cordis.patch.yml'] !== './cordis.patch.yml') problems.push('缺少 ./cordis.patch.yml 导出');
if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') problems.push('dsh.bundle.patch 必须指向 ./cordis.patch.yml');
if (!Array.isArray(pkg.dsh?.client?.inject) || pkg.dsh.client.inject.length === 0) {
  problems.push('dsh.client.inject 为空：浏览器半边拿不到任何依赖');
}
if (pkg.dsh?.client?.platform !== 'web') problems.push('dsh.client.platform 必须是 web');

// 2. cordis.patch.yml 的行名必须等于包名（客户端模块靠它定位包）。
const patch = readFileSync('cordis.patch.yml', 'utf8');
if (!patch.includes(`name: '${pkg.name}'`)) problems.push(`cordis.patch.yml 的 name 必须等于包名 ${pkg.name}`);
if (!patch.includes(`id: ${pkg.name}`)) problems.push(`cordis.patch.yml 的 id 建议等于包名 ${pkg.name}`);

// 3. 真的 import 一次，看四件套是否齐全。
let module;
try {
  module = await import(pathToFileURL('lib/index.js').href);
} catch (error) {
  problems.push(`import lib/index.js 失败：${error instanceof Error ? error.message : String(error)}`);
}
if (module !== undefined) {
  if (module.default !== undefined) {
    problems.push('函数式插件不许有 default 导出（会让宿主丢掉 inject）');
  }
  if (typeof module.apply !== 'function') problems.push('缺少 apply 导出');
  if (typeof module.name !== 'string' || module.name === '') problems.push('缺少 name 导出');
  if (!Array.isArray(module.inject)) problems.push('缺少 inject 导出');
  if (module.name !== pkg.name) problems.push(`name 导出应等于包名：${String(module.name)}`);

  // 4. 浏览器半边也得能被经典脚本引擎解析。
  const client = readFileSync('lib/client.js', 'utf8');
  try {
    new Function(client);
  } catch (error) {
    problems.push(`lib/client.js 语法错误：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!client.includes('__ModuleLoader__')) problems.push('lib/client.js 没有通过 __ModuleLoader__ 注册');
}

if (problems.length > 0) {
  console.error('宿主装载检查失败：');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
} else {
  console.log(`ok   ${pkg.name} 可被宿主 import，四件套齐全，client.js 可解析`);
}
