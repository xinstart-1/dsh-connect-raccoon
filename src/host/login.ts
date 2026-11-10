/**
 * 登录会话管理：网页授权回调与微信扫码两条路，共用一个六相位状态机。
 *
 * 网页那条是主线：本地起一个**只收一次回调**的服务器，把官方授权页的
 * `desktop_callback=loopback` 接住。扫码那条是快路径（纯 HTTP 可驱动，但拿不到
 * refresh token）。两条路都以「拿到令牌后探一次模型目录」为成功判据 ——
 * 上游会签发令牌，但只有网关接受它才算真的登录成功。
 *
 * 不变量：任一时刻最多一个进行中的会话；`state` 必须逐字比对；凭据只进仓库，
 * 永不进状态文档。
 *
 * @module dsh-connect-raccoon/host/login
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  AUTHORIZE_APP_NAME,
  AUTHORIZE_PATH,
  CALLBACK_PATH,
  DESKTOP_CALLBACK,
  LOGIN_SOURCE,
  LOGIN_TIMEOUT_MS,
  QR_POLL_MAX_MS,
  QR_POLL_MIN_MS,
  SITE_ORIGIN,
} from '../constants.ts';
import { renderQrSvg } from '../protocol/qr.ts';
import type { RaccoonClient } from '../protocol/client.ts';
import type { StoredAccount } from '../credentials/vault.ts';

/** 会话相位；`done` 之后的任何相位都不再变化。 */
export type LoginPhase =
  | 'idle'
  | 'waiting'
  | 'exchanging'
  | 'validating'
  | 'done'
  | 'expired'
  | 'cancelled'
  | 'error';

/** 会话种类：网页授权（有 refresh token）或微信扫码（只有 access token）。 */
export type LoginKind = 'web' | 'qr';

/** 状态文档里 `login` 字段的形状（见 `docs/CONTRACT.md` §四）。 */
export interface LoginView {
  running: boolean;
  kind: LoginKind;
  phase: LoginPhase;
  message: string;
  url: string | null;
  port: number | null;
  qrSvg: string | null;
  expiresAtMs: number | null;
  error: { code: string; message: string } | null;
}

/** 登录成功后交给调用方保存的账号（来源由会话种类决定）。 */
export interface LoginResult {
  source: 'web' | 'qr';
  accessToken: string;
  refreshToken: string;
  identity?: string;
  orgName?: string;
  orgRole?: string;
  nickname?: string;
}

/** 登录管理器依赖。 */
export interface LoginManagerOptions {
  client: RaccoonClient;
  /** 把令牌换成一个可保存的账号（含 jwt 派生字段）。 */
  toAccount: (input: LoginResult) => Promise<StoredAccount>;
  /** 保存账号并把它设成当前选用。 */
  save: (account: StoredAccount) => Promise<void>;
  /** 用模型目录探一次令牌是否被网关接受。 */
  validate: (accessToken: string) => Promise<boolean>;
  /** 用系统默认浏览器打开 URL；返回是否至少一条启动路径被接受。 */
  openBrowser: (url: string) => boolean;
  warn: (message: string) => void;
  /** 注入时钟与随机源（测试用）。 */
  now?: () => number;
  randomState?: () => string;
}

/** 登录管理器。 */
export interface LoginManager {
  view(): LoginView;
  startWeb(): Promise<LoginView>;
  startQr(): Promise<LoginView>;
  /** 手粘授权码或整条回调 URL 的兜底路径。 */
  submitCode(text: string): Promise<LoginView>;
  cancel(): Promise<void>;
  dispose(): void;
}

/** 空闲视图。 */
const IDLE: LoginView = {
  running: false,
  kind: 'web',
  phase: 'idle',
  message: '',
  url: null,
  port: null,
  qrSvg: null,
  expiresAtMs: null,
  error: null,
};

/** 建一个空闲视图（`running:false` 的相位不参与渲染）。 */
function idle(kind: LoginKind = 'web'): LoginView {
  return { ...IDLE, kind };
}

/** 从任意输入里取出授权码：整条回调 URL 或裸码都接受。 */
export function extractAuthorizationCode(text: string, expectedState: string): { code: string } | { error: string } {
  const trimmed = text.trim();
  if (trimmed === '') return { error: '没有收到授权码' };
  if (!trimmed.includes('://') && !trimmed.includes('code=')) {
    return { code: trimmed };
  }
  let url: URL;
  try {
    url = new URL(trimmed.includes('://') ? trimmed : `office-raccoon://auth/callback?${trimmed.replace(/^\?/, '')}`);
  } catch {
    return { error: '这段文本既不是授权码也不是一条回调地址' };
  }
  const code = url.searchParams.get('code') ?? url.searchParams.get('authorization_code') ?? '';
  const state = url.searchParams.get('state') ?? '';
  if (code === '') return { error: '回调地址里没有 code' };
  if (state === '') return { error: '回调地址里没有 state，无法确认这次登录由本机发起' };
  if (!safeEqual(state, expectedState)) return { error: '回调 state 不匹配，已拒绝这次登录' };
  return { code };
}

/** 定长比较，避免把 state 校验写成有长度侧信道的形式。 */
function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** 生成 64 位小写 hex；授权页对 `state` 有这条硬校验。 */
function defaultState(): string {
  return randomBytes(32).toString('hex');
}

/** 拼授权页 URL。 */
export function buildAuthorizeUrl(input: { state: string; redirectUrl: string }): string {
  const url = new URL(`${SITE_ORIGIN}${AUTHORIZE_PATH}`);
  url.searchParams.set('login_source', LOGIN_SOURCE);
  url.searchParams.set('appname', AUTHORIZE_APP_NAME);
  url.searchParams.set('state', input.state);
  url.searchParams.set('redirect', input.redirectUrl);
  url.searchParams.set('desktop_callback', DESKTOP_CALLBACK);
  return url.href;
}

/** 回调时回给浏览器的那一页；必须在收到请求后立刻响应。 */
function callbackPage(ok: boolean, message: string): string {
  const title = ok ? '登录成功' : '登录未完成';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;background:#f6f7f9;color:#1f2328}
main{max-width:32rem;padding:2rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .75rem}p{margin:0;line-height:1.7;color:#57606a}</style>
</head><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;
}

/**
 * 建登录管理器。
 *
 * @param options - 上游客户端、保存与校验回调、浏览器启动器。
 * @returns 管理器；同一时刻最多一个会话。
 */
export function createLoginManager(options: LoginManagerOptions): LoginManager {
  const now = options.now ?? ((): number => Date.now());
  const randomState = options.randomState ?? defaultState;
  let current: LoginView = idle();
  let server: Server | undefined;
  let expectedState = '';
  let deadline = 0;
  let disposed = false;

  /** 关掉本地回调服务器并释放端口。 */
  const closeServer = async (): Promise<void> => {
    const handle = server;
    server = undefined;
    if (handle === undefined) return;
    await new Promise<void>((resolve) => {
      handle.closeAllConnections?.();
      handle.close(() => { resolve(); });
    });
  };

  const finish = (patch: Partial<LoginView>): LoginView => {
    current = { ...current, ...patch };
    return current;
  };

  const fail = (code: string, message: string): LoginView => {
    void closeServer();
    return finish({ running: false, phase: 'error', message, error: { code, message } });
  };

  /** 拿到码之后的公共后半程：换令牌 → 探目录 → 保存。 */
  const complete = async (input: { kind: LoginKind; accessToken: string; refreshToken: string; identity?: string; orgName?: string; orgRole?: string }): Promise<LoginView> => {
    finish({ phase: 'validating', message: '正在校验账号…', qrSvg: null });
    const usable = await options.validate(input.accessToken).catch(() => false);
    if (!usable) {
      return fail('token-rejected', '网关拒绝了这次登录令牌，请重新登录');
    }
    let nickname: string | undefined;
    try {
      const info = await options.client.fetchUserInfo(input.accessToken);
      nickname = info.nickname;
    } catch {
      // 拿不到昵称不影响登录：它只是显示用。
    }
    const account = await options.toAccount({
      source: input.kind === 'qr' ? 'qr' : 'web',
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
      ...(input.identity === undefined ? {} : { identity: input.identity }),
      ...(input.orgName === undefined ? {} : { orgName: input.orgName }),
      ...(input.orgRole === undefined ? {} : { orgRole: input.orgRole }),
      ...(nickname === undefined ? {} : { nickname }),
    });
    await options.save(account);
    const label = account.nickname ?? account.id;
    return finish({
      running: false,
      phase: 'done',
      message: `登录成功：${label}`,
      url: null,
      port: null,
      qrSvg: null,
      error: null,
    });
  };

  /** 用授权码换令牌并保存。 */
  const redeemCode = async (code: string, kind: LoginKind): Promise<LoginView> => {
    finish({ phase: 'exchanging', message: '正在换取登录凭证…' });
    try {
      const pair = await options.client.exchangeAuthorizationCode(code);
      return await complete({
        kind,
        accessToken: pair.accessToken,
        refreshToken: pair.refreshToken,
        ...(pair.identity === undefined ? {} : { identity: pair.identity }),
        ...(pair.orgName === undefined ? {} : { orgName: pair.orgName }),
        ...(pair.orgRole === undefined ? {} : { orgRole: pair.orgRole }),
      });
    } catch (error) {
      const upstream = (error as { code?: string }).code;
      // 授权码是一次性的：200035 重试只会再得 200035，所以文案直接引导重新发起。
      if (upstream === 'code-not-found') {
        return fail('code-expired', '授权码已失效（一次性，可能已用过），请重新发起登录');
      }
      return fail('upstream-error', error instanceof Error ? error.message : '换取登录凭证失败');
    }
  };

  return {
    view() {
      // 网页会话没有轮询循环（等的是浏览器自己的回调），所以超时只能在这里判：
      // 过了 deadline 就把相位翻成 expired 并关掉本地服务器，否则端口会一直挂着。
      if (current.running && current.kind === 'web' && now() >= deadline) {
        void closeServer();
        current = {
          ...current,
          running: false,
          phase: 'expired',
          message: '登录超时，请重新发起',
          url: null,
          port: null,
          error: { code: 'login-timeout', message: '登录超时，请重新发起' },
        };
      }
      return current;
    },

    async startWeb() {
      if (disposed) return idle();
      if (current.running) return current;
      await closeServer();
      expectedState = randomState();
      deadline = now() + LOGIN_TIMEOUT_MS;

      let port = 0;
      const waiting = new Promise<void>((resolve) => {
        const handle = createServer((req, res) => {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          if (url.pathname !== CALLBACK_PATH) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('not found');
            return;
          }
          const code = url.searchParams.get('code') ?? url.searchParams.get('authorization_code') ?? '';
          const state = url.searchParams.get('state') ?? '';
          if (code === '' || !safeEqual(state, expectedState)) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(callbackPage(false, '回调缺少授权码，或 state 校验失败。请回到 DSH 重新发起登录。'));
            void closeServer();
            finish({
              running: false,
              phase: 'error',
              message: '回调 state 校验失败，已拒绝这次登录',
              error: { code: 'state-mismatch', message: '回调 state 校验失败' },
            });
            resolve();
            return;
          }
          // 立刻响应：浏览器在等这一页，晚了用户就会以为挂了。
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(callbackPage(true, '可以关闭此页，回到 DSH 继续。'));
          resolve();
          void redeemCode(code, 'web').finally(() => { void closeServer(); });
        });
        handle.once('error', () => { resolve(); });
        handle.listen(0, '127.0.0.1', () => {
          const address = handle.address() as AddressInfo | null;
          port = address?.port ?? 0;
          resolve();
        });
        server = handle;
      });

      current = {
        running: true,
        kind: 'web',
        phase: 'waiting',
        message: '正在准备本地登录服务…',
        url: null,
        port: null,
        qrSvg: null,
        expiresAtMs: deadline,
        error: null,
      };
      await waiting;
      if (port === 0) {
        current = idle('web');
        return fail('network-error', '无法在本地回环地址上监听回调端口');
      }
      const redirectUrl = `http://127.0.0.1:${String(port)}${CALLBACK_PATH}`;
      const url = buildAuthorizeUrl({ state: expectedState, redirectUrl });
      const opened = options.openBrowser(url);
      current = {
        ...current,
        phase: 'waiting',
        message: opened
          ? '已在浏览器里打开授权页：登录后本页会自动完成，无需复制任何东西。'
          : '浏览器没能自动打开，请点下面的链接手动打开授权页。',
        url,
        port,
      };
      // 超时由 view() 判定（等的是浏览器回调，没有轮询循环可挂超时），这里只报 deadline。
      return current;
    },

    async startQr() {
      if (disposed) return idle('qr');
      if (current.running) return current;
      await closeServer();
      deadline = now() + LOGIN_TIMEOUT_MS;
      current = {
        running: true,
        kind: 'qr',
        phase: 'waiting',
        message: '正在获取二维码…',
        url: null,
        port: null,
        qrSvg: null,
        expiresAtMs: deadline,
        error: null,
      };
      try {
        const session = await options.client.startQr();
        const content = options.client.qrContent(session);
        const qrSvg = renderQrSvg(content, { size: 220 });
        const intervalMs = Math.min(
          QR_POLL_MAX_MS,
          Math.max(QR_POLL_MIN_MS, session.pollIntervalMs),
        );
        current = {
          ...current,
          message: '请用微信扫描二维码（小程序内确认）',
          qrSvg,
          expiresAtMs: now() + session.expiresInSec * 1000,
        };
        const code = session.code;
        const poll = async (): Promise<void> => {
          for (;;) {
            if (disposed || !current.running || current.kind !== 'qr') return;
            if (now() >= deadline) {
              fail('login-timeout', '登录超时，请重新发起扫码');
              return;
            }
            await new Promise((resolve) => { setTimeout(resolve, intervalMs).unref?.(); });
            const outcome = await options.client.pollQr(code).catch(() => undefined);
            if (outcome === undefined) continue;
            if (outcome.status === 'success' && outcome.accessToken !== undefined) {
              await complete({ kind: 'qr', accessToken: outcome.accessToken, refreshToken: '' });
              return;
            }
            if (outcome.status === 'canceled') {
              fail('login-cancelled', '你取消了这次授权，请重新发起');
              return;
            }
            if (outcome.status === 'expired' || outcome.status === 'error') {
              fail(outcome.status === 'expired' ? 'qr-expired' : 'upstream-error', outcome.message ?? '二维码已失效');
              return;
            }
            if (outcome.status === 'scanning') {
              current = { ...current, message: '已扫码，请在手机上确认' };
            }
          }
        };
        void poll();
        return current;
      } catch (error) {
        return fail('upstream-error', error instanceof Error ? error.message : '获取二维码失败');
      }
    },

    async submitCode(text: string) {
      if (disposed) return idle();
      if (expectedState === '') {
        // 没发起过网页登录就没有 state 可比：这是编程路径问题，不是用户操作错误。
        return fail('state-mismatch', '没有进行中的网页登录，请先点「网页登录」再粘授权码');
      }
      const parsed = extractAuthorizationCode(text, expectedState);
      if ('error' in parsed) return fail('state-mismatch', parsed.error);
      return await redeemCode(parsed.code, 'web');
    },

    async cancel() {
      await closeServer();
      if (current.running) {
        current = { ...current, running: false, phase: 'cancelled', message: '已取消登录', qrSvg: null };
      }
      return;
    },

    dispose() {
      disposed = true;
      void closeServer();
    },
  };
}
