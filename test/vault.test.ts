import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import type { StoredAccount } from '../src/credentials/vault.ts';
import { accountIdFor, createVault, decodeJwtFacts } from '../src/credentials/vault.ts';
import { VAULT_DIRNAME } from '../src/constants.ts';

/** 每个测试自建临时目录，结束时整棵删除。 */
async function temporaryHome(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'raccoon-vault-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** 造一条合法记录；`id` 必须与 `accountKey` 对得上，否则仓库会当成损坏记录忽略。 */
function account(accountKey: string, overrides: Partial<StoredAccount> = {}): StoredAccount {
  return {
    schemaVersion: 1,
    id: accountIdFor(accountKey),
    accountKey,
    accessToken: 'access-a',
    refreshToken: 'refresh-a',
    expiresAtMs: 1_700_000_000_000,
    refreshExpiresAtMs: 1_700_500_000_000,
    source: 'web',
    savedAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

/** 把任意值写成 `accounts/<id>.json`，用于制造仓库不认识的磁盘内容。 */
async function seedRaw(home: string, id: string, body: string): Promise<void> {
  const accountsDir = join(home, VAULT_DIRNAME, 'accounts');
  await mkdir(accountsDir, { recursive: true });
  await writeFile(join(accountsDir, `${id}.json`), body, 'utf8');
}

/** 拼一个真 JWT（只做 base64url，不验签）。 */
function makeJwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.${encode({ sig: 'x' })}`;
}

test('save→list→get 往返：写入一个账号后 → list() 能读回且 get(id) 字段一致', async (t) => {
  const vault = createVault({ home: await temporaryHome(t) });
  const written = account('key-roundtrip', {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    identity: 'personal',
    orgName: '商汤',
    orgRole: 'owner',
    nickname: '小浣熊用户',
    desktopPath: '/tmp/auth.json',
    probe: { outcome: 'ok', message: '可用', atMs: 1_700_000_000_000 },
  });
  await vault.save(written);

  const listed = await vault.list();
  assert.equal(listed.length, 1, 'list() 应只有刚写入的 1 个账号');
  assert.deepEqual(listed[0], written, 'list() 读回的对象应与写入的完全一致');

  const read = await vault.get(written.id);
  assert.deepEqual(read, written, 'get(id) 读回的字段应与写入的完全一致');
});

test('两账号互不覆盖：不同 accountKey 存两条 → list().length===2，remove 其一后另一个仍在', async (t) => {
  const vault = createVault({ home: await temporaryHome(t) });
  const first = account('key-one', { accessToken: 'access-one' });
  const second = account('key-two', { accessToken: 'access-two' });
  await vault.save(first);
  await vault.save(second);

  const listed = await vault.list();
  assert.equal(listed.length, 2, '两条记录应同时存在');
  assert.deepEqual(
    listed.map(item => item.accountKey).sort(),
    ['key-one', 'key-two'],
    '两条记录应按各自的 accountKey 分别保存',
  );

  assert.equal(await vault.remove(first.id), true, 'remove 已存在的账号应返回 true');
  const left = await vault.list();
  assert.equal(left.length, 1, '删掉一条后应只剩 1 条');
  assert.equal(left[0]?.accountKey, 'key-two', '剩下的一条应是被保留的另一个账号');
  assert.deepEqual(await vault.get(second.id), second, '被保留账号的内容不应被改动');
});

test('选中账号往返：writeSelected(id) 后 readSelected 返回该 id → writeSelected(undefined) 后返回 undefined', async (t) => {
  const vault = createVault({ home: await temporaryHome(t) });
  const { id } = account('key-selected');
  await vault.save(account('key-selected'));

  assert.equal(await vault.readSelected(), undefined, '没写过选择时应返回 undefined');
  await vault.writeSelected(id);
  assert.equal(await vault.readSelected(), id, '写入后 readSelected() 应返回同一个 id');

  await vault.writeSelected(undefined);
  assert.equal(await vault.readSelected(), undefined, 'writeSelected(undefined) 之后应回到 undefined');
});

test('坏 JSON 视为不存在：accounts/<id>.json 内容为 "{" → get 返回 undefined 而不抛', async (t) => {
  const home = await temporaryHome(t);
  const vault = createVault({ home });
  const { id, accountKey } = account('key-broken');
  await seedRaw(home, id, '{');

  assert.equal(await vault.get(id), undefined, '坏 JSON 应被当作不存在');
  assert.deepEqual(await vault.list(), [], '坏 JSON 不应出现在 list() 里');

  // 同一目录下补一条好的，坏的那条仍然不干扰读取。
  await vault.save(account('key-good'));
  const listed = await vault.list();
  assert.equal(listed.length, 1, 'list() 应只返回能解析的记录');
  assert.equal(listed[0]?.accountKey, 'key-good', '能解析的那条应正常返回');
  assert.notEqual(accountKey, listed[0]?.accountKey, '坏记录与被跳过的记录不应混淆');
});

test('schemaVersion 不为 1 的记录被忽略：手写 schemaVersion:2 → get 返回 undefined', async (t) => {
  const home = await temporaryHome(t);
  const vault = createVault({ home });
  const { id } = account('key-v2');
  const body = JSON.stringify({
    ...account('key-v2'),
    schemaVersion: 2,
    accessToken: 'access-v2',
  });
  await seedRaw(home, id, body);

  assert.equal(await vault.get(id), undefined, 'schemaVersion 2 的记录必须被忽略');
  assert.deepEqual(await vault.list(), [], 'schemaVersion 2 的记录不应出现在 list() 里');
});

test('accountIdFor 稳定：同 key 两次相同、异 key 不同 → 格式为 /^acc_[a-f0-9]{16}$/', () => {
  const first = accountIdFor('user:12345');
  assert.equal(accountIdFor('user:12345'), first, '同一个 accountKey 两次派生结果必须相同');
  assert.notEqual(accountIdFor('user:12346'), first, '不同 accountKey 必须派生出不同 id');
  assert.match(first, /^acc_[a-f0-9]{16}$/, `id 应为 acc_ 加 16 位小写十六进制，实际是 ${first}`);
});

test('decodeJwtFacts 读声明：真 JWT → 读出 expiresAtMs/accountKey/nickname；非 JWT → 返回 {} 且不抛', () => {
  const token = makeJwt({ exp: 1_800_000_000, sub: 'acct-777', name: '小浣熊', identity: 'personal' });
  const facts = decodeJwtFacts(token);
  assert.equal(facts.expiresAtMs, 1_800_000_000_000, 'exp 应换算成毫秒');
  assert.equal(facts.accountKey, 'acct-777', 'accountKey 应取 payload.sub');
  assert.equal(facts.nickname, '小浣熊', 'nickname 应取 payload.name');
  assert.equal(facts.identity, 'personal', 'identity 应取 payload.identity');

  for (const bad of ['abc', '', 'a.b']) {
    assert.deepEqual(decodeJwtFacts(bad), {}, `非 JWT ${JSON.stringify(bad)} 应返回空对象`);
  }
});

test('目录只建在 $DSH_HOME 下：传入 home 临时目录 → rootDir() 以它开头，与真实家目录无关', async (t) => {
  const home = await temporaryHome(t);
  const vault = createVault({ home });
  const root = vault.rootDir();

  assert.equal(root, join(home, VAULT_DIRNAME), `rootDir() 应为 <home>/${VAULT_DIRNAME}，实际是 ${root}`);
  assert.ok(root.startsWith(home), `rootDir() 应以传入的 home 开头，实际是 ${root}`);

  // Windows 上临时目录本身可能就在用户目录下，那时「不含家目录」无意义，只在可判定时断言。
  const realHome = homedir();
  if (!home.toLowerCase().startsWith(realHome.toLowerCase())) {
    assert.ok(
      !root.toLowerCase().startsWith(realHome.toLowerCase()),
      `rootDir() 不应落在真实家目录 ${realHome} 下，实际是 ${root}`,
    );
  }

  // 建仓库本身不产生磁盘写入；save 之后才出现在 vault 根下。
  await assert.rejects(readFile(root, 'utf8'), 'rootDir() 只是一个路径，不应在创建时被写成文件');
});
