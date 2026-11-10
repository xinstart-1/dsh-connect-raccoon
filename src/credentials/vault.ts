/**
 * 保存插件账号与显式选择，凭据仅写入私有文件。
 * 根目录由调用参数、DSH_HOME、用户目录依次决定。
 * 每次写入使用独立临时文件，rename 后才对读者可见。
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { VAULT_DIRNAME } from '../constants.ts';

/** 插件持久化的一份账号凭据，禁止进入日志。 */
export interface StoredAccount {
  schemaVersion: 1;
  /** accountKey 的 SHA-256 前 16 位加 acc_ 前缀。 */
  id: string;
  /** 调用方依次取 access sub、refresh sub、access 哈希。 */
  accountKey: string;
  accessToken: string;
  refreshToken: string;
  /** JWT exp 的毫秒值；无法解析时为 0。 */
  expiresAtMs: number;
  /** refresh JWT exp 的毫秒值；无法解析时为 0。 */
  refreshExpiresAtMs: number;
  identity?: string;
  orgName?: string;
  orgRole?: string;
  nickname?: string;
  source: 'desktop' | 'web' | 'qr' | 'import';
  savedAtMs: number;
  /** 桌面来源文件的绝对路径，用于诊断与写回。 */
  desktopPath?: string;
  probe?: { outcome: string; message: string; atMs: number };
}

/** 按账号隔离的本地仓库；读取损坏记录视为不存在。 */
export interface Vault {
  rootDir(): string;
  list(): Promise<StoredAccount[]>;
  get(id: string): Promise<StoredAccount | undefined>;
  save(account: StoredAccount): Promise<void>;
  remove(id: string): Promise<boolean>;
  /** 选择指向不存在的账号时返回 undefined。 */
  readSelected(): Promise<string | undefined>;
  writeSelected(id: string | undefined): Promise<void>;
}

/** 未经签名验证的 JWT 声明，仅用于展示与刷新调度。 */
export interface JwtFacts {
  expiresAtMs?: number;
  accountKey?: string;
  nickname?: string;
  identity?: string;
}

/** 从稳定账号标识派生安全文件名。 */
export function accountIdFor(accountKey: string): string {
  return `acc_${createHash('sha256').update(accountKey).digest('hex').slice(0, 16)}`;
}

/** 只解码 JWT payload；格式错误返回空对象，绝不验签。 */
export function decodeJwtFacts(token: string): JwtFacts {
  try {
    const segments = token.split('.');
    const payload = segments[1];
    if (segments.length !== 3 || !payload || !/^[\w-]+$/.test(payload)) return {};
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!isRecord(claims)) return {};
    const facts: JwtFacts = {};
    if (typeof claims.exp === 'number' && Number.isFinite(claims.exp * 1000)) {
      facts.expiresAtMs = claims.exp * 1000;
    }
    if (typeof claims.sub === 'string' && claims.sub) facts.accountKey = claims.sub;
    if (typeof claims.name === 'string') facts.nickname = claims.name;
    if (typeof claims.identity === 'string') facts.identity = claims.identity;
    return facts;
  } catch { return {}; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAccount(value: unknown): value is StoredAccount {
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
  if (typeof value.accountKey !== 'string' || value.id !== accountIdFor(value.accountKey)) return false;
  if (!['accessToken', 'refreshToken'].every(key => typeof value[key] === 'string')) return false;
  if (!['expiresAtMs', 'refreshExpiresAtMs', 'savedAtMs'].every(key =>
    typeof value[key] === 'number' && Number.isFinite(value[key]))) return false;
  if (!['desktop', 'web', 'qr', 'import'].includes(String(value.source))) return false;
  if (!['identity', 'orgName', 'orgRole', 'nickname', 'desktopPath'].every(key =>
    value[key] === undefined || typeof value[key] === 'string')) return false;
  const probe = value.probe;
  return probe === undefined || (isRecord(probe) && typeof probe.outcome === 'string'
    && typeof probe.message === 'string' && typeof probe.atMs === 'number'
    && Number.isFinite(probe.atMs));
}

async function readJson(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, 'utf8')) as unknown; }
  catch { return undefined; }
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => undefined); }
}

async function removeFile(path: string): Promise<boolean> {
  try { await unlink(path); return true; }
  catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

/** 创建仓库；home 为 DSH 根目录，创建时不产生磁盘写入。 */
export function createVault(options: { home?: string } = {}): Vault {
  const root = resolve(options.home ?? (process.env.DSH_HOME || join(homedir(), '.dsh')), VAULT_DIRNAME);
  const accountsDir = join(root, 'accounts');
  const selectedPath = join(root, 'selected.json');
  const validId = (id: string): boolean => /^acc_[a-f0-9]{16}$/.test(id);
  const get = async (id: string): Promise<StoredAccount | undefined> => {
    if (!validId(id)) return undefined;
    const account = await readJson(join(accountsDir, `${id}.json`));
    return isAccount(account) && account.id === id ? account : undefined;
  };
  return {
    rootDir: () => root,
    get,
    async list() {
      let filenames: string[];
      try { filenames = await readdir(accountsDir); }
      catch (error) {
        if (isRecord(error) && error.code === 'ENOENT') return [];
        throw error;
      }
      const accounts = await Promise.all(filenames.filter(name => name.endsWith('.json'))
        .map(name => get(name.slice(0, -5))));
      return accounts.filter((account): account is StoredAccount => account !== undefined);
    },
    async save(account) {
      if (!isAccount(account)) throw new TypeError('账号记录不符合 schemaVersion 1');
      await mkdir(root, { recursive: true, mode: 0o700 });
      await atomicJson(join(accountsDir, `${account.id}.json`), account);
    },
    async remove(id) {
      return validId(id) ? removeFile(join(accountsDir, `${id}.json`)) : false;
    },
    async readSelected() {
      const selection = await readJson(selectedPath);
      if (!isRecord(selection) || selection.version !== 1 || typeof selection.accountId !== 'string') return undefined;
      return await get(selection.accountId) ? selection.accountId : undefined;
    },
    async writeSelected(id) {
      if (id === undefined) { await removeFile(selectedPath); return; }
      if (!validId(id)) throw new TypeError('账号 id 格式无效');
      await atomicJson(selectedPath, { version: 1, accountId: id });
    },
  };
}
