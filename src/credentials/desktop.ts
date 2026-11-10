/**
 * 桌面端凭据：探测与写回。
 *
 * 小浣熊桌面端把登录态写在 `~/.box-agent/config/auth.json`（`BOX_AGENT_CONFIG_DIR`
 * 可整体搬走），**一个文件只承载一份登录态** —— 所以它最多贡献账号池里的一个成员。
 *
 * 写回是必须的：它的 refresh token 单次使用，插件只刷不写回会让 App 下次刷新撞
 * `refresh_conflict` 并被登出。写回必须**保键序、保未知字段、原子替换**，
 * 因为这些文件属于另一个程序（ADR-2）。
 *
 * 凭据只经本模块进出；本模块不写日志、不返回 token 给展示层。
 *
 * @module dsh-connect-raccoon/credentials/desktop
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  DESKTOP_AUTH_FILENAME,
  DESKTOP_CONFIG_DIRNAME,
  DESKTOP_TOKEN_KEYS,
} from '../constants.ts';
import { decodeJwtFacts } from './vault.ts';

/** 一个候选路径与它的来源。 */
export interface DesktopCandidate {
  path: string;
  source: 'env-file' | 'env-dir' | 'default';
}

/** 没读到凭据时的分类原因；界面按它给出可执行建议。 */
export type DesktopReason =
  | 'desktop-missing'
  | 'desktop-unreadable'
  | 'desktop-no-token'
  | 'desktop-encrypted';

/** 从桌面端文件读出的凭据。 */
export interface DesktopCredential {
  accessToken: string;
  refreshToken: string;
  identity?: string;
  orgName?: string;
  orgRole?: string;
  /** 访问令牌的 `name` 声明；解不出时缺省。 */
  nickname?: string;
  expiresAtMs?: number;
  /** 磁盘上原有的全部键（写回时用于保留未知字段）。 */
  rawKeys: string[];
}

/** 一次探测的完整结果。 */
export interface DesktopProbe {
  configDir: string;
  authPath: string;
  exists: boolean;
  readable: boolean;
  /** 桌面端一个文件只承载一份登录态，这里恒为 `false` 并写明原因。 */
  multiAccount: false;
  reason: DesktopReason | null;
  /** 文件里的键序是否等于 App 的写入键序（决定写回是否安全）。 */
  keyOrderMatchesApp: boolean;
  credential?: DesktopCredential;
}

/**
 * 列出候选路径，按优先级。
 *
 * `RACCOON_AUTH_FILE` 直接当文件（短路其余全部），`BOX_AGENT_CONFIG_DIR` 当目录。
 *
 * @param env - 环境变量（测试注入）。
 * @returns 候选路径，最多三条。
 */
export function desktopAuthCandidates(env: NodeJS.ProcessEnv = process.env): DesktopCandidate[] {
  const explicitFile = env['RACCOON_AUTH_FILE']?.trim();
  if (explicitFile !== undefined && explicitFile !== '') {
    return [{ path: path.resolve(explicitFile), source: 'env-file' }];
  }
  const explicitDir = env['BOX_AGENT_CONFIG_DIR']?.trim();
  if (explicitDir !== undefined && explicitDir !== '') {
    return [{ path: path.join(path.resolve(explicitDir), DESKTOP_AUTH_FILENAME), source: 'env-dir' }];
  }
  return [
    {
      path: path.join(homedir(), DESKTOP_CONFIG_DIRNAME, DESKTOP_AUTH_FILENAME),
      source: 'default',
    },
  ];
}

/** 从任意值里取非空字符串。 */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** 判断一个值是不是「加密信封」形态；本插件不解密（见 ADR-2 的说明）。 */
function isEnvelope(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record['envelope'] === 'string' || Object.keys(record).some((key) => key.startsWith('$'));
}

/** 解析 auth.json 文档；不是对象返回 `undefined`。 */
function parseDocument(text: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

/** 一个探测结果：只是「没找到」那种。 */
function missing(authPath: string, configDir: string, reason: DesktopReason): DesktopProbe {
  return {
    configDir,
    authPath,
    exists: false,
    readable: false,
    multiAccount: false,
    reason,
    keyOrderMatchesApp: false,
  };
}

/**
 * 探测本机桌面端凭据；只读，不刷新、不写回。
 *
 * @param options.env - 环境变量覆盖（测试用）。
 * @returns 探测结果；永远不会抛。
 */
export async function probeDesktop(options: { env?: NodeJS.ProcessEnv } = {}): Promise<DesktopProbe> {
  const env = options.env ?? process.env;
  const candidate = desktopAuthCandidates(env)[0];
  if (candidate === undefined) return missing('', '', 'desktop-missing');
  const authPath = candidate.path;
  const configDir = path.dirname(authPath);

  let exists = false;
  try {
    const info = await stat(authPath);
    exists = info.isFile();
  } catch {
    return missing(authPath, configDir, 'desktop-missing');
  }
  if (!exists) return missing(authPath, configDir, 'desktop-missing');

  let text: string;
  try {
    text = await readFile(authPath, 'utf8');
  } catch {
    return { ...missing(authPath, configDir, 'desktop-unreadable'), exists: true };
  }

  const document = parseDocument(text);
  if (document === undefined) {
    return { ...missing(authPath, configDir, 'desktop-no-token'), exists: true, readable: true };
  }

  const rawKeys = Object.keys(document);
  // App 按插入序写这两个字段；顺序不一致意味着对面不是 App 写的（或版本变了），
  // 此时写回会改动它的文件形状，宁可不写。
  const keyOrderMatchesApp = DESKTOP_TOKEN_KEYS.every((key, index) => rawKeys[index] === key);

  const accessRaw = document['access_token'] ?? document['token'] ?? document['auth_token'];
  const refreshRaw = document['refresh_token'];
  if (isEnvelope(accessRaw) || isEnvelope(refreshRaw)) {
    return { ...missing(authPath, configDir, 'desktop-encrypted'), exists: true, readable: true, keyOrderMatchesApp };
  }
  const accessToken = str(accessRaw);
  const refreshToken = str(refreshRaw) ?? '';
  if (accessToken === undefined) {
    return { ...missing(authPath, configDir, 'desktop-no-token'), exists: true, readable: true, keyOrderMatchesApp };
  }

  const facts = decodeJwtFacts(accessToken);
  const identity = str(document['office_identity']);
  const orgName = str(document['office_org_name']);
  const orgRole = str(document['office_org_role']);
  return {
    configDir,
    authPath,
    exists: true,
    readable: true,
    multiAccount: false,
    reason: null,
    keyOrderMatchesApp,
    credential: {
      accessToken,
      refreshToken,
      rawKeys,
      ...(identity === undefined ? {} : { identity }),
      ...(orgName === undefined ? {} : { orgName }),
      ...(orgRole === undefined ? {} : { orgRole }),
      ...(facts.nickname === undefined ? {} : { nickname: facts.nickname }),
      ...(facts.expiresAtMs === undefined ? {} : { expiresAtMs: facts.expiresAtMs }),
    },
  };
}

/** 写回结果。 */
export type WriteBackResult = { ok: true; backupPath?: string } | { ok: false; reason: string };

/**
 * 把轮转后的令牌对原子写回桌面端文件。
 *
 * 保三条：未知键还在、键序不变、失败时原文件一个字节都不动（先写临时文件再 rename）。
 *
 * @param input.probe - 探测结果；必须带 `credential`（否则无从保字段）。
 * @param input.accessToken - 新的访问令牌。
 * @param input.refreshToken - 新的续期令牌。
 * @param input.backupDir - 备份目录；缺省用凭据所在目录的上一级。
 * @param input.now - 时钟（测试注入）。
 * @returns 写入结果；失败不抛。
 */
export async function writeBackDesktop(input: {
  probe: DesktopProbe;
  accessToken: string;
  refreshToken: string;
  backupDir?: string;
  now?: () => number;
}): Promise<WriteBackResult> {
  const { probe } = input;
  if (probe.credential === undefined) return { ok: false, reason: '没有可写回的凭据快照' };

  let original: string;
  try {
    original = await readFile(probe.authPath, 'utf8');
  } catch {
    return { ok: false, reason: '读不到桌面端凭据文件' };
  }
  const document = parseDocument(original);
  if (document === undefined) return { ok: false, reason: '桌面端凭据文件不是合法 JSON 对象' };

  const next: Record<string, unknown> = { ...document, access_token: input.accessToken, refresh_token: input.refreshToken };
  // 键序：先按 App 的序写出已知键，再把未知键按它们在原文件里的顺序追加。
  const ordered: Record<string, unknown> = {};
  for (const key of DESKTOP_TOKEN_KEYS) {
    if (key in next) ordered[key] = next[key];
  }
  for (const key of Object.keys(document)) {
    if (!(key in ordered)) ordered[key] = document[key];
  }

  const backupDir = input.backupDir ?? path.dirname(probe.authPath);
  const backupPath = path.join(backupDir, `.${DESKTOP_AUTH_FILENAME}.dsh-backup`);
  let savedBackup: string | undefined;
  try {
    await mkdir(backupDir, { recursive: true });
    // 只在备份不存在时写：保留**第一次**被替换的内容，多次刷新不会把证据冲掉。
    await stat(backupPath).then(
      () => undefined,
      async () => {
        await writeFile(backupPath, original, { encoding: 'utf8', mode: 0o600 });
        savedBackup = backupPath;
      },
    );
  } catch {
    // 备份失败不阻塞写入：备份是回滚材料，不是写入前提。
  }

  // 临时文件名带随机后缀：同进程内两次写回不会撞同一个临时文件。
  const temp = `${probe.authPath}.${String(process.pid)}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(ordered, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temp, probe.authPath);
  } catch {
    return { ok: false, reason: '写入桌面端凭据文件失败（临时文件或替换被拒绝）' };
  }
  return { ok: true, ...(savedBackup === undefined ? {} : { backupPath: savedBackup }) };
}