/**
 * 小浣熊上游客户端：纯 HTTP，无账号状态。
 *
 * 账号从哪来、用完写回哪儿，都由 `host/` 决定；这里只把每个端点的形状、
 * 身份头、错误归一与超时固定下来。所有方法都接受外部 `signal`，内部另加超时，
 * 两者任一触发就中止 —— 「等待没有超时」是这类插件最常见的一类挂死。
 *
 * @module dsh-connect-raccoon/protocol/client
 */

import {
  CLIENT_LANGUAGE,
  CLIENT_VERSION,
  QR_APP_NAME,
  REQUEST_TIMEOUT_MS,
  SITE_ORIGIN,
} from '../constants.ts';
import { parseCatalog, type Catalog } from './catalog.ts';
import { RaccoonError, classifyThrown, classifyUpstream } from './errors.ts';

/**
 * 一个主站地址派生出的全部端点。
 *
 * 单列成函数是为了让 `siteOrigin` 配置真的生效 —— 它此前只写在 schema 里、
 * 从未参与请求，等于一个「声明了但不起作用」的开关。同时它让测试能把上游
 * 指向本地假服务器，从而在不碰真实账号的前提下验证账号池与换号。
 */
export interface Endpoints {
  /** 主站 origin，用于 `origin`/`referer` 头与扫码落地页解析。 */
  site: string;
  /** OpenAI 兼容的对话网关。 */
  llm: string;
  /** 业务鉴权（刷新、换码、账号资料）。 */
  auth: string;
  /** IAM（微信小程序扫码）。 */
  iam: string;
  /** 积分与账单。 */
  points: string;
}

/**
 * 从主站派生端点。
 *
 * @param siteOrigin - 主站 origin；留空用内置的 `https://xiaohuanxiong.com`。
 * @returns 五个端点前缀（都不带尾斜杠）。
 */
export function endpointsOf(siteOrigin?: string): Endpoints {
  const trimmed = typeof siteOrigin === 'string' ? siteOrigin.trim().replace(/\/+$/, '') : '';
  const site = trimmed === '' ? SITE_ORIGIN : trimmed;
  return {
    site,
    llm: `${site}/api/web/llm/v2`,
    auth: `${site}/api/web/auth/v1`,
    iam: `${site}/api/iam/v1`,
    points: `${site}/api/web/points/v1`,
  };
}

/** 凭据对。 */
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  identity?: string;
  orgName?: string;
  orgRole?: string;
}

/** 积分余额。 */
export interface Balance {
  total: number;
  packages: Array<{ amount: number; expiresAtMs?: number }>;
  /** 近期（15 天）内会作废的额度。 */
  expiringSoon: number;
  nearestExpiryMs?: number;
}

/** 一次扫码会话。 */
export interface QrSession {
  code: string;
  scanPath: string;
  expiresInSec: number;
  pollIntervalMs: number;
}

/** 一次扫码轮询结果。 */
export interface QrPoll {
  status: 'pending' | 'scanning' | 'success' | 'canceled' | 'expired' | 'error';
  accessToken?: string;
  message?: string;
}

/** 账号资料（只用于显示）。 */
export interface UserInfo {
  nickname?: string;
  identity?: string;
  orgName?: string;
}

/** 客户端依赖。 */
export interface RaccoonClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  warn?: (message: string) => void;
  /** 主站 origin；留空用内置地址。测试把它指向本地假服务器。 */
  siteOrigin?: string;
}

/** 上游客户端。 */
export interface RaccoonClient {
  fetchCatalog(accessToken: string, signal?: AbortSignal): Promise<Catalog>;
  fetchBalance(accessToken: string, signal?: AbortSignal): Promise<Balance>;
  chatStream(input: { accessToken: string; body: unknown; signal?: AbortSignal }): Promise<Response>;
  startQr(): Promise<QrSession>;
  pollQr(code: string): Promise<QrPoll>;
  qrContent(session: QrSession): string;
  exchangeAuthorizationCode(code: string): Promise<TokenPair>;
  fetchUserInfo(accessToken: string): Promise<UserInfo>;
  confirmIamSession(accessToken: string): Promise<string | undefined>;
  settingInfo(accessToken: string): Promise<unknown>;
  fetchBills(accessToken: string): Promise<unknown>;
}

/** 当前平台的身份头取值；网关按它区分通道。 */
export function clientPlatform(): string {
  if (process.platform === 'darwin') return 'desktop-macos';
  if (process.platform === 'linux') return 'desktop-linux';
  return 'desktop-windows';
}

/** 所有业务请求共用的身份头。 */
function identityHeaders(site: string, token?: string): Record<string, string> {
  return {
    accept: 'application/json',
    'x-raccoon-language': CLIENT_LANGUAGE,
    'x-client-platform': clientPlatform(),
    'x-client-version': CLIENT_VERSION,
    'x-org-code': '',
    origin: site,
    referer: `${site}/`,
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
  };
}

/** 去掉上游可能附带的 `Bearer ` 前缀（含 `Bearer` 后无空白的畸形写法）。 */
export function stripBearer(value: unknown): string {
  return typeof value === 'string' ? value.replace(/^Bearer\s*/i, '').trim() : '';
}

/** 取对象。 */
function obj(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 取字符串。 */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** 取有限数字。 */
function num(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(number) ? number : undefined;
}

/**
 * 起一个客户端。
 *
 * @param options - 注入的 fetch 与超时（测试用）。
 * @returns 客户端；实例无状态，可并发调用。
 */
export function createRaccoonClient(options: RaccoonClientOptions = {}): RaccoonClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const endpoints = endpointsOf(options.siteOrigin);

  /** 发一次请求并返回 `Response`；网络层失败归一成 RaccoonError。 */
  const send = async (input: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    signal?: AbortSignal;
  }): Promise<Response> => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = input.signal === undefined ? timeout : AbortSignal.any([input.signal, timeout]);
    try {
      return await fetchImpl(input.url, {
        method: input.method ?? 'GET',
        headers: {
          ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(input.headers ?? {}),
        },
        ...(input.body === undefined ? {} : { body: typeof input.body === 'string' ? input.body : JSON.stringify(input.body) }),
        signal,
        redirect: 'error',
      });
    } catch (error) {
      throw classifyThrown(error);
    }
  };

  /** 发一次请求并把 JSON 解析出来；非 2xx 一律按上游信封归一成错误。 */
  const json = async (input: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    signal?: AbortSignal;
  }): Promise<unknown> => {
    const response = await send(input);
    const text = await response.text().catch(() => '');
    let parsed: unknown;
    try {
      parsed = text === '' ? undefined : (JSON.parse(text) as unknown);
    } catch {
      parsed = undefined;
    }
    if (!response.ok) throw classifyUpstream({ status: response.status, payload: parsed });
    return parsed;
  };

  return {
    async fetchCatalog(accessToken, signal) {
      const payload = await json({ url: `${endpoints.llm}/model_catalog`, headers: identityHeaders(endpoints.site, accessToken), ...(signal === undefined ? {} : { signal }) });
      return parseCatalog(payload);
    },

    async fetchBalance(accessToken, signal) {
      const payload = await json({ url: `${endpoints.points}/balance`, headers: identityHeaders(endpoints.site, accessToken), ...(signal === undefined ? {} : { signal }) });
      return parseBalance(payload);
    },

    async chatStream(input) {
      const response = await send({
        url: `${endpoints.llm}/chat/completions`,
        method: 'POST',
        headers: identityHeaders(endpoints.site, input.accessToken),
        body: input.body,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (response.ok) return response;
      const text = await response.text().catch(() => '');
      let parsed: unknown;
      try {
        parsed = text === '' ? undefined : (JSON.parse(text) as unknown);
      } catch {
        parsed = undefined;
      }
      throw classifyUpstream({ status: response.status, payload: parsed });
    },

    async startQr() {
      const payload = await json({
        url: `${endpoints.iam}/auth/mp/qrcode`,
        method: 'POST',
        headers: identityHeaders(endpoints.site),
        body: {},
      });
      return parseQrSession(payload, options.siteOrigin);
    },

    async pollQr(code) {
      return await pollQrOnce((input) => json(input), code, endpoints);
    },

    qrContent(session) {
      const url = new URL(session.scanPath, endpoints.site);
      url.search = '';
      url.searchParams.set('code', session.code);
      url.searchParams.set('appname', QR_APP_NAME);
      url.searchParams.set('source', 'platform');
      return url.href;
    },

    async exchangeAuthorizationCode(code) {
      const payload = await json({
        url: `${endpoints.auth}/login_with_authorization_code`,
        method: 'POST',
        headers: identityHeaders(endpoints.site),
        body: { authorization_code: code },
      });
      return parseTokenPair(payload);
    },

    async fetchUserInfo(accessToken) {
      const payload = await json({ url: `${endpoints.auth}/user_info`, headers: identityHeaders(endpoints.site, accessToken) });
      const data = obj(obj(payload)?.['data']) ?? obj(payload) ?? {};
      const name = str(data['name']) ?? str(data['nickname']);
      const ownerType = str(data['owner_type']);
      const orgName = str(data['org_name']);
      const identity = ownerType ?? (Array.isArray(data['orgs']) && data['orgs'].length === 0 ? 'personal' : undefined);
      return {
        ...(name === undefined ? {} : { nickname: name }),
        ...(identity === undefined ? {} : { identity }),
        ...(orgName === undefined ? {} : { orgName }),
      };
    },

    async confirmIamSession(accessToken) {
      try {
        const response = await send({
          url: `${endpoints.auth}/iam/confirm`,
          method: 'POST',
          headers: identityHeaders(endpoints.site, accessToken),
          body: {},
        });
        const headers = response.headers as Headers & { getSetCookie?: () => string[] };
        const cookies = headers.getSetCookie?.() ?? (headers.get('set-cookie') === null ? [] : [headers.get('set-cookie') ?? '']);
        await response.text().catch(() => '');
        if (!response.ok) return undefined;
        return cookieValue(cookies, (name) => name === 'xhx_token' || name.endsWith('xhx_token'));
      } catch {
        // 这一跳失败不致命：最终以模型目录探针为准。
        return undefined;
      }
    },

    async settingInfo(accessToken) {
      return await json({ url: `${endpoints.site}/api/web/office/v3/setting_info`, headers: identityHeaders(endpoints.site, accessToken) });
    },

    async fetchBills(accessToken) {
      return await json({ url: `${endpoints.points}/bills`, headers: identityHeaders(endpoints.site, accessToken) });
    },
  };
}

/** 解析余额信封。 */
export function parseBalance(payload: unknown): Balance {
  const data = obj(obj(payload)?.['data']) ?? obj(payload) ?? {};
  const total = num(data['balance']) ?? num(data['total']) ?? num(data['points']) ?? 0;
  const packagesRaw = Array.isArray(data['packages']) ? data['packages'] : Array.isArray(data['items']) ? data['items'] : [];
  const packages: Array<{ amount: number; expiresAtMs?: number }> = [];
  for (const raw of packagesRaw) {
    const row = obj(raw);
    if (row === undefined) continue;
    const amount = num(row['amount']) ?? num(row['points']) ?? num(row['balance']);
    if (amount === undefined) continue;
    const expires = num(row['expires_at']) ?? num(row['expire_at']) ?? num(row['expired_at']);
    packages.push({
      amount,
      ...(expires === undefined ? {} : { expiresAtMs: expires > 1e12 ? expires : expires * 1000 }),
    });
  }
  const horizon = Date.now() + 15 * 24 * 3600_000;
  const expiringSoon = packages
    .filter((item) => item.expiresAtMs !== undefined && item.expiresAtMs <= horizon)
    .reduce((sum, item) => sum + item.amount, 0);
  const nearest = packages
    .map((item) => item.expiresAtMs)
    .filter((value): value is number => value !== undefined)
    .sort((left, right) => left - right)[0];
  return {
    total,
    packages,
    expiringSoon,
    ...(nearest === undefined ? {} : { nearestExpiryMs: nearest }),
  };
}

/** 解析扫码会话；`scan_path` 必须通过同源校验。 */
export function parseQrSession(payload: unknown, siteOrigin?: string): QrSession {
  const data = obj(obj(payload)?.['data']) ?? obj(payload) ?? {};
  const code = str(data['qrcode_code']);
  const scanPath = str(data['scan_path']);
  const expiresInSec = num(data['expires_in']);
  const pollIntervalMs = (num(data['poll_interval']) ?? 2) * 1000;
  if (code === undefined || scanPath === undefined || expiresInSec === undefined || expiresInSec <= 0 || expiresInSec > 3600) {
    throw new RaccoonError({ code: 'invalid-response', message: '小浣熊登录服务返回的二维码信息不完整' });
  }
  assertSameOriginPath(scanPath, endpointsOf(siteOrigin).site);
  return { code, scanPath, expiresInSec, pollIntervalMs };
}

/** 服务端给的落地路径必须是本站内的一条相对路径。 */
function assertSameOriginPath(scanPath: string, site: string): void {
  if (!scanPath.startsWith('/') || scanPath.startsWith('//') || /[\\\s#]/.test(scanPath)) {
    throw new RaccoonError({ code: 'invalid-response', message: '小浣熊返回了无效的扫码地址' });
  }
  const url = new URL(scanPath, site);
  // 本地测试服务器是 http://127.0.0.1，其余场景仍要求 https 同源。
  const expectedProtocol = site.startsWith('https:') ? 'https:' : 'http:';
  if (url.protocol !== expectedProtocol || url.origin !== new URL(site).origin || url.hash !== '') {
    throw new RaccoonError({ code: 'invalid-response', message: '小浣熊返回了无效的扫码地址' });
  }
}

/** 把一次轮询响应当成状态机读；网络抖动与超时不算失败。 */
function pollQrOnce(
  call: (input: { url: string; method: string; headers: Record<string, string>; body: unknown }) => Promise<unknown>,
  code: string,
  endpoints: Endpoints,
): Promise<QrPoll> {
  return call({
    url: `${endpoints.iam}/auth/mp/qrcode/login`,
    method: 'POST',
    headers: identityHeaders(endpoints.site),
    body: { qrcode_code: code },
  }).then(
    (payload): QrPoll => {
      const data = obj(obj(payload)?.['data']) ?? {};
      const status = str(data['status']) ?? '';
      if (status === 'success') {
        const accessToken = stripBearer(data['access_token']);
        const tokenType = str(data['token_type']);
        if (accessToken === '') {
          return { status: 'error', message: '扫码成功但响应里没有访问令牌' };
        }
        if (tokenType !== undefined && tokenType.toLowerCase() !== 'bearer') {
          return { status: 'error', message: `扫码返回了不支持的令牌类型 ${tokenType}` };
        }
        return { status: 'success', accessToken };
      }
      if (status === 'logging') return { status: 'scanning' };
      if (status === 'canceled') return { status: 'canceled', message: '你取消了这次授权' };
      return { status: 'pending' };
    },
    (error: unknown): QrPoll => {
      // 一次抖动不能杀死用户正在完成的登录：只有明确的过期才终止。
      if (error instanceof RaccoonError) {
        if (error.code === 'qr-expired') return { status: 'expired', message: error.message };
        if (error.code === 'qr-invalid') return { status: 'error', message: error.message };
        return { status: 'pending' };
      }
      return { status: 'pending' };
    },
  );
}

/** 解析换 token 的响应。 */
export function parseTokenPair(payload: unknown): TokenPair {
  const data = obj(obj(payload)?.['data']) ?? {};
  const accessToken = stripBearer(data['access_token']);
  const refreshToken = stripBearer(data['refresh_token']);
  if (accessToken === '') {
    // 有业务码就按上游语义分类（200035 是「授权码失效」），没有才归到无效响应。
    const classified = classifyUpstream({ status: 400, payload, fallback: '换取登录凭证失败' });
    throw classified.upstreamCode === null
      ? new RaccoonError({ code: 'invalid-response', message: '换取登录凭证的响应里没有访问令牌' })
      : classified;
  }
  const identity = str(data['office_identity']);
  const orgName = str(data['office_org_name']);
  const orgRole = str(data['office_org_role']);
  return {
    accessToken,
    refreshToken,
    ...(identity === undefined ? {} : { identity }),
    ...(orgName === undefined ? {} : { orgName }),
    ...(orgRole === undefined ? {} : { orgRole }),
  };
}

/** 从 `Set-Cookie` 行里取指定名字的值。 */
function cookieValue(lines: readonly string[], matches: (name: string) => boolean): string | undefined {
  for (const line of lines) {
    const pair = line.split(';', 1)[0] ?? '';
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    const name = pair.slice(0, index).trim();
    if (!matches(name)) continue;
    const raw = pair.slice(index + 1).trim().replace(/^"|"$/g, '');
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}
