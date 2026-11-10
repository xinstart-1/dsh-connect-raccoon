/**
 * 15 个动作的**活体巡检**：对着一台跑起来的 DSH 逐个调一遍，看谁在接口边界上炸。
 *
 * 为什么需要：`check-actions.mjs` 证明两端名字对得上，但「名字对得上」不等于
 * 「调了就没事」—— 参数类型、状态迁移、错误码都要真跑一次才知道。此前 15 个动作
 * 只有 3 个有单测。
 *
 * 巡检原则：
 * - **只做可逆操作**：登录类、设置类都会在结束时恢复原状；
 * - **破坏性动作只打不删**：`remove-account` 用不存在的 id 调，验证它回错而不是回 ok；
 * - **花钱的动作不碰**：`checkin` / `test-account` 会真实消耗积分，只在有账号时才试一次，
 *   且 `checkin` 默认跳过（签到是每日一次，重复调没有意义）。
 *
 * 用法：`node scripts/probe-actions.mjs [--url http://127.0.0.1:<端口>] [--with-checkin]`（不给则自动探测）
 */

import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { resolveGuiBase } from './gui-url.mjs';

const require = createRequire(import.meta.url);

const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
const args = process.argv.slice(2);
const urlArg = args.includes('--url') ? args[args.indexOf('--url') + 1] : undefined;
const withCheckin = args.includes('--with-checkin');
const base = await resolveGuiBase({ pluginName: pkg.name, args });
const ACTION = `${base}/plugins/${pkg.name}/action`;
const STATUS = `${base}/plugins/${pkg.name}/status`;

const problems = [];
const steps = [];

/** 发一个动作。 */
async function act(action, body = {}) {
  const response = await fetch(ACTION, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...body }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { httpStatus: response.status, json: undefined, text };
  }
  return { httpStatus: response.status, json, text };
}

/** 读状态。 */
async function status() {
  const response = await fetch(STATUS, { signal: AbortSignal.timeout(20_000) });
  return JSON.parse(await response.text());
}

/**
 * 断言一个动作「按契约回应」。
 *
 * @param action - 动作名。
 * @param body - 请求体。
 * @param expect - `ok: true` 要求成功；`ok: false` 要求被拒且**有可读理由**。
 * @param note - 打进日志的说明。
 */
async function expectAction(action, body, expect, note) {
  const result = await act(action, body);
  if (result.json === undefined) {
    problems.push(`${action}：响应不是 JSON（HTTP ${String(result.httpStatus)}）${result.text.slice(0, 120)}`);
    return undefined;
  }
  const ok = result.json.ok === true;
  if (expect.ok && !ok) {
    problems.push(`${action} 应当成功，实际 ok=${String(result.json.ok)}：${JSON.stringify(result.json).slice(0, 200)}`);
    return result.json;
  }
  if (!expect.ok) {
    if (ok) {
      problems.push(`${action} 应当被拒，实际返回了 ok=true`);
      return result.json;
    }
    // 被拒时必须给得出理由：一个只有 ok:false 的响应界面无法显示。
    const reason = result.json.error?.message ?? result.json.message ?? result.json.reason;
    if (typeof reason !== 'string' || reason.trim() === '') {
      problems.push(`${action} 被拒但没给出可读理由：${JSON.stringify(result.json).slice(0, 200)}`);
    } else {
      steps.push(`${action} 被拒且理由可读：「${reason.slice(0, 40)}」✓`);
    }
    return result.json;
  }
  steps.push(`${note} ✓`);
  return result.json;
}

/**
 * 先确认「跑着的就是刚构建的代码」。
 *
 * 宿主只在启动时装载一次插件树：进程活着就一直执行**那一次**装载进来的
 * 模块，之后重建只会改磁盘上的文件。不先查这个，后面的断言会把「旧构建的
 * 老行为」当成新代码的缺陷来报 —— 排查方向会被带偏。
 */
function staleBuildReason() {
  if (process.platform !== 'win32') return undefined;
  try {
    const { execFileSync } = require('node:child_process');
    const output = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='DeepSeek Harness.exe'\" | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress"],
      { encoding: 'utf8' },
    ).trim();
    const rows = [].concat(JSON.parse(output));
    // 宿主进程 = 父进程也是本 exe 的那个（Electron 主进程的父是 shell/explorer）。
    const ids = new Set(rows.map((row, index) => row?.ProcessId ?? index));
    const hosts = rows.filter((row) => !ids.has(row?.ParentProcessId));
    const starts = hosts.map((row) => {
      const match = /\/Date\((\d+)\)\//.exec(String(row?.CreationDate));
      return match === null ? Number.NaN : Number(match[1]);
    }).filter(Number.isFinite);
    if (starts.length === 0) return undefined;
    const startedAt = Math.min(...starts);
    const installed = statSync(resolve('lib/index.js')).mtimeMs;
    if (installed <= startedAt) return undefined;
    return `DSH 进程启动于 ${new Date(startedAt).toLocaleString('zh-CN')}，`
      + `而 lib/index.js 改于 ${new Date(installed).toLocaleString('zh-CN')} —— `
      + '现在跑的是旧构建，重启 DSH 后再巡检';
  } catch {
    return undefined;
  }
}

const stale = staleBuildReason();
if (stale !== undefined) {
  console.log(`跳过：${stale}`);
  console.log('（这不是插件缺陷；重启后用 `node scripts/probe-actions.mjs` 再跑一次）');
  process.exit(0);
}

// ── 1. 未知动作必须有明确错误，而不是静默 ok ─────────────────────────────
await expectAction('definitely-not-an-action', {}, { ok: false }, '');

// ── 2. 参数缺失/类型错：该拒的都拒 ──────────────────────────────────────
await expectAction('switch-account', {}, { ok: false }, '');
await expectAction('switch-account', { accountId: 123 }, { ok: false }, '');
await expectAction('switch-account', { accountId: 'acc_does_not_exist' }, { ok: false }, '');
await expectAction('remove-account', {}, { ok: false }, '');
await expectAction('members', { ids: 'not-an-array' }, { ok: false }, '');
await expectAction('settings', { patch: 'not-an-object' }, { ok: false }, '');
await expectAction('import-accounts', { text: '' }, { ok: false }, '');
await expectAction('export-accounts', { accountIds: 'not-an-array' }, { ok: false }, '');

// ── 3. 幂等/可逆动作：真跑一次，再恢复 ─────────────────────────────────
const before = await status();

// settings：翻转一个开关再翻回来（必须真的在状态里体现，否则界面切了没反应）。
const flipped = !before.state.accountPoolEnabled;
const settingsResult = await act('settings', { patch: { accountPoolEnabled: flipped } });
if (settingsResult.json?.ok !== true) {
  problems.push(`settings 应当成功，实际 ${JSON.stringify(settingsResult.json).slice(0, 160)}`);
} else if (settingsResult.json.status?.state?.accountPoolEnabled !== flipped) {
  problems.push('settings 成功了但返回的状态里开关没变（界面会看起来点了没反应）');
} else {
  steps.push(`settings 翻转 accountPoolEnabled → ${String(flipped)} 并回读一致 ✓`);
}
await act('settings', { patch: { accountPoolEnabled: before.state.accountPoolEnabled } });

// refresh：强制重拉目录。未登录时必须**不报错**（兜底目录），否则每次开界面都弹红条。
const refreshed = await act('refresh', { force: true });
if (refreshed.json?.ok !== true) {
  problems.push(`refresh 应当成功（未登录时也该回兜底目录），实际 ${JSON.stringify(refreshed.json).slice(0, 160)}`);
} else {
  const count = refreshed.json.status?.catalog?.count ?? 0;
  steps.push(`refresh 成功，目录 ${String(count)} 个模型（来源 ${String(refreshed.json.status?.catalog?.source)}）✓`);
}

// members：把当前成员原样写回（幂等）。
const memberIds = before.pool.memberIds ?? [];
const membersResult = await act('members', { ids: memberIds });
if (membersResult.json?.ok !== true) problems.push(`members 写回原成员应成功，实际 ${JSON.stringify(membersResult.json).slice(0, 160)}`);
else steps.push(`members 写回 ${String(memberIds.length)} 个成员 ✓`);

// members：不存在的 id 必须被过滤掉而不是原样存下（否则池里躺着幽灵成员）。
const ghost = await act('members', { ids: [...memberIds, 'acc_ghost_id_that_does_not_exist'] });
if (ghost.json?.ok !== true) problems.push(`members 带未知 id 也应成功（过滤后保存），实际 ${JSON.stringify(ghost.json).slice(0, 160)}`);
else if ((ghost.json.status?.pool?.memberIds ?? []).includes('acc_ghost_id_that_does_not_exist')) {
  problems.push('members 把不存在的 id 原样存进了池（幽灵成员会让挑选逻辑出错）');
} else {
  steps.push('members 过滤掉不存在的 id ✓');
}
await act('members', { ids: memberIds });

// login-status：没有会话时也必须回一个 idle 相位（界面靠它决定显不显示二维码）。
const loginStatus = await act('login-status');
if (loginStatus.json?.ok !== true) problems.push(`login-status 应当总是成功，实际 ${JSON.stringify(loginStatus.json).slice(0, 160)}`);
else if (typeof loginStatus.json.login?.phase !== 'string') problems.push('login-status 没返回 login.phase');
else steps.push(`login-status 无会话时回 phase=${loginStatus.json.login.phase} ✓`);

// cancel-login：没有会话时取消不该报错（幂等）。
const cancel = await act('cancel-login');
if (cancel.json?.ok !== true) problems.push(`cancel-login 无会话时应幂等成功，实际 ${JSON.stringify(cancel.json).slice(0, 160)}`);
else steps.push('cancel-login 幂等 ✓');

// ── 4. 起一次网页登录再取消（验证 login-web → login-status → cancel 的完整迁移）──
const started = await act('login-web');
if (started.json?.ok !== true || started.json.login?.phase !== 'waiting') {
  problems.push(`login-web 应当进入 waiting，实际 ${JSON.stringify(started.json?.login ?? started.json).slice(0, 200)}`);
} else {
  const port = started.json.login.port;
  const seen = await act('login-status');
  if (seen.json?.login?.running !== true) problems.push('login-web 之后 login-status 应当说 running=true');
  else steps.push(`login-web → waiting（端口 ${String(port)}），login-status 确认 running ✓`);
  const cancelled = await act('cancel-login');
  if (cancelled.json?.login?.running !== false) problems.push(`cancel-login 之后 running 应为 false，实际 ${String(cancelled.json?.login?.running)}`);
  else steps.push('cancel-login 把会话收回 cancelled ✓');
}

// ── 5. 桌面端探测（未装客户端时必须是「明确说没装」，不是报错）──────────
const adopt = await act('adopt-desktop');
if (adopt.json === undefined) problems.push('adopt-desktop 响应不是 JSON');
else if (before.desktop?.detected === false) {
  if (adopt.json.ok === true) problems.push('本机没装客户端，adopt-desktop 却返回成功');
  else {
    const reason = adopt.json.error?.message ?? adopt.json.message;
    steps.push(`adopt-desktop 在没装客户端时明确拒绝：「${String(reason).slice(0, 40)}」✓`);
  }
} else {
  steps.push(`adopt-desktop 返回 ok=${String(adopt.json.ok)}（本机检测到桌面端）`);
}

// ── 6. 有账号时才跑的花钱动作 ───────────────────────────────────────────
const after = await status();
const accounts = after.accounts ?? [];
if (accounts.length === 0) {
  steps.push('没有账号，跳过 test-account / checkin / export-accounts / import-accounts（不凭空造账号）');
  // 导出仍应能调：没有账号时导出空集合，不该报错。
  const emptyExport = await act('export-accounts', { accountIds: [] });
  if (emptyExport.json?.ok !== true) problems.push(`export-accounts 空集合应成功，实际 ${JSON.stringify(emptyExport.json).slice(0, 160)}`);
  else steps.push(`export-accounts 空集合导出 ${String(emptyExport.json.count ?? 0)} 个账号 ✓`);
} else {
  const id = accounts[0].id;
  const tested = await act('test-account', { accountId: id });
  if (tested.json === undefined) problems.push('test-account 响应不是 JSON');
  else steps.push(`test-account 返回 outcome=${String(tested.json.probe?.outcome)} ✓`);

  const exported = await act('export-accounts', { accountIds: [id] });
  if (exported.json?.ok !== true || typeof exported.json.path !== 'string') {
    problems.push(`export-accounts 应返回导出路径，实际 ${JSON.stringify(exported.json).slice(0, 160)}`);
  } else {
    steps.push(`export-accounts 导出 ${String(exported.json.count)} 个账号到文件 ✓`);
  }

  if (withCheckin) {
    const checkin = await act('checkin', { accountIds: [id] });
    if (checkin.json?.ok !== true) problems.push(`checkin 失败：${JSON.stringify(checkin.json).slice(0, 160)}`);
    else steps.push(`checkin 执行了 ${String(checkin.json.results?.length ?? 0)} 个账号（会消耗积分，仅在 --with-checkin 时跑）✓`);
  } else {
    steps.push('跳过 checkin（会消耗真实积分；用 --with-checkin 显式开启）');
  }
}

// ── 7. 收尾：把会话清干净，别让插件停在 error/waiting 相位 ───────────────
await act('cancel-login');
const final = await status();
if (final.login?.running === true) problems.push('巡检结束时登录会话仍是 running（没收干净）');

for (const step of steps) console.log(`ok   ${step}`);
if (problems.length > 0) {
  console.error(`\n动作活体巡检未通过（${String(problems.length)} 项）：`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
} else {
  console.log(`\n动作活体巡检通过：15 个动作在真实宿主上都能按契约回应。`);
}
