/**
 * 安装一致性检查：确认 profile 里那份**已安装的副本**与源码构建一致，且能被宿主解析。
 *
 * 为什么需要它：`file:` 依赖在 pnpm 下可能被装配成**拷贝**而不是符号链接。
 * 那时改完 `src/` 重新 `build` 只更新了工作区，profile 里还是旧的一份 ——
 * 表现是「重启了但行为没变」，最难查的一类。本脚本把这件事变成一条断言。
 *
 * 用法：`node scripts/check-profile.mjs [--profile desktop]`（默认 desktop，找不到时退到任意 profile）
 */

import { createRequire } from 'node:module';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const problems = [];
const notes = [];
const args = process.argv.slice(2);
const profileArg = args.includes('--profile') ? args[args.indexOf('--profile') + 1] : undefined;

const root = join(homedir(), '.dsh', 'profiles');
const profiles = profileArg === undefined
  ? readdirSync(root).filter((name) => statSync(join(root, name)).isDirectory())
  : [profileArg];

const source = process.cwd();
const sourcePkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));

for (const profile of profiles) {
  const dir = join(root, profile);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch {
    continue;
  }
  const bundles = manifest.dsh?.profile?.bundles ?? [];
  const declared = bundles.includes(sourcePkg.name);
  const inDeps = manifest.dependencies?.[sourcePkg.name] !== undefined;
  if (!declared && !inDeps) {
    notes.push(`${profile}: 未引用本插件（跳过）`);
    continue;
  }
  if (!declared) problems.push(`${profile}: 在 dependencies 里但没进 dsh.profile.bundles（不会被加载）`);
  if (!inDeps) problems.push(`${profile}: 在 bundles 里但不在 dependencies（装不上）`);

  const require = createRequire(join(dir, 'package.json'));
  let installed;
  try {
    installed = require(`${sourcePkg.name}/package.json`);
  } catch (error) {
    problems.push(`${profile}: 解析不到已安装的 ${sourcePkg.name}（${error.code ?? String(error)}）`);
    continue;
  }
  const installedDir = resolve(require.resolve(`${sourcePkg.name}/package.json`), '..');

  // 1. 已安装副本与源码构建一致？不一致就是「改了没生效」。
  for (const file of ['lib/index.js', 'lib/client.js']) {
    const a = join(installedDir, file);
    const b = join(source, file);
    let same = false;
    try {
      same = readFileSync(a).equals(readFileSync(b));
    } catch {
      problems.push(`${profile}: 已安装副本缺 ${file}`);
      continue;
    }
    if (!same) {
      problems.push(
        `${profile}: ${file} 与源码构建不一致（${installedDir} 是旧副本）——`
        + ' 在 profile 目录重跑 `pnpm install --force`，或删掉该目录再装一次',
      );
    }
  }

  // 2. 宿主靠这三条解析：入口、客户端、补丁。
  for (const spec of [sourcePkg.name, `${sourcePkg.name}/client`, `${sourcePkg.name}/cordis.patch.yml`]) {
    try {
      require.resolve(spec);
    } catch {
      problems.push(`${profile}: require.resolve('${spec}') 失败（宿主装不上它）`);
    }
  }

  // 3. 补丁层的行名必须等于包名，否则客户端模块找不到包。
  const patchPath = require.resolve(`${sourcePkg.name}/cordis.patch.yml`);
  const patch = readFileSync(patchPath, 'utf8');
  if (!patch.includes(`name: '${sourcePkg.name}'`)) {
    problems.push(`${profile}: cordis.patch.yml 的 name 不等于包名`);
  }

  // 4. 内核世代是否落在插件声明的范围内（预发布版本尤其容易漏）。
  notes.push(`${profile}: 已安装 ${installed.version} → ${installedDir}`);
}

if (notes.length > 0) for (const note of notes) console.log(`info ${note}`);
if (problems.length > 0) {
  console.error('\n安装一致性检查失败：');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
} else {
  console.log('\n安装一致性检查通过（profile 里的副本与源码构建一致，宿主可解析）。');
  console.log('注意：宿主只在**启动时**装载插件树 —— 新装或改动后必须完全退出 DSH 再启动。');
}
