import test from 'node:test';
import assert from 'node:assert/strict';

import { buildStatus, type StatusDocument, type StatusInput } from '../src/host/status.ts';
import { DEFAULT_STATE, type PluginState } from '../src/state.ts';
import { accountIdFor, type StoredAccount } from '../src/credentials/vault.ts';
import type { CatalogModel } from '../src/protocol/catalog.ts';
import type { LoginView } from '../src/host/login.ts';

const NOW = 1_760_000_000_000;

/** 造一条仓库记录；id 由 accountKey 派生，与 vault 的规则一致。 */
function storedAccount(patch: { accountKey: string; nickname?: string; expiresAtMs?: number; source?: StoredAccount['source'] }): StoredAccount {
  return {
    schemaVersion: 1,
    id: accountIdFor(patch.accountKey),
    accountKey: patch.accountKey,
    accessToken: 'SECRET_A',
    refreshToken: 'SECRET_R',
    expiresAtMs: patch.expiresAtMs ?? 1_760_100_000_000,
    refreshExpiresAtMs: 1_760_260_000_000,
    source: patch.source ?? 'web',
    savedAtMs: 1_759_990_000_000,
    ...(patch.nickname === undefined ? {} : { nickname: patch.nickname }),
  };
}

const IDLE_LOGIN: LoginView = {
  running: false,
  kind: 'web',
  phase: 'waiting',
  message: '',
  url: null,
  port: null,
  qrSvg: null,
  expiresAtMs: null,
  error: null,
};

/** 一条目录模型；未写的字段取保守默认。 */
function catalogModel(patch: Partial<CatalogModel> & { id: string }): CatalogModel {
  return {
    id: patch.id,
    name: patch.name ?? patch.id,
    vision: false,
    contextWindow: 131_072,
    maxTokens: 8_192,
    multiplier: 'x1.00',
    reasoning: false,
    ...patch,
  };
}

/** 一份最小可用的 buildStatus 输入；用 patch 覆盖需要变化的字段。 */
function statusInput(patch: Partial<StatusInput> = {}): StatusInput {
  return {
    provider: 'raccoon',
    enabled: true,
    nowMs: NOW,
    desktop: null,
    accounts: [],
    currentAccountId: undefined,
    effectiveAccountId: undefined,
    effectiveReason: '账号池未启用，使用当前选用的账号',
    poolEnabled: false,
    memberIds: [],
    lastFailover: null,
    catalog: { source: 'live', fetchedAtMs: NOW, error: null, models: [] },
    login: IDLE_LOGIN,
    checkin: { lastRunAtMs: null, results: [] },
    state: { ...DEFAULT_STATE } as PluginState,
    reuseDesktop: true,
    ...patch,
  };
}

test('buildStatus：顶层字段集合 → 恰好等于 docs/CONTRACT.md §二 列出的那些', () => {
  // 手抄自 docs/CONTRACT.md §二 的 JSON 示例顶层键。
  const expected = [
    'schemaVersion',
    'version',
    'provider',
    'enabled',
    'updatedAtMs',
    'desktop',
    'accounts',
    'currentAccountId',
    'effectiveAccountId',
    'effectiveReason',
    'pool',
    'catalog',
    'login',
    'checkin',
    'state',
  ].sort();
  const doc = buildStatus(statusInput());
  assert.deepEqual(Object.keys(doc).sort(), expected, '状态文档的顶层字段多一个或少一个都会让页面静默空白');
});

test('buildStatus：令牌绝不出现在文档里 → accessToken / refreshToken 原值不被序列化', () => {
  const account = storedAccount({ accountKey: 'key-secret', nickname: '带密钥的账号' });
  assert.equal(account.accessToken, 'SECRET_A', '测试前提：账号里的 access token 就是 SECRET_A');
  assert.equal(account.refreshToken, 'SECRET_R', '测试前提：账号里的 refresh token 就是 SECRET_R');
  const doc = buildStatus(statusInput({ accounts: [{ account, usable: { usable: true }, credits: undefined, cooldownMs: 0 }] }));
  assert.equal(doc.accounts.length, 1, '账号应出现在文档里');
  const serialized = JSON.stringify(doc);
  assert.equal(serialized.includes('SECRET_A'), false, '状态文档里不得出现 access token');
  assert.equal(serialized.includes('SECRET_R'), false, '状态文档里不得出现 refresh token');
});

test('buildStatus：credits 读不到 → 是 null 而不是 {total:0}', () => {
  const account = storedAccount({ accountKey: 'key-no-credits' });
  const doc = buildStatus(statusInput({ accounts: [{ account, usable: { usable: true }, credits: undefined, cooldownMs: 0 }] }));
  const view = doc.accounts[0];
  assert.equal(view?.credits, null, `余额读不到时应为 null，实际是 ${JSON.stringify(view?.credits)}`);
});

test('buildStatus：账号排序 → 当前选用第一，其余池成员在前，再按 expiresAtMs 升序', () => {
  const current = storedAccount({ accountKey: 'key-current', expiresAtMs: 1_760_900_000_000 });
  const poolLater = storedAccount({ accountKey: 'key-pool-later', expiresAtMs: 1_760_500_000_000 });
  const poolEarlier = storedAccount({ accountKey: 'key-pool-earlier', expiresAtMs: 1_760_200_000_000 });
  const other = storedAccount({ accountKey: 'key-other', expiresAtMs: 1_760_100_000_000 });
  const doc = buildStatus(
    statusInput({
      accounts: [other, poolLater, current, poolEarlier].map((account) => ({
        account,
        usable: { usable: true },
        credits: undefined,
        cooldownMs: 0,
      })),
      currentAccountId: current.id,
      memberIds: [poolLater.id, poolEarlier.id],
    }),
  );
  assert.deepEqual(
    doc.accounts.map((view) => view.id),
    [current.id, poolEarlier.id, poolLater.id, other.id],
    '顺序应是「当前 → 池成员（按到期升序）→ 其余」',
  );
  assert.equal(doc.accounts[0]?.isCurrent, true, '排第一的应是当前选用账号');
});

test('buildStatus：multiAccount 恒为 false → 无论桌面端探测结果如何', () => {
  const noDesktop = buildStatus(statusInput());
  assert.equal(noDesktop.desktop.multiAccount, false, '没有桌面端时 multiAccount 也应为 false');
  const withDesktop = buildStatus(
    statusInput({
      desktop: {
        configDir: 'C:\\Users\\x\\.box-agent\\config',
        authPath: 'C:\\Users\\x\\.box-agent\\config\\auth.json',
        exists: true,
        readable: true,
        multiAccount: false,
        reason: null,
        keyOrderMatchesApp: true,
        credential: { accessToken: 'SECRET_A', refreshToken: 'SECRET_R', rawKeys: [] },
      },
    }),
  );
  assert.equal(withDesktop.desktop.multiAccount, false, '桌面端一个文件一份登录态，multiAccount 恒为 false');
  assert.equal(withDesktop.desktop.detected, true, '有凭据时 detected 应为 true');
});

test('buildStatus：catalog.models[].enabled → 与 state.disabledModels 相反', () => {
  const doc = buildStatus(
    statusInput({
      catalog: {
        source: 'live',
        fetchedAtMs: NOW,
        error: null,
        models: [catalogModel({ id: 'model-kept' }), catalogModel({ id: 'model-disabled' })],
      },
      state: { ...DEFAULT_STATE, disabledModels: ['model-disabled'] } as PluginState,
    }),
  );
  const byId = new Map(doc.catalog.models.map((model) => [model.id, model.enabled]));
  assert.equal(byId.get('model-kept'), true, '不在禁用名单里的模型应 enabled=true');
  assert.equal(byId.get('model-disabled'), false, '在禁用名单里的模型应 enabled=false');
});

test('buildStatus：空目录 → models 为空、count 为 0 且不抛', () => {
  const doc: StatusDocument = buildStatus(statusInput({ catalog: { source: 'fallback', fetchedAtMs: null, error: '目录拉取失败', models: [] } }));
  assert.equal(doc.catalog.count, 0, '空目录的 count 应为 0');
  assert.deepEqual(doc.catalog.models, [], '空目录时 models 应是空数组');
  assert.equal(doc.catalog.source, 'fallback', '来源应如实透传');
  assert.equal(doc.catalog.error, '目录拉取失败', '目录错误应如实透传');
});

test('desktop 昵称来自 credential.nickname：探测解出 JWT 的 name 后，状态里就该显示它', () => {
  // 昵称曾经错取 identity（那是内部 id，不是给人看的名字）。
  const status = buildStatus(statusInput({
    desktop: {
      configDir: '/tmp/.box-agent/config',
      authPath: '/tmp/.box-agent/config/auth.json',
      exists: true,
      readable: true,
      multiAccount: false,
      reason: null,
      keyOrderMatchesApp: true,
      credential: {
        accessToken: 'a',
        refreshToken: 'r',
        rawKeys: [],
        identity: 'identity-1',
        nickname: '桌面小王',
      },
    },
  }));
  assert.equal(status.desktop.nickname, '桌面小王', '昵称必须取自 credential.nickname，而不是 identity');
  assert.equal(status.desktop.detected, true, '读到了凭据就是 detected');
  assert.equal(status.desktop.adopted, false, '还没采纳进池时 adopted 应为 false');
});

test('buildStatus：state 必须透出 PluginState 的全部字段', () => {
  // 这份文档是浏览器半边唯一的真值来源。任何字段被「手工抄写」漏掉，
  // 对应控件的「已勾选」判断就读不到真值 —— 典型表现是复选框点不动 /
  // 取消不掉（`showHiddenModels` 就这么漏过一次：磁盘上是 true，
  // /status 里没有这个键，客户端恒读成 false，于是每次点击都发 true）。
  const state: PluginState = { ...DEFAULT_STATE, showHiddenModels: true };
  const doc = buildStatus(statusInput({ state }));

  const missing = Object.keys(DEFAULT_STATE).filter((key) => !(key in doc.state));
  assert.deepEqual(missing, [], `status.state 漏掉了字段：${missing.join(', ')}`);
  assert.equal(doc.state.showHiddenModels, true, 'showHiddenModels 必须透传真实值');
  assert.equal(doc.state.reuseDesktop, true, 'reuseDesktop 仍需保留（来自配置而非状态）');
});

test('buildStatus：state 里的数组是拷贝，不与内存态共享引用', () => {
  // 序列化出去的文档若和内存态共享数组，调用方 push 一下就会改到插件内部状态。
  const state: PluginState = { ...DEFAULT_STATE, disabledModels: ['a'], enabledAccounts: ['acc_1'] };
  const doc = buildStatus(statusInput({ state }));
  doc.state.disabledModels.push('b');
  doc.state.enabledAccounts.push('acc_2');
  assert.deepEqual(state.disabledModels, ['a'], 'disabledModels 被外部改动污染了内存态');
  assert.deepEqual(state.enabledAccounts, ['acc_1'], 'enabledAccounts 被外部改动污染了内存态');
});
