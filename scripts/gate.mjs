/**
 * 一条命令跑完全部校验。
 *
 * 存在的理由：在这个 Windows 终端里手敲多条 `|` / `&` 组合容易被 PowerShell
 * 与 cmd 的引号规则打架，写进脚本就只剩一次调用。
 *
 * 用法：`node scripts/gate.mjs`（任何一项失败即以非 0 退出）
 */

import { spawnSync } from 'node:child_process';

const steps = [
  // 版本号两处必须一致，否则「用户报的 bug 对应哪个构建」无法定位。
  ['check-version', [process.execPath, 'scripts/check-version.mjs']],
  ['typecheck', [process.execPath, 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json']],
  ['build', [process.execPath, 'node_modules/tsdown/dist/run.mjs']],
  ['copy-client', [process.execPath, 'scripts/copy-client.mjs']],  // 浏览器半边没有类型检查兜底：语法 / 无模块语法 / i18n 键 / 宿主路径逐字一致 / 无令牌字段。
  ['check-client', [process.execPath, 'scripts/check-client.mjs']],
  // 文档里承诺的功能必须在代码里真的存在。
  ['check-doc-contract', [process.execPath, 'scripts/check-doc-contract.mjs']],
  // 宿主能不能真的 import 这个包、client.js 能不能解析。
  ['check-host', [process.execPath, 'scripts/check-host.mjs']],
  // files 白名单漏一个目录 = 本地全绿、装的人拿到一个没界面的包。
  ['check-pack', [process.execPath, 'scripts/check-pack.mjs']],
  ['tests', [process.execPath, 'scripts/test-report.mjs']],
  // 浏览器半边的组件真的能被渲染（不是只有语法对）：整页拼起来还长这样。
  ['preview-ui', [process.execPath, 'scripts/preview-ui.mjs', '--check']],
  // 单测覆盖各层，但没有一处证明 apply() 真的把它们接起来了。
  ['smoke-apply', [process.execPath, 'scripts/smoke-apply.mjs']],
  // 用真的 Cordis Context 装载一次：假 ctx 验不出「Cordis 接不接受这套装配」。
  ['check-cordis', [process.execPath, 'scripts/check-cordis.mjs']],
  // profile 里那份**已安装副本**与源码构建是否一致（file: 依赖可能是拷贝而不是链接）。
  ['check-profile', [process.execPath, 'scripts/check-profile.mjs']],
];

const failures = [];
for (const [name, command] of steps) {
  const result = spawnSync(command[0], command.slice(1), {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  const ok = result.status === 0;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) {
    failures.push(name);
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    if (output !== '') console.log(output.split(/\r?\n/).slice(-20).join('\n'));
  }
}

console.log('');
if (failures.length === 0) {
  console.log(`全部通过：${steps.map(([name]) => name).join(' / ')}`);
} else {
  console.error(`失败项：${failures.join(', ')}`);
  process.exitCode = 1;
}
