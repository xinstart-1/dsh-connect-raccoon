/**
 * 逐文件跑测试并落地报告，比一次性跑全量更容易定位与对比。
 *
 * 用法：`node scripts/test-report.mjs`（任一测试文件失败即非 0 退出）
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';

const files = readdirSync('test')
  .filter((name) => name.endsWith('.test.ts'))
  .sort()
  .map((name) => `test/${name}`);

if (files.length === 0) {
  console.error('test/ 下没有任何 *.test.ts');
  process.exit(1);
}

const lines = [];
let failed = 0;
for (const file of files) {
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--test', file],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: process.env },
  );
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const pass = /^# pass (\d+)/m.exec(output) ?? /ℹ pass (\d+)/.exec(output);
  const fail = /^# fail (\d+)/m.exec(output) ?? /ℹ fail (\d+)/.exec(output);
  const ok = result.status === 0;
  if (!ok) failed += 1;
  const summary = `${ok ? 'ok  ' : 'FAIL'} ${file}  pass=${pass?.[1] ?? '?'} fail=${fail?.[1] ?? '?'}`;
  console.log(summary);
  lines.push(summary);
  if (!ok) lines.push(output.split(/\r?\n/).slice(-40).join('\n'));
}

writeFileSync('test-report.txt', `${lines.join('\n')}\n`, 'utf8');
if (failed > 0) {
  console.error(`\n${String(failed)} 个测试文件失败（详见 test-report.txt）`);
  process.exitCode = 1;
} else {
  console.log(`\n${String(files.length)} 个测试文件全部通过（报告：test-report.txt）`);
}
