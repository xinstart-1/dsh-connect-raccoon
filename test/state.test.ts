import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { STATE_FILENAME } from '../src/constants.ts';
import { DEFAULT_STATE, readState, writeState } from '../src/state.ts';

/** 每个 test 一个独立临时 home，跑完删掉。 */
async function freshHome(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'raccoon-state-'));
  t.after(async () => { await rm(home, { recursive: true, force: true }); });
  return home;
}

test('readState：文件不存在 → 返回默认值（池默认关、账单开关默认开）', async (t) => {
  const home = await freshHome(t);
  const state = await readState({ home });
  assert.deepEqual(state, { ...DEFAULT_STATE }, '状态文件不存在时应返回完整默认值');
  assert.equal(state.accountPoolEnabled, false, '默认不应自动挑账号花用户的额度');
  assert.equal(state.autoCheckin, false, '默认不应自动签到（写操作）');
  assert.equal(state.composerPill, true, '输入框积分读数默认开');
  assert.equal(state.pollIntervalMs, 60_000, '默认刷新间隔应为 60000ms');
  assert.deepEqual(state.enabledAccounts, [], '默认勾选名单为空');
  assert.deepEqual(state.disabledModels, [], '默认没有禁用模型');
});

test('writeState：合并语义 → 先写 composerPill=false 再写 autoCheckin=true，两者都生效', async (t) => {
  const home = await freshHome(t);
  const first = await writeState({ composerPill: false }, { home });
  assert.equal(first.composerPill, false, '第一次写入应返回 composerPill=false 的完整状态');
  const second = await writeState({ autoCheckin: true }, { home });
  assert.equal(second.autoCheckin, true, '第二次写入应生效 autoCheckin=true');
  assert.equal(second.composerPill, false, '第二次写入不得把上一次的 composerPill 覆盖回默认值');
  const reread = await readState({ home });
  assert.equal(reread.composerPill, false, '重新读盘后 composerPill 应仍是 false');
  assert.equal(reread.autoCheckin, true, '重新读盘后 autoCheckin 应仍是 true');
});

test('readState：坏 JSON → 读回默认值且不抛', async (t) => {
  const home = await freshHome(t);
  await mkdir(home, { recursive: true });
  await writeFile(join(home, STATE_FILENAME), '{ "composerPill": fal', 'utf8');
  const state = await readState({ home });
  assert.deepEqual(state, { ...DEFAULT_STATE }, '坏 JSON 应被判为「没有状态」而不是抛错');
});

test('readState：非法 pollIntervalMs → 收敛成默认 60000', async (t) => {
  const home = await freshHome(t);
  await mkdir(home, { recursive: true });
  await writeFile(join(home, STATE_FILENAME), JSON.stringify({ pollIntervalMs: 12345 }), 'utf8');
  const state = await readState({ home });
  assert.equal(state.pollIntervalMs, 60_000, '不在五档里的刷新间隔应回落成 60000，实际是 ' + String(state.pollIntervalMs));
});

test('readState：enabledAccounts 里的非字符串 → 被过滤掉，只保留字符串', async (t) => {
  const home = await freshHome(t);
  await mkdir(home, { recursive: true });
  await writeFile(
    join(home, STATE_FILENAME),
    JSON.stringify({ enabledAccounts: ['acc_a', 42, null, { id: 'acc_b' }, 'acc_c'] }),
    'utf8',
  );
  const state = await readState({ home });
  assert.deepEqual(state.enabledAccounts, ['acc_a', 'acc_c'], '非字符串成员应被丢弃，不应变成 "42" 之类');
});

test('writeState：写盘结果 → 文件是合法 JSON 且 schemaVersion 为 1', async (t) => {
  const home = await freshHome(t);
  await writeState({ enabledAccounts: ['acc_a'], pollIntervalMs: 300_000 }, { home });
  const text = await readFile(join(home, STATE_FILENAME), 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    assert.fail(`状态文件不是合法 JSON：${text.slice(0, 120)}`);
  }
  assert.equal(typeof parsed, 'object', '状态文件顶层应是对象');
  const record = parsed as Record<string, unknown>;
  assert.equal(record['schemaVersion'], 1, '写出的状态必须带 schemaVersion=1');
  assert.deepEqual(record['enabledAccounts'], ['acc_a'], '写入的勾选名单应原样落盘');
  assert.equal(record['pollIntervalMs'], 300_000, '合法刷新间隔应原样落盘');
  assert.match(text, /\n$/, '状态文件应以换行结尾（便于人读与 diff）');
});
