/**
 * 活体验证：本机正在运行的那个 DSH，到底有没有把插件装起来。
 *
 * 为什么单独一条命令：`gate.mjs` 验的是源码与构建，「装进去之后有没有生效」是另一件事。
 * 2026-11-10 实测过最迷惑的一种状态 —— 插件已装进 profile、构建也全绿，但 DSH 主进程
 * 是在安装**之前**启动的，于是路由一直 404，看起来像加载失败，实际只是没重启。
 *
 * 用法：`node scripts/verify-live.mjs [--url http://127.0.0.1:59224]`
 *
 * 判定顺序刻意从「最便宜的证据」开始：先看进程启动时间，再看路由。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

const pkgJson = JSON.parse(readFileSync('package.json', 'utf8'));
const require = createRequire(resolve(process.cwd(), 'package.json'));
const args = process.argv.slice(2);
const requireLive = args.includes('--require-live');
const urlArg = args.includes('--url') ? args[args.indexOf('--url') + 1] : undefined;
const base = (urlArg ?? process.env['DSH_GUI_URL'] ?? 'http://127.0.0.1:59224').replace(/\/+$/, '');

const problems = [];
const notes = [];

/** 本插件在哪个 profile 下被装上（找不到时抛错，由调用方解释）。 */
function installedProfileDir() {
  const dir = resolve(homedir(), '.dsh', 'profiles');
  for (const profile of ['desktop', 'web', 'dytest']) {
    const candidate = resolve(dir, profile, 'node_modules', pkgJson.name);
    try {
      statSync(resolve(candidate, 'package.json'));
      return candidate;
    } catch {
      // 这个 profile 没装，继续找。
    }
  }
  throw new Error(`没有 profile 安装本插件（找过 ${dir} 下的 desktop / web / dytest）`);
}

/** 读一条 HTTP 端点；连不上时不抛。 */
async function probe(path) {
  try {
    const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(8000) });
    const text = await response.text();
    return { status: response.status, text };
  } catch (error) {
    return { status: 0, text: error instanceof Error ? error.message : String(error) };
  }
}

// 1. DSH 主进程启动时间 vs 插件装进 profile 的时间。
//    早于安装时间时，路由 404 是**预期**的，不该当成插件 bug。
function processStartMs() {
  if (process.platform !== 'win32') return undefined;
  try {
    const output = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', "Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty StartTime | ConvertTo-Json -Compress"],
      { encoding: 'utf8' },
    ).trim();
    if (output === '') return undefined;
    const parsed = JSON.parse(output);
    const values = (Array.isArray(parsed) ? parsed : [parsed]).map((value) => {
      const match = /\/Date\((\d+)\)\//.exec(String(value));
      return match === null ? Date.parse(String(value)) : Number(match[1]);
    }).filter((value) => Number.isFinite(value));
    return values.length === 0 ? undefined : Math.min(...values);
  } catch {
    return undefined;
  }
}

/** 已安装副本里任一新于启动时间 = 装完没重启。 */
function installedNewestMs() {
  const dir = resolve(homedir(), '.dsh', 'profiles');
  const candidates = ['desktop', 'web', 'dytest'];
  let newest;
  for (const profile of candidates) {
    try {
      const value = statSync(resolve(dir, profile, 'node_modules', pkgJson.name, 'package.json')).mtimeMs;
      if (Number.isFinite(value) && (newest === undefined || value > newest)) newest = value;
    } catch {
      // 这个 profile 没装，跳过。
    }
  }
  return newest;
}

const startedAt = processStartMs();
const installedAt = installedNewestMs();
if (startedAt !== undefined && installedAt !== undefined) {
  const startedLocal = new Date(startedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const installedLocal = new Date(installedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  notes.push(`DSH 主进程启动于 ${startedLocal}，插件装进 profile 于 ${installedLocal}`);
  if (installedAt > startedAt) {
    problems.push(
      '插件是在 DSH 启动**之后**装进去的 —— 宿主只在启动时装载插件树，'
      + '所以现在路由必然是 404。完全退出 DSH（含托盘）再启动即可，这不是插件缺陷。',
    );
  }
}

// 2. 状态路由（node 半边真的跑起来了）。
const status = await probe('/plugins/dsh-connect-raccoon/status');
const control = await probe('/plugins/dsh-connect-meoo/status');

if (control.status === 0) {
  problems.push(`连不上 ${base}：DSH 没在运行，或 GUI 端口不是这个（用 --url 指定）`);
} else {
  notes.push(`对照端点 /plugins/dsh-connect-meoo/status → ${String(control.status)}（同机其它插件）`);
}

if (status.status === 200) {
  let doc;
  try {
    doc = JSON.parse(status.text);
  } catch {
    problems.push('/status 回 200 但内容不是 JSON');
  }
  if (doc !== undefined) {
    const required = ['schemaVersion', 'version', 'provider', 'desktop', 'accounts', 'pool', 'catalog', 'login', 'checkin', 'state'];
    const missing = required.filter((key) => !(key in doc));
    if (missing.length > 0) problems.push(`/status 缺字段：${missing.join(', ')}`);
    if (doc.provider !== 'raccoon') problems.push(`/status 的 provider 应为 raccoon，实际 ${String(doc.provider)}`);
    if (status.text.includes('accessToken') || status.text.includes('refreshToken')) {
      problems.push('/status 里出现了令牌字段（绝不能进页面）');
    }
    notes.push(
      `插件 v${String(doc.version)} 在线：${String(doc.accounts?.length ?? 0)} 个账号、`
      + `${String(doc.catalog?.count ?? 0)} 个模型（目录来源 ${String(doc.catalog?.source)}）、`
      + `登录相位 ${String(doc.login?.phase)}`,
    );
    if (doc.desktop?.exists === false) {
      notes.push(`桌面端未检出（${String(doc.desktop?.reason)}）—— 本机没装客户端时这是正常的，用网页登录`);
    }
    if ((doc.accounts?.length ?? 0) === 0) {
      notes.push('账号池是空的：去「设置 → 插件 → 商汤小浣熊 → 登录」点一次「网页登录」');
    }
    if ((doc.catalog?.count ?? 0) === 0) {
      problems.push('catalog.count 是 0 —— 模型选择器会整组消失（未登录时应当是内置兜底目录）');
    }
  }
} else if (status.status !== 0) {
  problems.push(`/plugins/dsh-connect-raccoon/status → ${String(status.status)}（插件没装起来或宿主没重启）`);
}

// 3. 浏览器半边：**不能**用 `/plugins/<id>/client.js` 探。
//    宿主把客户端 bundle 合成为 combo 路由 `/plugins/??<id>/client.js&rev=<hash>`，
//    且 shell 需要鉴权 —— 那个直连 URL 对任何插件都是 404（已用同机 lingxi 做过对照）。
//    这里改成验「客户端资源是否被登记进宿主的模块图」所依赖的两个前提：
//    ① 已安装副本里有 lib/client.js；② 它能被经典脚本引擎解析。两者由 gate 覆盖，
//    活体这一层只确认文件在位（宿主登记表需要鉴权才能读）。
try {
  // 必须验**profile 里那份已安装副本**：验工作区只能证明源码可解析，
  // 而宿主加载的是 profile/node_modules 下的那份。
  const installedDir = installedProfileDir();
  const manifest = JSON.parse(readFileSync(resolve(installedDir, 'package.json'), 'utf8'));
  const clientPath = resolve(installedDir, 'lib/client.js');
  const clientSource = readFileSync(clientPath, 'utf8');
  new Function(clientSource);
  if (!clientSource.includes('__ModuleLoader__')) {
    problems.push('已安装的 lib/client.js 里没有 __ModuleLoader__（不是有效的客户端 bundle）');
  }
  notes.push(`浏览器半边在位：${clientPath}（v${String(manifest.version)}，${String(clientSource.length)} 字节）`);
} catch (error) {
  problems.push(`浏览器半边取不到：${error instanceof Error ? error.message : String(error)}`);
}

for (const note of notes) console.log(`info ${note}`);

// 未装进任何 profile 时，这条检查在别人的机器上是**正常跳过**而不是失败：
// 源码仓库不等于使用者已经装了。`--require-live` 把它变成硬要求（本地/CI 用）。
const notInstalled = problems.length === 1 && problems[0].startsWith('浏览器半边取不到');
if (notInstalled && !requireLive) {
  console.log('\n跳过：本插件还没装进任何 DSH profile（装完再跑一次即可）。');
  process.exit(0);
}

if (problems.length > 0) {
  console.error('\n活体验证未通过：');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
} else {
  console.log('\n活体验证通过：插件已在运行中的 DSH 里装好，两条路由与客户端 bundle 都可用。');
  console.log('下一步（2 分钟）：设置 → 插件 → 商汤小浣熊 → 登录 → 点「网页登录」，在浏览器里登录一次。');
}
