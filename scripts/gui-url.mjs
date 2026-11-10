/**
 * 找出正在运行的那个 DSH GUI 地址。
 *
 * 为什么不能写死端口：DSH 每次重启都会换一个回环端口（实测 59224 → 49204 → 51797），
 * 写死的默认值过几轮就变成噪音 —— 探针报「连不上」，看起来像插件缺陷，
 * 实际只是端口变了。这里改为按顺序试：显式 `--url` / 环境变量 → 本地记录 →
 * 扫描回环端口。都找不到才报错，并说明该怎么指定。
 *
 * @module scripts/gui-url
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** 上一次成功连上的地址记在这里，下次优先试（冷启动时省一轮扫描）。 */
const CACHE_FILE = join(homedir(), '.dsh', 'raccoon-gui-url.json');

/** 探一个地址是不是 DSH：路由回 200 才算，404 说明是别的服务。 */
async function looksLikeDsh(baseUrl, pluginName) {
  try {
    const response = await fetch(`${baseUrl}/plugins/${pluginName}/status`, {
      signal: AbortSignal.timeout(1200),
    });
    return response.status === 200;
  } catch {
    return false;
  }
}

/** 读上一次成功的地址。 */
function cachedBase() {
  try {
    const parsed = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    return typeof parsed?.baseUrl === 'string' ? parsed.baseUrl : undefined;
  } catch {
    return undefined;
  }
}

/** 记下一次成功的地址；写不进去不影响主流程。 */
export function rememberBase(baseUrl) {
  try {
    writeFileSync(CACHE_FILE, `${JSON.stringify({ baseUrl, atMs: Date.now() })}\n`, 'utf8');
  } catch {
    // 缓存只是加速，失败无所谓。
  }
}

/**
 * 解析 GUI 地址。
 *
 * @param input.pluginName - 本插件包名，用于确认「这个端口上确实是 DSH 且装了我们」。
 * @param input.args - 命令行参数（找 `--url <addr>`）。
 * @returns 可用的 base URL。
 * @throws 全部候选都连不上时，错误信息里给出该怎么手动指定。
 */
export async function resolveGuiBase(input) {
  const index = input.args.indexOf('--url');
  const explicit = index >= 0 ? input.args[index + 1] : undefined;
  const candidates = [
    explicit,
    process.env['DSH_GUI_URL'],
    cachedBase(),
    // 常见的回环端口段：DSH 用系统分配的临时端口。
    ...[
      ...[49204, 51797, 59224, 3000, 5173, 8080].map((port) => `http://127.0.0.1:${String(port)}`),
    ],
  ].filter((value) => typeof value === 'string' && value !== '');

  // 去掉重复，保持优先级。
  const seen = new Set();
  const ordered = candidates.map((value) => value.replace(/\/+$/, '')).filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });

  for (const baseUrl of ordered) {
    if (await looksLikeDsh(baseUrl, input.pluginName)) {
      rememberBase(baseUrl);
      return baseUrl;
    }
  }

  // 全都不是 DSH：仍然返回第一个候选，让调用方用它的错误信息说话
  // （「连不上 X」比「找不到端口」更便于排查）。
  if (explicit !== undefined && explicit !== '') return explicit.replace(/\/+$/, '');
  throw new Error(
    '找不到正在运行的 DSH（插件状态路由没有一个应答 200）。'
    + '用 `--url http://127.0.0.1:<端口>` 指定，端口见 DSH 窗口标题栏或 `dsh web` 输出。',
  );
}

/** 清掉缓存（端口彻底变了、旧地址长时间无效时用）。 */
export function forgetBase() {
  try {
    if (existsSync(CACHE_FILE)) writeFileSync(CACHE_FILE, '{}\n', 'utf8');
  } catch {
    // 同上。
  }
}
