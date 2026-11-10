/**
 * 插件自己的状态文件：界面偏好与账号池开关。
 *
 * 为什么不用 DSH 的 settings：这些是「点一下立即生效、不经过保存」的开关。
 * 写进 settings 意味着每次改都要过一遍「改配置 → 重载插件」。所以它们落在
 * 一个自己的 JSON 文件里，读写都只碰它。
 *
 * 位置：`$DSH_HOME/dsh-connect-raccoon-state.json`；写盘走「临时文件 + rename」，
 * 读到坏 JSON 会被当成默认值（那不会有害，但读到半个 JSON 会让用户以为设置全丢了）。
 *
 * @module dsh-connect-raccoon/state
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { STATE_FILENAME } from './constants.ts';

/** 状态刷新间隔的五档（1 / 5 / 10 / 30 / 60 分钟）。 */
export const POLL_INTERVAL_CHOICES: readonly number[] = Object.freeze([
  60_000,
  300_000,
  600_000,
  1_800_000,
  3_600_000,
]);

/** 插件状态。 */
export interface PluginState {
  schemaVersion: 1;
  /**
   * 被用户关掉的模型 id。
   *
   * 存禁用名单而不是启用名单：上游随时上下架模型，启用名单会让新上架的模型
   * 默认不可见，用户得先知道它存在才可能勾上。
   */
  disabledModels: string[];
  /** 账号池总开关：开着时由池挑账号并在失败时换号。**默认关**（会改变哪份额度被消耗）。 */
  accountPoolEnabled: boolean;
  /**
   * 参与池的账号 id。
   *
   * 与 {@link accountPoolEnabled} 分工明确：那个开关管「要不要自动挑」，
   * 这张名单管「哪些账号有资格被挑中」。空数组合法的含义是「一个都没勾」，
   * 不是「全都勾」—— 后者会让用户取消全部之后反而全被启用。
   */
  enabledAccounts: string[];
  /** 输入框左侧的积分读数。 */
  composerPill: boolean;
  /** 状态刷新间隔；只能是 {@link POLL_INTERVAL_CHOICES} 之一。 */
  pollIntervalMs: number;
  /**
   * 每天自动签到（**默认关**：这是会自动改变账号状态的写操作）。
   *
   * **尚未接线**：目前只在状态里保存、界面上没有入口、宿主也不会自动触发。
   * 保留字段是因为签到接口与去重逻辑都已实现，接线只是加一个定时器；
   * 在那之前它不产生任何行为 —— 不要把它当成「已支持自动签到」。
   */
  autoCheckin: boolean;
}

/** 缺省状态。 */
export const DEFAULT_STATE: PluginState = Object.freeze({
  schemaVersion: 1,
  disabledModels: [],
  accountPoolEnabled: false,
  enabledAccounts: [],
  composerPill: true,
  pollIntervalMs: 60_000,
  autoCheckin: false,
}) as PluginState;

/** 状态文件路径。 */
function statePath(home: string): string {
  return join(home, STATE_FILENAME);
}

/** 解析 DSH home：`$DSH_HOME` 优先，否则 `~/.dsh`。 */
export function dshHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['DSH_HOME'];
  return typeof configured === 'string' && configured.trim() !== ''
    ? configured.trim()
    : join(homedir(), '.dsh');
}

/** 把任意输入收敛成合法状态；非法字段回落到默认值而不是抛错。 */
export function normalizeState(raw: unknown): PluginState {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_STATE };
  const record = raw as Record<string, unknown>;
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  const bool = (value: unknown, fallback: boolean): boolean =>
    typeof value === 'boolean' ? value : fallback;
  const poll = typeof record['pollIntervalMs'] === 'number' ? record['pollIntervalMs'] : 0;
  return {
    schemaVersion: 1,
    disabledModels: strings(record['disabledModels']),
    accountPoolEnabled: bool(record['accountPoolEnabled'], DEFAULT_STATE.accountPoolEnabled),
    enabledAccounts: strings(record['enabledAccounts']),
    composerPill: bool(record['composerPill'], DEFAULT_STATE.composerPill),
    pollIntervalMs: POLL_INTERVAL_CHOICES.includes(poll) ? poll : DEFAULT_STATE.pollIntervalMs,
    autoCheckin: bool(record['autoCheckin'], DEFAULT_STATE.autoCheckin),
  };
}

/** 读状态；文件不存在或读不动都返回默认值（不抛）。 */
export async function readState(options?: { home?: string }): Promise<PluginState> {
  const home = options?.home ?? dshHome();
  try {
    const text = await readFile(statePath(home), 'utf8');
    return normalizeState(JSON.parse(text) as unknown);
  } catch {
    return { ...DEFAULT_STATE };
  }
}

/**
 * 合并写入状态。
 *
 * 返回**合并后**的完整状态：调用方拿它更新内存副本，避免再读一次盘
 * （两次读盘之间的写入会被后一次覆盖）。
 *
 * @param patch - 要改的字段；未提供的保持原值。
 * @param options - 家目录覆盖（测试用）。
 * @returns 写入后的完整状态。
 */
export async function writeState(
  patch: Partial<Omit<PluginState, 'schemaVersion'>>,
  options?: { home?: string },
): Promise<PluginState> {
  const home = options?.home ?? dshHome();
  const current = await readState({ home });
  const next = normalizeState({ ...current, ...patch });
  const path = statePath(home);
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${String(process.pid)}.tmp`;
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, path);
  return next;
}
