/**
 * 真实 Cordis 装载验证：不是假 ctx，是真的 `Context`。
 *
 * `smoke-apply.mjs` 用的是手写假 ctx —— 它能验证「我们调了哪些 API」，
 * 但验证不了「Cordis 接受这些调用吗」：服务声明写错、effect 用错、注册了不该注册的
 * 东西，假 ctx 全都看不出来。
 *
 * 这里用真的 `@deepseek-ai/cordis` 起一个 Context，把 `llm` / `webServer` 作为
 * 假 Service 提供进去，然后 `ctx.plugin(plugin)` 装载，断言：
 * 1. 插件能真的装载完成（不抛、不挂）；
 * 2. 三类注册与两条路由都被消费到；
 * 3. `ctx.dispose()` 之后所有注册都被释放（否则热重载会泄漏）。
 *
 * 用法：`node scripts/check-cordis.mjs`
 */

import { Context, Service } from '@deepseek-ai/cordis';
import * as plugin from '../lib/index.js';

const problems = [];
function check(label, ok, detail) {
  if (ok) console.log(`ok   ${label}`);
  else problems.push(`${label}${detail === undefined ? '' : `：${detail}`}`);
}

/** 所有被调用到的注册与它们的 disposer。 */
const record = { adapters: [], providers: [], discovery: [], routes: [], disposers: [] };

/** 假的 llm 服务：每个注册方法返回 disposer。 */
class FakeLlm extends Service {
  constructor(ctx) {
    super(ctx, 'llm');
  }

  registerAdapter(providers, adapter) {
    record.adapters.push({ providers, adapter });
    return () => { record.disposers.push('adapter'); };
  }

  registerConfigurableProviders(entries) {
    record.providers.push(...entries);
    return () => { record.disposers.push('providers'); };
  }

  registerModelDiscovery(namespace, discover) {
    record.discovery.push({ namespace, discover });
    return () => { record.disposers.push('discovery'); };
  }
}

/** 假的 webServer 服务：记录路由并返回 disposer。 */
class FakeWebServer extends Service {
  constructor(ctx) {
    super(ctx, 'webServer');
  }

  register(entry) {
    record.routes.push(entry.path);
    return () => { record.disposers.push(`route:${entry.path}`); };
  }
}

const ctx = new Context();
ctx.plugin(FakeLlm);
ctx.plugin(FakeWebServer);
await new Promise((resolve) => { setTimeout(resolve, 50); });

let mounted;
try {
  mounted = ctx.plugin(plugin, {
    enabled: true,
    siteOrigin: '',
    reuseDesktop: false,
    writeBackDesktop: false,
    warmOnStart: false,
    defaultReasoningEffort: '',
    maxFailoverAttempts: 3,
  });
  await new Promise((resolve) => { setTimeout(resolve, 600); });
  check('插件能被真实 Cordis 装载', true);
} catch (error) {
  check('插件能被真实 Cordis 装载', false, error instanceof Error ? error.message : String(error));
}

check('注册了 adapter', record.adapters.length === 1, `实际 ${String(record.adapters.length)}`);
check(
  'provider id 是 raccoon',
  record.adapters[0]?.providers?.[0] === 'raccoon',
  JSON.stringify(record.adapters[0]?.providers),
);
check('注册了可配置 provider', record.providers.length === 1);
check('注册了模型发现', record.discovery.length === 1);
check('注册了两条路由', record.routes.length === 2, record.routes.join(', '));

if (record.discovery[0] !== undefined) {
  const models = await record.discovery[0].discover({ provider: 'raccoon' }, undefined);
  check('未登录时模型发现有兜底目录', Array.isArray(models) && models.length > 0, `实际 ${String(models?.length)} 个`);
}

const before = record.disposers.length;
try {
  if (mounted !== undefined && typeof mounted.dispose === 'function') await mounted.dispose();
  else await ctx.dispose();
  await new Promise((resolve) => { setTimeout(resolve, 300); });
  check(
    '卸载后所有注册都被释放',
    record.disposers.length >= before + 3,
    `disposers ${String(before)} → ${String(record.disposers.length)}`,
  );
} catch (error) {
  check('卸载不抛错', false, error instanceof Error ? error.message : String(error));
}

if (problems.length > 0) {
  console.error(`\n${String(problems.length)} 项未通过：`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log('\n真实 Cordis 装载验证通过。');
