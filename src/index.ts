/**
 * Cordis 插件入口：装配仓库、账号、运行时、LLM 注册与宿主路由。
 *
 * 装配顺序很重要：**adapter 注册不能等网络** —— 目录先用内置兜底注册上，
 * 登录态可用时再替换。否则「刚装好还没登录」的用户会看到选择器里一个模型都没有，
 * 而那个空选择器不会自己变好（除非重启）。
 *
 * 这里只负责接线：谁先谁后、谁在卸载时释放什么。真正的行为在
 * `host/runtime.ts`（状态与动作）、`protocol/`（上游契约）、
 * `credentials/`（登录态）、`shim/server.ts`（换号）里，各自可单测。
 *
 * @module dsh-connect-raccoon
 */

import { spawn } from 'node:child_process';
import type { Context } from '@deepseek-ai/cordis';
import { Config, type RaccoonConfig } from './config.ts';
import { PROVIDER, SETTINGS_NS, VERSION } from './constants.ts';
import { dshHome, readState, writeState, type PluginState } from './state.ts';
import { createVault } from './credentials/vault.ts';
import { createRefresher, type Refresher } from './credentials/refresh.ts';
import { createRaccoonClient, type RaccoonClient } from './protocol/client.ts';
import { FALLBACK_CATALOG, type CatalogModel } from './protocol/catalog.ts';
import { createAccounts } from './host/accounts.ts';
import { createRuntime, type Runtime } from './host/runtime.ts';
import { registerRoutes } from './host/routes.ts';
import { createRaccoonAdapter, toLlmModelInfos } from './llm/adapter.ts';
import { failoverCandidates, pickAccount } from './host/pool.ts';
import { startShim, type ShimHandle } from './shim/server.ts';

/** 插件名（Cordis 用它做诊断前缀）。 */
export const name = 'dsh-connect-raccoon';

/** 依赖的服务：没有 llm 就没有模型路由可注册。 */
export const inject = ['llm'];

/**
 * 用系统默认浏览器打开一个 URL。
 *
 * Windows 上**不能**走 `cmd /c start`：cmd 会把 URL 里的 `&` 当成命令分隔符，
 * 浏览器只拿到 `?login_source=desktop` 那一段（缺 redirect 与 state），授权页会
 * 直接判为普通网页登录、不再回调本地端口。
 *
 * 用两条路径，因为单靠一条会静默失败：`rundll32` 稳定返回 0，
 * `explorer.exe` 有时浏览器仍然弹出来但退出码是 1。
 *
 * @param url - 要打开的地址。
 * @returns 是否至少有一条启动路径被系统接受。
 */
function openBrowser(url: string): boolean {
  if (process.platform !== 'win32') {
    const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
    try {
      const child = spawn(command, [url], { detached: true, stdio: 'ignore' });
      child.unref();
      return true;
    } catch {
      return false;
    }
  }
  const launchers: Array<[string, string[]]> = [
    ['rundll32.exe', ['url.dll,FileProtocolHandler', url]],
    ['explorer.exe', [url]],
  ];
  let opened = false;
  for (const [file, args] of launchers) {
    try {
      const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', () => undefined);
      child.unref();
      opened = true;
    } catch {
      // 换下一条路径。
    }
  }
  return opened;
}

/**
 * 插件应用函数。
 *
 * @param ctx - Cordis 上下文。
 * @param rawConfig - 用户在设置页填的配置。
 */
export async function apply(ctx: Context, rawConfig: RaccoonConfig): Promise<void> {
  const config = { ...Config({}), ...rawConfig } as RaccoonConfig;
  const warn = (message: string): void => {
    ctx.logger.warn(`[${name}] ${message}`);
  };

  const home = dshHome();
  const vault = createVault({ home });
  const client: RaccoonClient = createRaccoonClient({ warn });
  const refresher: Refresher = createRefresher({ warn });
  const accountState: { current: PluginState } = { current: await readState({ home }) };

  /** 目录：先兜底，登录态可用后换成网关那份。 */
  let catalog: CatalogModel[] = [...FALLBACK_CATALOG];
  let shim: ShimHandle | undefined;
  let runtime: Runtime | undefined;
  let adapter: ReturnType<typeof createRaccoonAdapter> | undefined;
  let disposed = false;

  const accounts = createAccounts({
    vault,
    client,
    refresher,
    warn,
    reuseDesktop: () => config.reuseDesktop,
    writeBackDesktop: () => config.writeBackDesktop,
  });

  runtime = createRuntime({
    vault,
    accounts,
    client,
    warn,
    openBrowser,
    state: () => accountState.current,
    async saveState(patch) {
      accountState.current = await writeState(patch, { home });
      return accountState.current;
    },
    config: () => ({ enabled: config.enabled, reuseDesktop: config.reuseDesktop }),
    onCatalog: (models) => {
      catalog = [...models];
      adapter?.invalidate();
    },
  });

  // 1. 起 shim：换号必须发生在请求发出之前，而那需要比 pi-ai 更早的一层。
  shim = await startShim({
    attempts: async ({ model }) => {
      const state = accountState.current;
      const all = await vault.list();
      const selected = await vault.readSelected();
      const candidates = all.map((account) => ({
        id: account.id,
        inPool: state.enabledAccounts.includes(account.id),
        usable: accounts.usability(account).usable,
        credits: undefined as number | undefined,
        nearestExpiryMs: undefined as number | undefined,
        expiresAtMs: account.expiresAtMs,
      }));
      const choice = pickAccount({ poolEnabled: state.accountPoolEnabled, currentId: selected, candidates });
      const order = [choice.id, ...failoverCandidates({
        poolEnabled: state.accountPoolEnabled,
        currentId: selected,
        candidates,
        firstId: choice.id,
      })];
      void model;
      return order
        .filter((id): id is string => id !== undefined)
        .slice(0, Math.max(1, config.maxFailoverAttempts))
        .map((id) => ({ accountId: id, accessToken: () => accounts.accessToken(id) }));
    },
    chat: (input) => client.chatStream({ accessToken: input.accessToken, body: input.body, signal: input.signal }),
    onFailover: (detail) => {
      warn(`自动换号：${detail.fromId} → ${detail.toId}（${detail.code}：${detail.reason}）`);
      // 刚失败过的账号先退出候选池：否则下一个请求又会挑到它，白烧一次失败。
      // 限流与令牌失效要等久一点，其余（5xx / 网络）只压一分钟。
      const ms = detail.code === 'rate-limited' || detail.code === 'authorization-verify'
        ? 10 * 60_000
        : 60_000;
      accounts.markCooldown(detail.fromId, ms);
    },
    onWarn: warn,
  });

  // 2. 装配 adapter 并注册。目录是兜底也能注册 —— 见文件头注释。
  adapter = createRaccoonAdapter({
    catalog: () => catalog,
    baseUrl: () => shim?.baseUrl ?? 'http://127.0.0.1:1',
    token: () => shim?.token ?? '',
  });

  const releaseAdapter = ctx.llm.registerAdapter([PROVIDER], adapter.adapter);
  const releaseDirectory = ctx.llm.registerConfigurableProviders([
    {
      provider: PROVIDER,
      displayName: '商汤小浣熊',
      settingsNs: SETTINGS_NS,
      settingsPath: [],
      declared: false,
    },
  ]);
  ctx.llm.registerModelDiscovery(SETTINGS_NS, async (request) => {
    if (request.provider !== undefined && request.provider !== PROVIDER) return [];
    if (!config.enabled) return [];
    return toLlmModelInfos(catalog);
  });

  // 3. 卡片/胶囊用的两条宿主路由（令牌不进页面）。
  registerRoutes(ctx as unknown as Parameters<typeof registerRoutes>[0], {
    status: () => runtime?.status() ?? Promise.resolve({}),
    action: (action, body) => runtime?.run(action, body) ?? Promise.resolve({ ok: false }),
  });

  // 4. 生命周期：卸载时释放注册、路由、端口与登录服务器。
  ctx.effect(() => async () => {
    disposed = true;
    runtime?.dispose();
    releaseDirectory();
    releaseAdapter();
    const closing = shim?.close();
    shim = undefined;
    adapter = undefined;
    runtime = undefined;
    if (closing !== undefined) await closing;
  });

  // 5. 启动后预热：把网络请求推到 apply 之外（apply 期间宿主还在装配插件树）。
  if (config.warmOnStart) {
    const timer = setTimeout(() => {
      if (disposed) return;
      void runtime?.warm().catch((error: unknown) => {
        warn(`预热失败（不影响模型路由）：${error instanceof Error ? error.message : String(error)}`);
      });
    }, 0);
    timer.unref?.();
  }

  // 6. 配置变化：重新解析登录态与目录。
  const offUpdate = (
    ctx as unknown as {
      on(event: string, listener: () => void): (() => void) | void;
    }
  ).on('loader/volatile-update', () => {
    if (disposed) return;
    void runtime?.warm().catch(() => undefined);
  });
  if (typeof offUpdate === 'function') ctx.effect(() => offUpdate);

  ctx.logger.info(
    `[${name}] v${VERSION} 已启动：${String(catalog.length)} 个模型（shim ${shim.baseUrl}）`,
  );
}
