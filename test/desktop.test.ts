import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

import type { DesktopProbe } from '../src/credentials/desktop.ts';
import { desktopAuthCandidates, probeDesktop, writeBackDesktop } from '../src/credentials/desktop.ts';
import { DESKTOP_AUTH_FILENAME, DESKTOP_CONFIG_DIRNAME, DESKTOP_TOKEN_KEYS } from '../src/constants.ts';

/** 每个测试自建临时目录，结束时整棵删除。 */
async function temporaryDir(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'raccoon-desktop-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** 按 App 的键序写一份 auth.json，返回它的绝对路径。 */
async function writeAuthFile(
  dir: string,
  document: Record<string, unknown>,
  name = DESKTOP_AUTH_FILENAME,
): Promise<string> {
  const authPath = path.join(dir, name);
  await mkdir(path.dirname(authPath), { recursive: true });
  await writeFile(authPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  return authPath;
}

/** 一份完整的 5 键文档，键序与 App 一致。 */
function fullDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const document: Record<string, unknown> = {
    access_token: 'access-old',
    refresh_token: 'refresh-old',
    office_identity: 'personal',
    office_org_name: '商汤科技',
    office_org_role: 'owner',
  };
  for (const key of Object.keys(overrides)) document[key] = overrides[key];
  return document;
}

/** 造一个「已带凭据快照」的 probe，用于写回路径。 */
function probeWithCredential(authPath: string, rawKeys: string[]): DesktopProbe {
  return {
    configDir: path.dirname(authPath),
    authPath,
    exists: true,
    readable: true,
    multiAccount: false,
    reason: null,
    keyOrderMatchesApp: true,
    credential: {
      accessToken: 'access-old',
      refreshToken: 'refresh-old',
      identity: 'personal',
      orgName: '商汤科技',
      orgRole: 'owner',
      rawKeys,
    },
  };
}

test('候选路径优先级：RACCOON_AUTH_FILE 设了就短路另两个 → 只返回它一条且 source 为 env-file', async (t) => {
  const dir = await temporaryDir(t);
  const explicitFile = path.join(dir, 'custom', 'my-auth.json');
  const candidates = desktopAuthCandidates({
    RACCOON_AUTH_FILE: explicitFile,
    BOX_AGENT_CONFIG_DIR: path.join(dir, 'box-agent'),
  });

  assert.equal(candidates.length, 1, 'RACCOON_AUTH_FILE 命中时应只有 1 条候选（短路其余）');
  assert.equal(candidates[0]?.path, path.resolve(explicitFile), '候选路径应等于 RACCOON_AUTH_FILE 解析后的绝对路径');
  assert.equal(candidates[0]?.source, 'env-file', '来源应为 env-file');
  assert.ok(
    !candidates.some(item => item.path.includes('box-agent')),
    'BOX_AGENT_CONFIG_DIR 不应再产生候选',
  );
});

test('候选路径降级：只有 BOX_AGENT_CONFIG_DIR → 拼上 /auth.json 且 source 为 env-dir', async (t) => {
  const dir = await temporaryDir(t);
  const configDir = path.join(dir, 'box-config');
  const candidates = desktopAuthCandidates({ BOX_AGENT_CONFIG_DIR: configDir });

  assert.equal(candidates.length, 1, '应只有 1 条候选');
  assert.equal(candidates[0]?.path, path.join(path.resolve(configDir), DESKTOP_AUTH_FILENAME), '候选路径应为 <配置目录>/auth.json');
  assert.equal(candidates[0]?.source, 'env-dir', '来源应为 env-dir');
});

test('候选路径缺省：两个环境变量都没设 → 落在 ~/.box-agent/config/auth.json', () => {
  const candidates = desktopAuthCandidates({});
  assert.equal(candidates.length, 1, '应只有 1 条候选');
  assert.equal(
    candidates[0]?.path,
    path.join(homedir(), DESKTOP_CONFIG_DIRNAME, DESKTOP_AUTH_FILENAME),
    '缺省候选路径应为 ~/.box-agent/config/auth.json',
  );
  assert.equal(candidates[0]?.source, 'default', '来源应为 default');
});

test('文件不存在：指向空目录里的 auth.json → exists:false 且 reason 为 desktop-missing', async (t) => {
  const dir = await temporaryDir(t);
  const authPath = path.join(dir, DESKTOP_AUTH_FILENAME);
  const probe = await probeDesktop({ env: { RACCOON_AUTH_FILE: authPath } });

  assert.equal(probe.exists, false, '文件不存在时 exists 应为 false');
  assert.equal(probe.reason, 'desktop-missing', '原因应为 desktop-missing');
  assert.equal(probe.credential, undefined, '读不到凭据时 credential 应为 undefined');
  assert.equal(probe.authPath, authPath, 'authPath 应回显探测目标，便于界面给出可执行建议');
});

test('完整 5 键 fixture：按 App 键序写入 → credential 有值、keyOrderMatchesApp 为 true、identity 读出', async (t) => {
  const dir = await temporaryDir(t);
  const authPath = await writeAuthFile(dir, fullDocument());
  const probe = await probeDesktop({ env: { RACCOON_AUTH_FILE: authPath } });

  assert.equal(probe.reason, null, '完整文件不应带失败原因');
  assert.equal(probe.exists, true, '文件存在时 exists 应为 true');
  assert.equal(probe.readable, true, '文件可读时 readable 应为 true');
  assert.equal(probe.keyOrderMatchesApp, true, '键序与 App 一致时应为 true');
  assert.equal(probe.multiAccount, false, '桌面端一个文件只承载一份登录态');
  assert.ok(probe.credential !== undefined, 'credential 应有值');
  assert.equal(probe.credential.accessToken, 'access-old', 'accessToken 应读出原值');
  assert.equal(probe.credential.refreshToken, 'refresh-old', 'refreshToken 应读出原值');
  assert.equal(probe.credential.identity, 'personal', 'identity 应从 office_identity 读出');
  assert.equal(probe.credential.orgName, '商汤科技', 'orgName 应从 office_org_name 读出');
  assert.equal(probe.credential.orgRole, 'owner', 'orgRole 应从 office_org_role 读出');
  assert.deepEqual(probe.credential.rawKeys, [...DESKTOP_TOKEN_KEYS], 'rawKeys 应保留磁盘上的键序');
});

test('键序不匹配：office_identity 放到第一位 → keyOrderMatchesApp 为 false，但凭据仍可读', async (t) => {
  const dir = await temporaryDir(t);
  const authPath = await writeAuthFile(dir, {
    office_identity: 'personal',
    access_token: 'access-old',
    refresh_token: 'refresh-old',
    office_org_name: '商汤科技',
    office_org_role: 'owner',
  });
  const probe = await probeDesktop({ env: { RACCOON_AUTH_FILE: authPath } });

  assert.equal(probe.keyOrderMatchesApp, false, '键序被改动时应为 false（写回会改动对方文件形状）');
  assert.ok(probe.credential !== undefined, '键序不影响读取，凭据仍应有值');
  assert.equal(probe.credential.accessToken, 'access-old', '乱序时 accessToken 仍应读出');
  assert.equal(probe.credential.identity, 'personal', '乱序时 identity 仍应读出');
});

test('缺 refresh_token：只有 access_token → 仍读出凭据且 refreshToken 为空串', async (t) => {
  const dir = await temporaryDir(t);
  const authPath = await writeAuthFile(dir, {
    access_token: 'access-only',
    office_identity: 'personal',
  });
  const probe = await probeDesktop({ env: { RACCOON_AUTH_FILE: authPath } });

  assert.equal(probe.reason, null, '缺 refresh_token 不算读失败');
  assert.ok(probe.credential !== undefined, '凭据仍应有值');
  assert.equal(probe.credential.accessToken, 'access-only', 'accessToken 应读出');
  assert.equal(probe.credential.refreshToken, '', '缺 refresh_token 时应为空串，不是 undefined');
});

test('加密信封：access_token 为 {$wbEncrypted:1,envelope:"x"} → reason 为 desktop-encrypted 且 credential 为 undefined', async (t) => {
  const dir = await temporaryDir(t);
  const authPath = await writeAuthFile(dir, fullDocument({
    access_token: { $wbEncrypted: 1, envelope: 'x' },
  }));
  const probe = await probeDesktop({ env: { RACCOON_AUTH_FILE: authPath } });

  assert.equal(probe.reason, 'desktop-encrypted', '加密信封应被识别为 desktop-encrypted');
  assert.equal(probe.credential, undefined, '不解密，因此不应给出凭据');
  assert.equal(probe.readable, true, '文件本身是可读的，只是内容不可解读');
});

test('坏 JSON：文件内容不是合法 JSON → reason 为 desktop-no-token 且 readable 为 true', async (t) => {
  const dir = await temporaryDir(t);
  const authPath = path.join(dir, DESKTOP_AUTH_FILENAME);
  await writeFile(authPath, '{ not json', 'utf8');
  const probe = await probeDesktop({ env: { RACCOON_AUTH_FILE: authPath } });

  assert.equal(probe.exists, true, '文件存在时 exists 应为 true');
  assert.equal(probe.readable, true, '文件读得到时 readable 应为 true');
  assert.equal(probe.reason, 'desktop-no-token', '解析不出文档时应归为 desktop-no-token');
  assert.equal(probe.credential, undefined, '坏 JSON 不应给出凭据');
});

test('access token 别名：用 token 或 auth_token 也能读出 → accessToken 为别名里的值', async (t) => {
  const dir = await temporaryDir(t);

  for (const alias of ['token', 'auth_token']) {
    const authPath = await writeAuthFile(
      dir,
      { [alias]: `access-via-${alias}`, refresh_token: 'refresh-old', office_identity: 'personal' },
      `${alias}.json`,
    );
    const probe = await probeDesktop({ env: { RACCOON_AUTH_FILE: authPath } });
    assert.equal(probe.reason, null, `用 ${alias} 别名时不应报错`);
    assert.equal(probe.credential?.accessToken, `access-via-${alias}`, `accessToken 应从 ${alias} 读出`);
    assert.equal(probe.credential?.refreshToken, 'refresh-old', `用 ${alias} 别名时 refresh_token 仍应读出`);
  }
});

test('writeBackDesktop 成功：两个 token 更新、未知键 extra 保留、键序仍以 App 5 键开头、备份是旧内容', async (t) => {
  const dir = await temporaryDir(t);
  const authPath = await writeAuthFile(dir, {
    ...fullDocument(),
    extra: { keep: true },
  });
  const before = await readFile(authPath, 'utf8');
  const probe = await probeDesktop({ env: { RACCOON_AUTH_FILE: authPath } });

  const result = await writeBackDesktop({ probe, accessToken: 'access-new', refreshToken: 'refresh-new' });
  assert.equal(result.ok, true, '写回应成功');

  const after = JSON.parse(await readFile(authPath, 'utf8')) as Record<string, unknown>;
  assert.equal(after['access_token'], 'access-new', 'access_token 应被换成新值');
  assert.equal(after['refresh_token'], 'refresh-new', 'refresh_token 应被换成新值');
  assert.deepEqual(after['extra'], { keep: true }, '未知键 extra 必须原样保留');
  assert.equal(after['office_identity'], 'personal', '已知的非 token 键应保持不变');
  assert.deepEqual(
    Object.keys(after).slice(0, DESKTOP_TOKEN_KEYS.length),
    [...DESKTOP_TOKEN_KEYS],
    '写回后的前 5 键顺序应仍是 App 的键序',
  );
  assert.equal(Object.keys(after)[DESKTOP_TOKEN_KEYS.length], 'extra', '未知键应排在已知键之后');

  const backupPath = result.ok ? result.backupPath : undefined;
  assert.ok(backupPath !== undefined, '首次写回应给出备份路径');
  assert.equal(await readFile(backupPath, 'utf8'), before, '备份内容应是写回前的旧内容');
});

test('writeBackDesktop 失败：probe.authPath 指向不存在的文件 → 返回 ok:false 且不创建该文件', async (t) => {
  const dir = await temporaryDir(t);
  const authPath = path.join(dir, 'does-not-exist', DESKTOP_AUTH_FILENAME);
  const probe = probeWithCredential(authPath, [...DESKTOP_TOKEN_KEYS]);

  const result = await writeBackDesktop({ probe, accessToken: 'access-new', refreshToken: 'refresh-new' });
  assert.equal(result.ok, false, '读不到原文件时必须返回 ok:false');
  assert.equal(typeof (result.ok ? undefined : result.reason), 'string', '失败时应给出可读的 reason');

  await assert.rejects(
    stat(authPath),
    '失败路径不允许凭空创建凭据文件（否则会覆盖 App 的登录态）',
  );
  await assert.rejects(
    stat(path.join(dir, 'does-not-exist')),
    '失败路径也不应顺带创建上级目录',
  );
});
