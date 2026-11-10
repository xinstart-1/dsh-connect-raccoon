/**
 * 运行时：把仓库、账号、目录、登录与上游客户端编成一份「界面能读的状态 + 能执行的动作」。
 *
 * 这一层是**唯一**持有可变状态的地方（目录缓存、最近换号记录、签到结果）。
 * 它不做渲染（那是浏览器半边）、不做协议解析（那是 `protocol/`）、
 * 也不决定令牌怎么续（那是 `credentials/`）。
 *
 * 不变量：① 任何动作都不把令牌写进返回值；② 目录永远有值（最差是内置兜底），
 * 因为空目录会让模型选择器整组消失且不会自己恢复。
 *
 * @module dsh-connect-raccoon/host/runtime
 */

import { CATALOG_TTL_MS, PROVIDER, VERSION } from '../constants.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FALLBACK_CATALOG, parseCatalog, visibleModels, type Catalog, type CatalogModel } from '../protocol/catalog.ts';
import { RaccoonError } from '../protocol/errors.ts';
import type { RaccoonClient } from '../protocol/client.ts';
import type { DesktopProbe } from '../credentials/desktop.ts';
import { accountIdFor, decodeJwtFacts, type StoredAccount, type Vault } from '../credentials/vault.ts';
import type { Accounts } from './accounts.ts';
import { pickAccount } from './pool.ts';
import { createLoginManager, type LoginManager, type LoginView } from './login.ts';
import { buildStatus, type StatusDocument } from './status.ts';
import type { PluginState } from '../state.ts';
import type { RaccoonAction } from './routes.ts';

/** 运行时依赖。 */
export interface RuntimeOptions {
  vault: Vault;
  accounts: Accounts;
  client: RaccoonClient;
  /** 读当前插件状态。 */
  state: () => PluginState;
  /** 合并写入插件状态并返回写入后的完整状态。 */
  saveState: (patch: Partial<Omit<PluginState, 'schemaVersion'>>) => Promise<PluginState>;
  /** 应用配置。 */
  config: () => { enabled: boolean; reuseDesktop: boolean };
  warn: (message: string) => void;
  /** 用系统默认浏览器打开 URL。 */
  openBrowser: (url: string) => boolean;
  /** 目录变化后通知 adapter 重建 profiles。 */
  onCatalog?: (models: readonly CatalogModel[]) => void;
  now?: () => number;
}

/** 运行时。 */
export interface Runtime {
  /** 构建状态文档（会按需刷新缓存，但不会主动发上游请求）。 */
  status(): Promise<StatusDocument>;
  /** 执行一个白名单动作。 */
  run(action: RaccoonAction, body: Record<string, unknown>): Promise<unknown>;
  /** 当前可见目录（adapter 与模型发现都读它）。 */
  catalog(): readonly CatalogModel[];
  /** 启动后预热：目录、桌面端收号、账号续期。 */
  warm(): Promise<void>;
  /** 登录管理器（卸载时要 dispose）。 */
  login: LoginManager;
  /** 释放资源。 */
  dispose(): void;
}

/** 最近一次换号记录；只在内存里。 */
interface FailoverRecord {
  atMs: number;
  fromId: string;
  toId: string;
  reason: string;
}

/**
 * 建运行时。
 *
 * @param options - 仓库、账号、上游客户端与状态读写。
 * @returns 运行时。
 */
export function createRuntime(options: RuntimeOptions): Runtime {
  const now = options.now ?? ((): number => Date.now());
  /** 目录缓存；初始就是兜底表（选择器不能空着）。 */
  let catalog: Catalog = { models: [...FALLBACK_CATALOG], fetchedAtMs: 0, source: 'fallback' };
  let catalogError: string | null = null;
  let desktopProbe: DesktopProbe | null = null;
  let lastFailover: FailoverRecord | null = null;
  let lastCheckin: { lastRunAtMs: number | null; results: Array<{ accountId: string; outcome: string; message: string }> } = {
    lastRunAtMs: null,
    results: [],
  };
  let disposed = false;

  /** 目录写入口：唯一一处更新缓存 + 通知 adapter。 */
  const setCatalog = (next: Catalog, error: string | null): void => {
    catalog = next;
    catalogError = error;
    options.onCatalog?.(visibleModels(next.models, options.state().disabledModels));
  };

  /** 拉一次目录；失败保留旧目录并记下原因（绝不清空）。 */
  const refreshCatalog = async (accessToken: string | undefined): Promise<void> => {
    if (accessToken === undefined) return;
    try {
      const live = await options.client.fetchCatalog(accessToken);
      setCatalog(live, null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      catalogError = message;
      // 保留旧目录：目录是能活过重启的事实，一次失败不该让它消失。
      if (catalog.source === 'fallback') setCatalog({ ...catalog }, message);
      options.warn(`刷新模型目录失败（继续使用现有目录）：${message}`);
    }
  };

  /**
   * 挑一个可用于「读目录」等只读操作的账号。
   *
   * 目录与桌面端探测都不该因为「用户还没勾选池成员」而失败 ——
   * 这里退回到「当前选用，其次第一个可用账号」。
   */
  const anyUsableAccount = async (): Promise<StoredAccount | undefined> => {
    const selected = await options.vault.readSelected();
    if (selected !== undefined) {
      const account = await options.vault.get(selected);
      if (account !== undefined) return account;
    }
    const all = await options.vault.list();
    return all[0];
  };

  const login: LoginManager = createLoginManager({
    client: options.client,
    warn: options.warn,
    openBrowser: options.openBrowser,
    now,
    async toAccount(input) {
      const facts = decodeJwtFacts(input.accessToken);
      const refreshFacts = input.refreshToken === '' ? {} : decodeJwtFacts(input.refreshToken);
      const key = facts.accountKey ?? refreshFacts.accountKey ?? input.accessToken;
      return {
        schemaVersion: 1,
        id: accountIdFor(key),
        accountKey: key,
        accessToken: input.accessToken,
        refreshToken: input.refreshToken,
        expiresAtMs: facts.expiresAtMs ?? 0,
        refreshExpiresAtMs: refreshFacts.expiresAtMs ?? 0,
        source: input.source,
        savedAtMs: now(),
        ...(input.nickname === undefined ? {} : { nickname: input.nickname }),
        ...(input.identity === undefined ? {} : { identity: input.identity }),
        ...(input.orgName === undefined ? {} : { orgName: input.orgName }),
        ...(input.orgRole === undefined ? {} : { orgRole: input.orgRole }),
      };
    },
    async save(account) {
      await options.vault.save(account);
      await options.vault.writeSelected(account.id);
    },
    async validate(accessToken) {
      try {
        await options.client.fetchCatalog(accessToken);
        return true;
      } catch {
        return false;
      }
    },
  });

  /** 当前账号对应的可用令牌；读不到就返回 undefined（不抛给界面）。 */
  const tokenOfSelected = async (): Promise<string | undefined> => {
    const account = await anyUsableAccount();
    if (account === undefined) return undefined;
    try {
      return await options.accounts.accessToken(account.id);
    } catch (error) {
      options.warn(`取账号令牌失败：${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  };

  /** 状态文档里「下一次请求实际会用谁」的理由文案。 */
  const effectiveOf = async (): Promise<{ id: string | undefined; reason: string }> => {
    const state = options.state();
    const selected = await options.vault.readSelected();
    const all = await options.vault.list();
    const candidates = all.map((account) => ({
      id: account.id,
      inPool: state.enabledAccounts.includes(account.id),
      usable: options.accounts.usability(account).usable,
      credits: undefined as number | undefined,
      nearestExpiryMs: undefined as number | undefined,
      expiresAtMs: account.expiresAtMs,
    }));
    // 这里不查余额：状态文档要快，余额由 UI 那一路异步补。
    const choice = pickAccount({
      poolEnabled: state.accountPoolEnabled,
      currentId: selected,
      candidates,
      nowMs: now(),
    });
    return { id: choice.id, reason: choice.reason };
  };

  const buildStatusDocument = async (): Promise<StatusDocument> => {
    const state = options.state();
    const selected = await options.vault.readSelected();
    const all = await options.vault.list();
    const effective = await effectiveOf();
    const entries = await Promise.all(
      all.map(async (account) => ({
        account,
        usable: options.accounts.usability(account),
        credits: await options.accounts.credits(account.id),
        cooldownMs: options.accounts.cooldownMs(account.id),
      })),
    );
    return buildStatus({
      provider: PROVIDER,
      enabled: options.config().enabled,
      nowMs: now(),
      desktop: desktopProbe,
      accounts: entries,
      currentAccountId: selected,
      effectiveAccountId: effective.id,
      effectiveReason: effective.reason,
      poolEnabled: state.accountPoolEnabled,
      memberIds: state.enabledAccounts,
      lastFailover,
      catalog: {
        source: catalog.source,
        fetchedAtMs: catalog.fetchedAtMs === 0 ? null : catalog.fetchedAtMs,
        error: catalogError,
        models: visibleModels(catalog.models, state.disabledModels),
      },
      login: login.view(),
      checkin: lastCheckin,
      state,
      reuseDesktop: options.config().reuseDesktop,
    });
  };

  /** 动作失败时抛出的错误带稳定 code（路由层把它放进响应）。 */
  const actionError = (code: string, message: string): RaccoonError =>
    Object.assign(new Error(message), { code }) as RaccoonError;

  /** 校验 body 里的账号 id 存在。 */
  /**
   * 把桌面端探测的分类码翻成一句能让用户立刻行动的话。
   *
   * @param code - `DesktopReason` 之一（也可能是 adoptDesktop 自己给的配置类原因）。
   * @returns 面向用户的一句话。
   */
  const desktopHint = (code: string): string => {
    switch (code) {
      case 'desktop-missing':
        return '本机没装小浣熊桌面端（找不到 ~/.box-agent/config/auth.json）。没有客户端就用「网页登录」或「扫码登录」';
      case 'desktop-unreadable':
        return '找到了客户端凭据文件，但没有读权限。检查文件权限，或用网页登录';
      case 'desktop-no-token':
        return '客户端凭据文件在，但里面没有可用的登录令牌 —— 先在小浣熊客户端里登录一次，再回来点这个按钮';
      case 'desktop-encrypted':
        return '客户端凭据是加密的，本插件解不开。请改用网页登录';
      default:
        return `没能从桌面端读到登录态（${code}）`;
    }
  };

  const requireAccountId = (body: Record<string, unknown>): string => {
    const id = body['accountId'];
    if (typeof id !== 'string' || id === '') throw actionError('bad-request', '缺少 accountId');
    return id;
  };

  /**
   * 读一个**可选**的字符串数组字段。
   *
   * 缺省返回 `undefined`（表示「全部/默认」）；给了但不是字符串数组就明确报错。
   * 不能像以前那样「不是数组就当没给」—— 那样界面传错类型时会被静默当成
   * 「导出全部」，用户以为只导了一个号，实际把整池都写进了文件。
   */
  const readOptionalIds = (body: Record<string, unknown>, field: string): string[] | undefined => {
    const value = body[field];
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) {
      throw actionError('bad-request', `${field} 必须是字符串数组`);
    }
    return value;
  };

  return {
    login,
    catalog: () => visibleModels(catalog.models, options.state().disabledModels),

    async status() {
      // 状态读得快：目录过期时才在后台刷新，不阻塞这一次响应。
      if (now() - catalog.fetchedAtMs > CATALOG_TTL_MS) {
        void tokenOfSelected().then((token) => refreshCatalog(token));
      }
      if (desktopProbe === null && options.config().reuseDesktop) {
        desktopProbe = await options.accounts.probeDesktop();
      }
      return await buildStatusDocument();
    },

    async run(action, body) {
      switch (action) {
        case 'refresh': {
          const force = body['force'] === true;
          if (desktopProbe === null || force) desktopProbe = await options.accounts.probeDesktop();
          await refreshCatalog(await tokenOfSelected());
          return { ok: true, status: await buildStatusDocument() };
        }

        case 'login-web':
          return { ok: true, login: await login.startWeb() };

        case 'login-qr':
          return { ok: true, login: await login.startQr() };

        case 'login-status':
          return { ok: true, login: login.view() };

        case 'cancel-login':
          await login.cancel();
          return { ok: true, login: login.view() };

        case 'login-code': {
          const text = body['text'];
          if (typeof text !== 'string' || text.trim() === '') {
            throw actionError('bad-request', '请粘贴授权码或整条回调地址');
          }
          const view: LoginView = await login.submitCode(text);
          return { ok: view.phase === 'done', login: view };
        }

        case 'adopt-desktop': {
          const probe = desktopProbe ?? (await options.accounts.probeDesktop());
          desktopProbe = probe;
          const adopted = await options.accounts.adoptDesktop(probe);
          if (!adopted.ok) {
            // 错误码是给程序看的，「没装客户端」和「装了但没登录」要给出不同的可执行建议，
            // 否则用户只会看到一句「没能读到登录态」，不知道该去装还是去登录。
            const code = adopted.reason ?? 'desktop-missing';
            throw actionError(code, desktopHint(code));
          }
          return { ok: true, accountId: adopted.account?.id, status: await buildStatusDocument() };
        }

        case 'switch-account': {
          await options.accounts.select(requireAccountId(body));
          return { ok: true, status: await buildStatusDocument() };
        }

        case 'remove-account': {
          const id = requireAccountId(body);
          await options.accounts.remove(id);
          const selected = await options.vault.readSelected();
          if (selected === id) {
            const remaining = await options.vault.list();
            await options.vault.writeSelected(remaining[0]?.id);
          }
          const state = options.state();
          if (state.enabledAccounts.includes(id)) {
            await options.saveState({ enabledAccounts: state.enabledAccounts.filter((item) => item !== id) });
          }
          return { ok: true, status: await buildStatusDocument() };
        }

        case 'members': {
          const ids = readOptionalIds(body, 'ids');
          if (ids === undefined) throw actionError('bad-request', '缺少 ids');
          const known = new Set((await options.vault.list()).map((account) => account.id));
          const filtered = ids.filter((id) => known.has(id));
          await options.saveState({ enabledAccounts: filtered });
          return { ok: true, status: await buildStatusDocument() };
        }

        case 'settings': {
          const patch = body['patch'];
          if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
            throw actionError('bad-request', 'patch 必须是对象');
          }
          const record = patch as Record<string, unknown>;
          const allowed: Partial<Omit<PluginState, 'schemaVersion'>> = {};
          if (Array.isArray(record['disabledModels'])) {
            allowed.disabledModels = record['disabledModels'].filter((item): item is string => typeof item === 'string');
          }
          if (typeof record['accountPoolEnabled'] === 'boolean') allowed.accountPoolEnabled = record['accountPoolEnabled'];
          if (typeof record['composerPill'] === 'boolean') allowed.composerPill = record['composerPill'];
          if (typeof record['pollIntervalMs'] === 'number') allowed.pollIntervalMs = record['pollIntervalMs'];
          if (typeof record['autoCheckin'] === 'boolean') allowed.autoCheckin = record['autoCheckin'];
          if (Array.isArray(record['enabledAccounts'])) {
            allowed.enabledAccounts = record['enabledAccounts'].filter((item): item is string => typeof item === 'string');
          }
          const next = await options.saveState(allowed);
          options.onCatalog?.(visibleModels(catalog.models, next.disabledModels));
          return { ok: true, status: await buildStatusDocument() };
        }

        case 'test-account': {
          const id = requireAccountId(body);
          const modelId = typeof body['modelId'] === 'string' ? body['modelId'] : undefined;
          const outcome = await testAccount(id, modelId);
          return { ok: outcome.outcome === 'ok', probe: outcome };
        }

        case 'checkin': {
          const ids = readOptionalIds(body, 'accountIds') ?? options.state().enabledAccounts;
          const results: Array<{ accountId: string; outcome: string; message: string }> = [];
          for (const id of ids) {
            results.push(await checkinOne(id));
          }
          lastCheckin = { lastRunAtMs: now(), results };
          return { ok: true, results };
        }

        case 'export-accounts': {
          const requested = readOptionalIds(body, 'accountIds');
          const all = await options.vault.list();
          const ids = requested ?? all.map((account) => account.id);
          const chosen = all.filter((account) => ids.includes(account.id));
          const preview = chosen.map((account) => ({
            id: account.id,
            nickname: account.nickname ?? null,
            identity: account.identity ?? null,
            orgName: account.orgName ?? null,
            source: account.source,
            expiresAtMs: account.expiresAtMs,
            hasAccessToken: account.accessToken !== '',
            hasRefreshToken: account.refreshToken !== '',
          }));
          // 令牌不进页面：完整导出写成一个文件，页面只拿脱敏预览与那个路径。
          const path = await writeExport(chosen);
          return {
            ok: true,
            count: chosen.length,
            path,
            text: JSON.stringify({ version: 1, accounts: preview }, null, 2),
          };
        }

        case 'import-accounts': {
          const text = body['text'];
          if (typeof text !== 'string' || text.trim() === '') {
            throw actionError('bad-request', '请粘贴导入内容');
          }
          const outcome = await importAccounts(text);
          return { ok: true, imported: outcome.imported, skipped: outcome.skipped };
        }

        default: {
          throw actionError('bad-request', `未知动作：${String(action)}`);
        }
      }
    },

    async warm() {
      if (disposed) return;
      if (options.config().reuseDesktop) {
        desktopProbe = await options.accounts.probeDesktop();
        if (desktopProbe.credential !== undefined) {
          await options.accounts.adoptDesktop(desktopProbe);
        }
      }
      await refreshCatalog(await tokenOfSelected());
    },

    dispose() {
      disposed = true;
      login.dispose();
    },
  };

  /** 测一个账号此刻可用性：发一次真实的最小对话（会花钱，所以按次点击）。 */
  async function testAccount(id: string, modelId?: string): Promise<{ accountId: string; outcome: string; message: string; atMs: number }> {
    const model = modelId ?? catalog.models[0]?.id ?? FALLBACK_CATALOG[0]?.id ?? 'sensenova-6.8-flash-lite';
    try {
      const token = await options.accounts.accessToken(id);
      const response = await options.client.chatStream({
        accessToken: token,
        body: {
          model,
          messages: [{ role: 'user', content: 'ping' }],
          stream: false,
          max_tokens: 1,
        },
      });
      await response.text().catch(() => '');
      return { accountId: id, outcome: 'ok', message: '可用', atMs: now() };
    } catch (error) {
      const failure = error instanceof RaccoonError ? error : undefined;
      const outcome =
        failure?.code === 'rate-limited'
          ? 'rate-limited'
          : failure?.code === 'out-of-credit'
            ? 'out-of-credit'
            : failure?.code === 'authorization-verify'
              ? 'rejected'
              : 'failed';
      return {
        accountId: id,
        outcome,
        message: error instanceof Error ? error.message : String(error),
        atMs: now(),
      };
    }
  }

  /** 给一个账号签到：先读状态避免重复领取，再触发一次发放。 */
  async function checkinOne(id: string): Promise<{ accountId: string; outcome: string; message: string }> {
    try {
      const token = await options.accounts.accessToken(id);
      const before = await options.client.fetchBills(token);
      const already = todayAlreadyClaimed(before, now());
      if (already) return { accountId: id, outcome: 'already', message: '今天已经领过' };
      await options.client.settingInfo(token);
      const after = await options.client.fetchBills(token);
      return todayAlreadyClaimed(after, now())
        ? { accountId: id, outcome: 'claimed', message: '已领取今日积分' }
        : { accountId: id, outcome: 'pending', message: '已请求发放，上游这次没有入账记录' };
    } catch (error) {
      return {
        accountId: id,
        outcome: 'failed',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 把选中的账号写成一份可迁移的 JSON 文件。
   *
   * 为什么要落文件而不是回给页面：完整的迁移需要令牌，而令牌不能进浏览器。
   * 返回值只有路径；页面显示的预览是脱敏的那份。
   *
   * @param accounts - 要导出的账号。
   * @returns 文件的绝对路径。
   */
  async function writeExport(accounts: readonly StoredAccount[]): Promise<string> {
    const dir = join(options.vault.rootDir(), 'exports');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `raccoon-accounts-${String(now())}.json`);
    const body = {
      version: 1,
      exportedAtMs: now(),
      accounts: accounts.map((account) => ({
        id: account.id,
        nickname: account.nickname ?? null,
        identity: account.identity ?? null,
        orgName: account.orgName ?? null,
        source: account.source,
        expiresAtMs: account.expiresAtMs,
        accessToken: account.accessToken,
        refreshToken: account.refreshToken,
      })),
    };
    await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return path;
  }

  /**
   * 把一段 JSON 里的账号导入仓库。
   *
   * 只接受**带令牌**的记录：脱敏导出（只有昵称与到期时间）无法回灌 —— 换台机器
   * 要恢复登录只能重新登录，这一点在 CONTRACT 里写明，不让用户以为导出是备份。
   *
   * @param text - 用户粘贴的 JSON。
   * @returns 导入与跳过的条数。
   */
  async function importAccounts(text: string): Promise<{ imported: number; skipped: number }> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw actionError('bad-request', '粘贴的内容不是合法 JSON');
    }
    if (parsed === null || typeof parsed !== 'object') throw actionError('bad-request', '粘贴的内容不是 JSON 对象');
    const list = (parsed as Record<string, unknown>)['accounts'];
    if (!Array.isArray(list)) throw actionError('bad-request', '缺少 accounts 数组');

    let imported = 0;
    let skipped = 0;
    for (const raw of list) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        skipped += 1;
        continue;
      }
      const record = raw as Record<string, unknown>;
      const accessToken = typeof record['accessToken'] === 'string' ? record['accessToken'].trim() : '';
      const refreshToken = typeof record['refreshToken'] === 'string' ? record['refreshToken'].trim() : '';
      if (accessToken === '') {
        // 脱敏记录只有展示字段：不计入错误，但要如实告诉用户「跳过了」。
        skipped += 1;
        continue;
      }
      const facts = decodeJwtFacts(accessToken);
      const refreshFacts = refreshToken === '' ? {} : decodeJwtFacts(refreshToken);
      const key = facts.accountKey ?? refreshFacts.accountKey ?? accessToken;
      const sourceRaw = record['source'];
      const source: StoredAccount['source'] =
        sourceRaw === 'web' || sourceRaw === 'qr' || sourceRaw === 'desktop' || sourceRaw === 'import'
          ? sourceRaw
          : 'import';
      const nicknameRaw = record['nickname'];
      await options.vault.save({
        schemaVersion: 1,
        id: accountIdFor(key),
        accountKey: key,
        accessToken,
        refreshToken,
        expiresAtMs: facts.expiresAtMs ?? 0,
        refreshExpiresAtMs: refreshFacts.expiresAtMs ?? 0,
        source,
        savedAtMs: now(),
        ...(typeof nicknameRaw === 'string' && nicknameRaw !== '' ? { nickname: nicknameRaw } : {}),
      });
      imported += 1;
    }
    if (imported === 0) {
      throw actionError('bad-request', '没有可导入的账号：粘贴的记录里没有访问令牌（脱敏导出不能回灌）');
    }
    return { imported, skipped };
  }
}
function todayAlreadyClaimed(bills: unknown, nowMs: number): boolean {
  const beijing = new Date(nowMs + 8 * 3600_000).toISOString().slice(0, 10);
  const text = JSON.stringify(bills);
  return text.includes(beijing);
}

/** 版本号（诊断页与启动日志用）。 */
export const RUNTIME_VERSION = VERSION;

/** 目录解析入口再导出：测试与 `index.ts` 共用同一份实现，避免两份解析。 */
export { parseCatalog };
