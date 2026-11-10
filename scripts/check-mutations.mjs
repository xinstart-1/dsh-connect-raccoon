/**
 * 变异测试：故意改坏源码里的**关键不变量**，看测试能不能抓到。
 *
 * 为什么需要它：「测试一直绿」有两种可能 —— 代码是对的，或者测试根本没测到。
 * 常规覆盖率分不出这两者（覆盖到不代表断言到）。这个脚本每次改坏一处、
 * 只跑相关的那一个测试文件，存活（测试仍绿）就说明那条不变量没有防线。
 *
 * 当前守的 5 条不变量：
 * 1. 续期单飞 —— 并发重复刷新会因 refresh token 单次使用而把账号打死；
 * 2. 400/404 不换号 —— 同一请求体换谁都是错，换号只是白等；
 * 3. 未来版本状态文件必须拒绝 —— 否则按旧格式解读并写回，会覆盖用户真实设置；
 * 4. 池过滤不可用账号 —— 混进换号序列会在已知不可用的账号上白等一次超时；
 * 5. SSE 流内错误帧识别 —— 认不出就既不记冷却也不告警（"静默失败"）。
 *
 * **已知接受项**（脚本里注释掉了，附理由）：`rank` 的可用性分支当前不可达；
 * 凭据文件 mode 在 Windows 上被忽略。
 *
 * 用法：`node scripts/check-mutations.mjs`（改坏的源码一定会还原，即使中途失败）
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const MUTATIONS = [
  // 已接受：rank 的可用性分支当前不可达（两个调用方都先 filter），
  // 保留它是有意的契约（见 pool.ts 注释）。因此这个变异「存活」是预期的。
  // ['pool 可用性排序', ...],
  ['续期单飞', 'src/credentials/refresh.ts', 'const existing = inflight.get(account.accountKey);', 'const existing = undefined;', 'test/refresh.test.ts', '并发重复刷新会把账号打死'],
  ['换号不换 400', 'src/shim/server.ts', 'if (response.status === 400 || response.status === 404) {', 'if (false) {', 'test/shim.test.ts', '400 也换号（白等）'],
  // 已接受：Windows 忽略 POSIX mode（实测落盘恒为 666），该测试在 Windows 上
  // 明确 skip。权限验证需在 Unix 上做 —— 见 docs/VERIFY.md。
  // ['凭据文件权限', ...],
  ['未来版本守卫', 'src/state.ts', 'version > STATE_SCHEMA_VERSION', 'version > 99', 'test/state.test.ts', '未来版本被当成当前格式解读'],
  ['池过滤不可用', 'src/host/pool.ts', 'input.candidates.filter((candidate) => candidate.inPool && candidate.usable)', 'input.candidates.filter((candidate) => candidate.inPool)', 'test/pool.test.ts', '不可用账号混进换号序列'],
  ['SSE 错误帧识别', 'src/protocol/sse.ts', "const nested = record['error'];", "const nested = undefined;", 'test/sse.test.ts', '流内限流帧认不出来'],
];

let killed = 0;
let survived = 0;
for (const [name, file, from, to, testFile, why] of MUTATIONS) {
  const original = readFileSync(file, 'utf8');
  if (!original.includes(from)) { console.log(`SKIP     ${name}（找不到变异点）`); continue; }
  writeFileSync(file, original.replace(from, to), 'utf8');
  try {
    execFileSync(process.execPath, ['--experimental-strip-types', '--test', '--test-timeout=15000', testFile], { stdio: 'pipe', timeout: 60_000 });
    console.log(`SURVIVED ${name}：${why} —— ${testFile} 没抓到`);
    survived += 1;
  } catch {
    console.log(`KILLED   ${name}：${why}`);
    killed += 1;
  } finally {
    writeFileSync(file, original, 'utf8');
  }
}
console.log(`\n结果：${killed} 抓到 / ${survived} 漏网`);
process.exit(survived === 0 ? 0 : 1);
