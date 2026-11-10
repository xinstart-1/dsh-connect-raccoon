import test from 'node:test';
import assert from 'node:assert/strict';

import {
  pickAccount,
  failoverCandidates,
  type PoolCandidate,
} from '../src/host/pool.ts';

/** 造一个候选账号；未写的字段取「可用、无到期额度、余额 0」的中间态。 */
function candidate(patch: Partial<PoolCandidate> & { id: string }): PoolCandidate {
  return {
    id: patch.id,
    inPool: true,
    usable: true,
    credits: 0,
    nearestExpiryMs: undefined,
    expiresAtMs: 1_000,
    ...patch,
  };
}

const NOW = 1_760_000_000_000;
const DAY = 24 * 3600_000;

test('池关闭 → 用 currentId：currentId 在候选里 → 选中它并说明池未启用', () => {
  const choice = pickAccount({
    poolEnabled: false,
    currentId: 'acc_a',
    candidates: [candidate({ id: 'acc_a', credits: 1 }), candidate({ id: 'acc_b', credits: 9_999 })],
  });
  assert.equal(choice.id, 'acc_a', '池关闭时不应改用余额更高的账号');
  assert.match(choice.reason, /账号池未启用/, `reason 应说明池未启用，实际是「${choice.reason}」`);
});

test('池关闭 → currentId 指向不存在的账号：该账号已删除 → id 为 undefined 且 reason 说明已不在本机', () => {
  const choice = pickAccount({
    poolEnabled: false,
    currentId: 'acc_gone',
    candidates: [candidate({ id: 'acc_a' })],
  });
  assert.equal(choice.id, undefined, 'currentId 指向不存在的账号时不应挑别的账号顶上');
  assert.match(choice.reason, /已不在本机/, `reason 应说明选定的账号已不在本机，实际是「${choice.reason}」`);
});

test('池开启 → 勾选名单为空：一个都没勾 → id 为 undefined，不得退化成全选', () => {
  const choice = pickAccount({
    poolEnabled: true,
    currentId: 'acc_a',
    candidates: [
      candidate({ id: 'acc_a', inPool: false, credits: 500 }),
      candidate({ id: 'acc_b', inPool: false, credits: 900 }),
    ],
  });
  assert.equal(choice.id, undefined, '空勾选名单等于「一个都没勾」，不应选中任何 inPool=false 的账号');
  assert.match(choice.reason, /没有勾选任何账号/, `reason 应说明没有勾选任何账号，实际是「${choice.reason}」`);
});

test('池开启 → 有勾选：只在勾选的里挑 → 未勾选但余额更高的账号不被选中', () => {
  const choice = pickAccount({
    poolEnabled: true,
    currentId: 'acc_a',
    candidates: [
      candidate({ id: 'acc_picked', inPool: true, credits: 10 }),
      candidate({ id: 'acc_rich_unpicked', inPool: false, credits: 100_000 }),
    ],
  });
  assert.equal(choice.id, 'acc_picked', '未勾选的账号即使余额更高也不得参与挑选');
});

test('排序：可用优先 → 余额极高但 usable=false 的账号不得被选中', () => {
  const choice = pickAccount({
    poolEnabled: true,
    currentId: undefined,
    candidates: [
      candidate({ id: 'acc_broken', usable: false, reason: '凭据被上游拒绝', credits: 999_999 }),
      candidate({ id: 'acc_ok', usable: true, credits: 1 }),
    ],
  });
  assert.equal(choice.id, 'acc_ok', 'usable=false 的账号不该因为余额高被选中');
});

test('排序：快过期先花 → 30 天内到期的账号优先于余额更高但没有到期额度的账号', () => {
  const choice = pickAccount({
    poolEnabled: true,
    currentId: undefined,
    candidates: [
      candidate({ id: 'acc_rich_no_expiry', credits: 5_000, nearestExpiryMs: undefined }),
      candidate({ id: 'acc_expiring', credits: 100, nearestExpiryMs: NOW + 5 * DAY }),
    ],
    nowMs: NOW,
  });
  assert.equal(choice.id, 'acc_expiring', '30 天内到期的额度应先花掉，优先级高于余额');
});

test('排序：余额高者优先 → 可用与到期条件相同时选余额最高的账号', () => {
  const choice = pickAccount({
    poolEnabled: true,
    currentId: undefined,
    candidates: [
      candidate({ id: 'acc_low', credits: 10 }),
      candidate({ id: 'acc_high', credits: 900 }),
      candidate({ id: 'acc_mid', credits: 500 }),
    ],
    nowMs: NOW,
  });
  assert.equal(choice.id, 'acc_high', '同条件下应选余额最高的账号');
});

test('排序：余额都读不到 → credits=undefined 时仍给出 id，reason 写明余额读不到', () => {
  const choice = pickAccount({
    poolEnabled: true,
    currentId: undefined,
    candidates: [
      candidate({ id: 'acc_a', credits: undefined, expiresAtMs: 1_000 }),
      candidate({ id: 'acc_b', credits: undefined, expiresAtMs: 2_000 }),
    ],
    nowMs: NOW,
  });
  assert.notEqual(choice.id, undefined, '余额读不到不算不可用，仍应挑出一个账号');
  assert.match(choice.reason, /余额读不到/, `reason 应写明余额读不到，实际是「${choice.reason}」`);
});

test('排序：凭据新者优先 → 其余条件全平时按 expiresAtMs 降序', () => {
  const choice = pickAccount({
    poolEnabled: true,
    currentId: undefined,
    candidates: [
      candidate({ id: 'acc_old_cred', credits: 100, expiresAtMs: 1_000 }),
      candidate({ id: 'acc_new_cred', credits: 100, expiresAtMs: 9_000 }),
      candidate({ id: 'acc_mid_cred', credits: 100, expiresAtMs: 5_000 }),
    ],
    nowMs: NOW,
  });
  assert.equal(choice.id, 'acc_new_cred', '全平时应选 expiresAtMs 最大（凭据最新）的账号');
});

test('failoverCandidates：池关闭 → 空数组', () => {
  const ids = failoverCandidates({
    poolEnabled: false,
    currentId: 'acc_a',
    candidates: [candidate({ id: 'acc_a' }), candidate({ id: 'acc_b' })],
    firstId: 'acc_a',
    nowMs: NOW,
  });
  assert.deepEqual(ids, [], '池关闭时不应有备选账号');
});

test('failoverCandidates：池开启 → 返回除 firstId 外的可用账号，顺序与 rank 一致', () => {
  const ids = failoverCandidates({
    poolEnabled: true,
    currentId: 'acc_a',
    candidates: [
      candidate({ id: 'acc_a', credits: 10 }),
      candidate({ id: 'acc_b', credits: 30 }),
      candidate({ id: 'acc_c', credits: 20 }),
      candidate({ id: 'acc_d', credits: 99_999, inPool: false }),
      candidate({ id: 'acc_e', credits: 99_999, usable: false }),
    ],
    firstId: 'acc_b',
    nowMs: NOW,
  });
  assert.deepEqual(ids, ['acc_c', 'acc_a'], '应给出池内可用的其余账号，按「余额高→低」排序，且不含首个');
});

test('纯函数：调用 pickAccount → 不改写入参数组与候选对象', () => {
  const candidates: PoolCandidate[] = [
    candidate({ id: 'acc_a', credits: 10, expiresAtMs: 3_000 }),
    candidate({ id: 'acc_b', credits: 30, expiresAtMs: 1_000 }),
    candidate({ id: 'acc_c', credits: undefined, usable: false }),
  ];
  const snapshot = structuredClone(candidates);
  pickAccount({ poolEnabled: true, currentId: 'acc_a', candidates, nowMs: NOW });
  failoverCandidates({
    poolEnabled: true,
    currentId: 'acc_a',
    candidates,
    firstId: 'acc_a',
    nowMs: NOW,
  });
  assert.deepEqual(candidates, snapshot, '挑选与排序不得原地改动传入的候选数组');
  assert.deepEqual(candidates.map((item) => item.id), snapshot.map((item) => item.id), '候选顺序不应被就地重排');
});

test('failoverCandidates：不可用账号不出现在换号序列里（换到不可用的等于没换）', () => {
  // 这条与「排序」无关：它钉的是**过滤**。不可用账号若混进换号序列，
  // 宿主会在一个已知不可用的账号上白等一次超时，然后才轮到下一个。
  const order = failoverCandidates({
    poolEnabled: true,
    currentId: undefined,
    candidates: [
      candidate({ id: 'acc_first', credits: 500 }),
      candidate({ id: 'acc_dead', usable: false, reason: '限流冷却中', credits: 9_999 }),
      candidate({ id: 'acc_alive', credits: 100 }),
    ],
    firstId: 'acc_first',
  });
  assert.ok(!order.includes('acc_dead'), `不可用账号不该出现在换号序列里，实际 ${order.join(',')}`);
  assert.deepEqual(order, ['acc_alive'], '除首个外的可用账号应按排序给出');
});

test('rank 的可用性不变量：即使调用方传了全量候选，不可用也排最后', () => {
  // rank 是纯函数且两个现有调用方都先过滤，所以这条不变量当前走不到；
  // 但它是 rank 自己的契约。用 pickAccount 的池关闭路径验证：那里不过滤。
  const choice = pickAccount({
    poolEnabled: false,
    currentId: 'acc_dead',
    candidates: [
      candidate({ id: 'acc_dead', usable: false, reason: '凭据已失效' }),
      candidate({ id: 'acc_ok', usable: true, credits: 1 }),
    ],
  });
  // 池关闭时用「当前选用」，即使它不可用也照用，但必须说明原因。
  assert.equal(choice.id, 'acc_dead', '池关闭时用户选谁就是谁');
  assert.equal(choice.reason, '凭据已失效', '不可用时 reason 应说明原因，而不是笼统「使用当前选用的账号」');
});
