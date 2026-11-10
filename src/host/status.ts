/**
 * 状态文档：浏览器半边唯一能读到的数据形状。
 *
 * 这里是 `docs/CONTRACT.md` 里那份 JSON 的**唯一生产者**。字段只增不改 ——
 * 页面没有类型检查，少一个字段不会报错，只会显示空白，所以契约文件与本文件
 * 必须一起改。
 *
 * 不变量：文档里**永不出现** access token / refresh token / cookie。
 *
 * @module dsh-connect-raccoon/host/status
 */

import { VERSION } from '../constants.ts';
import type { CatalogModel } from '../protocol/catalog.ts';
import type { LoginView } from './login.ts';
import type { Balance } from '../protocol/client.ts';
import type { DesktopProbe } from '../credentials/desktop.ts';
import type { StoredAccount } from '../credentials/vault.ts';
import type { PluginState } from '../state.ts';

/** 一条账号的展示形状。 */
export interface AccountView {
  id: string;
  label: string;
  nickname: string | null;
  identity: string | null;
  orgName: string | null;
  source: StoredAccount['source'];
  isDesktopSource: boolean;
  expiresAtMs: number;
  refreshExpiresAtMs: number;
  usable: boolean;
  reason: string | null;
  inPool: boolean;
  isCurrent: boolean;
  credits: { total: number; expiringSoon: number; nearestExpiryMs: number | null; fetchedAtMs: number } | null;
  lastProbe: { outcome: string; message: string; atMs: number } | null;
  cooldownUntilMs: number | null;
  canCheckin: boolean;
}

/** 一条模型的展示形状。 */
export interface ModelView {
  id: string;
  name: string;
  description: string | null;
  vision: boolean;
  contextWindow: number;
  maxTokens: number;
  multiplier: string;
  promo: string | null;
  reasoning: boolean;
  /** 上游标记为未公开（`visible:false`）；界面据此加提示，不改变可用性。 */
  hidden: boolean;
  enabled: boolean;
}

/** 状态文档。 */
export interface StatusDocument {
  schemaVersion: 1;
  version: string;
  provider: string;
  enabled: boolean;
  updatedAtMs: number;
  desktop: {
    detected: boolean;
    configDir: string;
    authPath: string;
    exists: boolean;
    readable: boolean;
    multiAccount: false;
    reason: string | null;
    nickname: string | null;
    expiresAtMs: number | null;
    keyOrderMatchesApp: boolean;
    adopted: boolean;
  };
  accounts: AccountView[];
  currentAccountId: string | null;
  effectiveAccountId: string | null;
  effectiveReason: string;
  pool: {
    enabled: boolean;
    memberIds: string[];
    lastFailover: { atMs: number; fromId: string; toId: string; reason: string } | null;
  };
  catalog: {
    source: 'live' | 'saved' | 'fallback';
    count: number;
    fetchedAtMs: number | null;
    error: string | null;
    models: ModelView[];
  };
  login: LoginView;
  checkin: {
    supported: boolean;
    lastRunAtMs: number | null;
    results: Array<{ accountId: string; outcome: string; message: string }>;
  };
  /**
   * 完整插件状态 + 配置项 `reuseDesktop`。
   *
   * **不要在这里逐字段抄写**：这份文档是浏览器半边唯一的真值来源，
   * 抄漏一个字段就会让对应控件的「已勾选」判断永远读不到真值 ——
   * 典型表现是复选框点不动 / 取消不掉（`showHiddenModels` 就这么漏过一次）。
   * 直接复用 {@link PluginState}，加字段时不用改这里。
   */
  state: PluginState & { reuseDesktop: boolean };
}

/** 构建状态文档所需的全部输入。 */
export interface StatusInput {
  provider: string;
  enabled: boolean;
  nowMs: number;
  desktop: DesktopProbe | null;
  accounts: Array<{
    account: StoredAccount;
    usable: { usable: boolean; reason?: string };
    credits: Balance | undefined;
    creditsAtMs?: number;
    cooldownMs: number;
  }>;
  currentAccountId: string | undefined;
  effectiveAccountId: string | undefined;
  effectiveReason: string;
  poolEnabled: boolean;
  memberIds: readonly string[];
  lastFailover: { atMs: number; fromId: string; toId: string; reason: string } | null;
  catalog: {
    source: 'live' | 'saved' | 'fallback';
    fetchedAtMs: number | null;
    error: string | null;
    models: readonly CatalogModel[];
  };
  login: LoginView;
  checkin: {
    lastRunAtMs: number | null;
    results: Array<{ accountId: string; outcome: string; message: string }>;
  };
  state: PluginState;
  reuseDesktop: boolean;
}

/** 账号在列表里的排序：当前 → 池成员 → 其余，再按到期时间升序。 */
function sortAccounts(views: AccountView[], currentId: string | undefined): AccountView[] {
  return [...views].sort((left, right) => {
    if (left.id === currentId && right.id !== currentId) return -1;
    if (right.id === currentId && left.id !== currentId) return 1;
    if (left.inPool !== right.inPool) return left.inPool ? -1 : 1;
    return left.expiresAtMs - right.expiresAtMs;
  });
}

/** 把一条仓库记录转成页面用的形状。 */
function toAccountView(input: {
  account: StoredAccount;
  usable: { usable: boolean; reason?: string };
  credits: Balance | undefined;
  creditsAtMs?: number;
  cooldownMs: number;
  currentId: string | undefined;
  inPool: boolean;
  nowMs: number;
}): AccountView {
  const { account } = input;
  const nickname = account.nickname ?? null;
  const label = nickname ?? `${account.source === 'desktop' ? '桌面端' : '小浣熊'}账号 · ${account.id.slice(-6)}`;
  return {
    id: account.id,
    label,
    nickname,
    identity: account.identity ?? null,
    orgName: account.orgName ?? null,
    source: account.source,
    isDesktopSource: account.source === 'desktop',
    expiresAtMs: account.expiresAtMs,
    refreshExpiresAtMs: account.refreshExpiresAtMs,
    usable: input.usable.usable,
    reason: input.usable.reason ?? null,
    inPool: input.inPool,
    isCurrent: input.currentId === account.id,
    credits:
      input.credits === undefined
        ? null
        : {
            total: input.credits.total,
            expiringSoon: input.credits.expiringSoon,
            nearestExpiryMs: input.credits.nearestExpiryMs ?? null,
            fetchedAtMs: input.creditsAtMs ?? 0,
          },
    lastProbe: account.probe ?? null,
    // 冷却截止时间与 `updatedAtMs` 用同一个时钟：状态文档要能在回放里复现。
    cooldownUntilMs: input.cooldownMs > 0 ? input.nowMs + input.cooldownMs : null,
    canCheckin: account.identity !== 'enterprise' && account.identity !== 'education',
  };
}

/**
 * 构建状态文档。
 *
 * @param input - 当前全部运行时事实。
 * @returns 可直接下发给页面的文档。
 */
export function buildStatus(input: StatusInput): StatusDocument {
  const memberIds = new Set(input.memberIds);
  const views = input.accounts.map((entry) =>
    toAccountView({
      account: entry.account,
      usable: entry.usable,
      credits: entry.credits,
      ...(entry.creditsAtMs === undefined ? {} : { creditsAtMs: entry.creditsAtMs }),
      cooldownMs: entry.cooldownMs,
      currentId: input.currentAccountId,
      inPool: memberIds.has(entry.account.id),
      nowMs: input.nowMs,
    }),
  );
  const desktop = input.desktop;
  // 「已收进池」= 池里存在一条来自桌面端的记录；不看昵称（昵称可能读不到）。
  const adopted = views.some((view) => view.isDesktopSource);

  return {
    schemaVersion: 1,
    version: VERSION,
    provider: input.provider,
    enabled: input.enabled,
    updatedAtMs: input.nowMs,
    desktop: {
      detected: desktop?.credential !== undefined,
      configDir: desktop?.configDir ?? '',
      authPath: desktop?.authPath ?? '',
      exists: desktop?.exists ?? false,
      readable: desktop?.readable ?? false,
      multiAccount: false,
      reason: desktop?.reason ?? null,
      nickname: desktop?.credential?.nickname ?? null,
      expiresAtMs: desktop?.credential?.expiresAtMs ?? null,
      keyOrderMatchesApp: desktop?.keyOrderMatchesApp ?? false,
      adopted,
    },
    accounts: sortAccounts(views, input.currentAccountId),
    currentAccountId: input.currentAccountId ?? null,
    effectiveAccountId: input.effectiveAccountId ?? null,
    effectiveReason: input.effectiveReason,
    pool: {
      enabled: input.poolEnabled,
      memberIds: [...input.memberIds],
      lastFailover: input.lastFailover,
    },
    catalog: {
      source: input.catalog.source,
      count: input.catalog.models.length,
      fetchedAtMs: input.catalog.fetchedAtMs,
      error: input.catalog.error,
      models: input.catalog.models.map((model) => ({
        id: model.id,
        name: model.name,
        description: model.description ?? null,
        vision: model.vision,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        multiplier: model.multiplier,
        promo: model.promo ?? null,
        reasoning: model.reasoning,
        hidden: model.hidden,
        enabled: !input.state.disabledModels.includes(model.id),
      })),
    },
    login: input.login,
    checkin: {
      supported: views.some((view) => view.canCheckin),
      lastRunAtMs: input.checkin.lastRunAtMs,
      results: input.checkin.results,
    },
    state: {
      ...input.state,
      // 数组做一次拷贝：这份文档会被序列化给别人，不该和内存态共享引用。
      disabledModels: [...input.state.disabledModels],
      enabledAccounts: [...input.state.enabledAccounts],
      reuseDesktop: input.reuseDesktop,
    },
  };
}
