/**
 * 账号生命周期：从桌面端收号、按需续期、读余额、判可用性、记冷却。
 *
 * 这里的所有写操作都收敛到一条不变量上：**同一个账号的令牌续期必须单飞**。
 * 小浣熊的 refresh token 是单次使用的（换一次，新旧一起轮转），两个并发请求
 * 各刷一次就等于把其中一个烧掉。所以续期一律走 `Refresher`，它按 accountKey
 * 去重；本模块只负责「刷完存哪儿、写不写回桌面端」。
 *
 * @module dsh-connect-raccoon/host/accounts
 */

import { CREDITS_TTL_MS, REFRESH_EARLY_MS } from '../constants.ts';
import type { Balance, RaccoonClient } from '../protocol/client.ts';
import { RaccoonError } from '../protocol/errors.ts';
import type { Refresher } from '../credentials/refresh.ts';
import { probeDesktop, writeBackDesktop, type DesktopProbe } from '../credentials/desktop.ts';
import { accountIdFor, type StoredAccount, type Vault } from '../credentials/vault.ts';

/** 可用性判定的结果。 */
export interface Usability {
  usable: boolean;
  /** 不可用的分类原因；界面直接显示。 */
  reason?: string;
}

/** 账号运行时的依赖。 */
export interface AccountsOptions {
  vault: Vault;
  client: RaccoonClient;
  refresher: Refresher;
  /** 是否允许把续期结果写回桌面端文件（配置项）。 */
  writeBackDesktop: () => boolean;
  /** 是否允许读桌面端（配置项）。 */
  reuseDesktop: () => boolean;
  warn: (message: string) => void;
  now?: () => number;
}

/** 账号运行时：账号列表、选择、续期、余额、冷却。 */
export interface Accounts {
  list(): Promise<StoredAccount[]>;
  get(id: string): Promise<StoredAccount | undefined>;
  selected(): Promise<string | undefined>;
  select(id: string | undefined): Promise<void>;
  remove(id: string): Promise<boolean>;
  probeDesktop(): Promise<DesktopProbe>;
  adoptDesktop(probe?: DesktopProbe): Promise<{ ok: boolean; account?: StoredAccount; reason?: string }>;
  /** 取一个可用于请求的令牌；临近过期时先续期（单飞）。 */
  accessToken(id: string): Promise<string>;
  /** 读余额；失败返回 `undefined`（「不知道」不等于「没有」）。 */
  credits(id: string, options?: { force?: boolean }): Promise<Balance | undefined>;
  usability(account: StoredAccount): Usability;
  markCooldown(id: string, ms: number): void;
  cooldownMs(id: string): number;
}

/** 从桌面端凭据造一条仓库记录。 */
function fromDesktop(input: {
  credential: { accessToken: string; refreshToken: string; identity?: string; orgName?: string; orgRole?: string; expiresAtMs?: number };
  authPath: string;
  accountKey?: string;
  nickname?: string;
  nowMs: number;
}): StoredAccount {
  const key = input.accountKey ?? input.credential.accessToken;
  return {
    schemaVersion: 1,
    id: accountIdFor(key),
    accountKey: key,
    accessToken: input.credential.accessToken,
    refreshToken: input.credential.refreshToken,
    expiresAtMs: input.credential.expiresAtMs ?? 0,
    refreshExpiresAtMs: 0,
    source: 'desktop',
    savedAtMs: input.nowMs,
    desktopPath: input.authPath,
    ...(input.credential.identity === undefined ? {} : { identity: input.credential.identity }),
    ...(input.credential.orgName === undefined ? {} : { orgName: input.credential.orgName }),
    ...(input.credential.orgRole === undefined ? {} : { orgRole: input.credential.orgRole }),
    ...(input.nickname === undefined ? {} : { nickname: input.nickname }),
  };
}

/**
 * 建账号运行时。
 *
 * @param options - 仓库、上游客户端、续期器与两个配置开关。
 * @returns 账号运行时。
 */
export function createAccounts(options: AccountsOptions): Accounts {
  const now = options.now ?? ((): number => Date.now());
  /** 内存里的冷却表：限流是「此刻」的事实，不值得落盘。 */
  const cooldowns = new Map<string, number>();
  const creditCache = new Map<string, { atMs: number; balance: Balance }>();

  const accountOf = async (id: string): Promise<StoredAccount> => {
    const account = await options.vault.get(id);
    if (account === undefined) {
      throw new RaccoonError({ code: 'bad-request', message: `账号 ${id} 不在本机`, status: 404 });
    }
    return account;
  };

  /** 令牌过期判定：`expiresAtMs === 0` 表示解不出，按「可能还有效」处理并交给上游判。 */
  const expiresSoon = (account: StoredAccount): boolean =>
    account.expiresAtMs > 0 && account.expiresAtMs - now() <= REFRESH_EARLY_MS;

  return {
    list: () => options.vault.list(),

    get: (id) => options.vault.get(id),

    selected: () => options.vault.readSelected(),

    select: async (id) => {
      if (id !== undefined) await accountOf(id);
      await options.vault.writeSelected(id);
    },

    remove: (id) => options.vault.remove(id),

    probeDesktop: () => (options.reuseDesktop() ? probeDesktop() : Promise.resolve(emptyProbe())),

    async adoptDesktop(probe) {
      const resolved = probe ?? (await this.probeDesktop());
      if (!options.reuseDesktop()) {
        return { ok: false, reason: '配置里关掉了「复用桌面端登录」' };
      }
      if (resolved.credential === undefined) {
        return { ok: false, reason: resolved.reason ?? 'desktop-no-token' };
      }
      const account = fromDesktop({
        credential: resolved.credential,
        authPath: resolved.authPath,
        nowMs: now(),
      });
      await options.vault.save(account);
      const selected = await options.vault.readSelected();
      if (selected === undefined) await options.vault.writeSelected(account.id);
      return { ok: true, account };
    },

    async accessToken(id) {
      const account = await accountOf(id);
      if (!expiresSoon(account)) return account.accessToken;
      if (account.refreshToken === '') {
        throw new RaccoonError({
          code: 'token-invalid',
          message: '这个账号的登录令牌已过期，且没有续期凭据（扫码登录无 refresh token），请重新登录',
          status: 401,
        });
      }
      const outcome = await options.refresher.refresh({
        accountKey: account.accountKey,
        refreshToken: account.refreshToken,
      });
      const updated: StoredAccount = {
        ...account,
        accessToken: outcome.accessToken,
        refreshToken: outcome.refreshToken,
        expiresAtMs: outcome.expiresAtMs,
        savedAtMs: now(),
      };
      await options.vault.save(updated);
      if (updated.source === 'desktop' && options.writeBackDesktop()) {
        const probe = await probeDesktop();
        if (probe.exists && probe.keyOrderMatchesApp) {
          const written = await writeBackDesktop({
            probe,
            accessToken: outcome.accessToken,
            refreshToken: outcome.refreshToken,
          });
          if (!written.ok) {
            // 写回失败不是请求失败：插件自己的副本已经能用了，但用户必须知道
            // 桌面端下次刷新会撞 refresh_conflict。
            options.warn(`令牌写回桌面端失败（${written.reason}）：桌面端下次刷新可能需要重新登录`);
          }
        }
      }
      return outcome.accessToken;
    },

    async credits(id, creditOptions) {
      const cached = creditCache.get(id);
      const fresh = creditOptions?.force === true;
      if (!fresh && cached !== undefined && now() - cached.atMs < CREDITS_TTL_MS) return cached.balance;
      try {
        const balance = await options.client.fetchBalance(await this.accessToken(id));
        creditCache.set(id, { atMs: now(), balance });
        return balance;
      } catch (error) {
        // 读余额失败必须与「余额为 0」区分：前者不该把账号踢出池子。
        options.warn(`读取账号 ${id} 余额失败：${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
    },

    usability(account) {
      if (this.cooldownMs(account.id) > 0) {
        return { usable: false, reason: '限流冷却中' };
      }
      if (account.expiresAtMs > 0 && account.expiresAtMs <= now() && account.refreshToken === '') {
        return { usable: false, reason: '登录令牌已过期，请重新登录' };
      }
      if (account.refreshExpiresAtMs > 0 && account.refreshExpiresAtMs <= now()) {
        return { usable: false, reason: '续期凭据已过期，请重新登录' };
      }
      if (account.probe !== undefined && account.probe.outcome === 'rejected') {
        return { usable: false, reason: account.probe.message };
      }
      return { usable: true };
    },

    markCooldown(id, ms) {
      cooldowns.set(id, now() + ms);
    },

    cooldownMs(id) {
      const until = cooldowns.get(id);
      if (until === undefined) return 0;
      const remaining = until - now();
      if (remaining <= 0) {
        cooldowns.delete(id);
        return 0;
      }
      return remaining;
    },
  };
}

/** 没启用桌面端复用时返回的空探测结果（界面据此显示「已关闭」而不是「没装」）。 */
function emptyProbe(): DesktopProbe {
  return {
    configDir: '',
    authPath: '',
    exists: false,
    readable: false,
    multiAccount: false,
    reason: 'desktop-missing',
    keyOrderMatchesApp: false,
  };
}
