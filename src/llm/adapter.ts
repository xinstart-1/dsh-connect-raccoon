/**
 * DSH LLM 接入层：把本地 shim 包成一个 pi-ai provider。
 *
 * 这一层刻意很薄：协议翻译不存在（上游本就是 OpenAI 兼容），真正的工作在
 * `shim/server.ts`（换号）与 `protocol/`（上游契约）。这里只负责三件事：
 * 把目录映射成 pi-ai 的 `Model`；构造 `PiAiAdapterOptions`；每次请求用 shim 的
 * 共享密钥当 apiKey —— 真实的令牌不出宿主进程。
 *
 * @module dsh-connect-raccoon/llm/adapter
 */

import { PiAiAdapter, type PiAiAdapterOptions, type ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai';
import { resolveRetryPolicy, type LlmModelInfo } from '@deepseek-ai/dsh-llm';
import { createProvider, type Model, type Provider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { PROVIDER, REQUEST_IMAGE_BUDGETS, STREAM_IDLE_TIMEOUT_MS } from '../constants.ts';
import { INERT_AUTH } from '../credentials/inert-auth.ts';
import type { CatalogModel } from '../protocol/catalog.ts';

/** 小浣熊按积分计费，没有可得的按 token 单价：报 0（不伪造价格）。 */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** provider 展示名。 */
const DISPLAY_NAME = '商汤小浣熊';

/**
 * 思考档位映射。
 *
 * 上游对 `reasoning_effort` 只做**部分**校验：随便写的哨兵值也返回 200，
 * 所以「某档返回 200」证明不了它被真正执行（见 `docs/PROTOCOL.md`）。
 * 因此这里不声明任何档位，只在模型自身声明 reasoning 时把开关打开 ——
 * 宁可没有档位控制，也不给五个看起来能用、实际被忽略的选项。
 */
const THINKING_LEVELS = { low: 'low', medium: 'medium', high: 'high' } as const;

/** 把一个目录条目变成 pi-ai 的 chat model。 */
function toPiModel(info: CatalogModel, baseUrl: string): Model<'openai-completions'> {
  return {
    id: info.id,
    name: info.name,
    api: 'openai-completions',
    provider: PROVIDER,
    baseUrl,
    input: info.vision ? ['text', 'image'] : ['text'],
    cost: NO_COST,
    contextWindow: info.contextWindow,
    maxTokens: info.maxTokens,
    reasoning: info.reasoning,
    ...(info.reasoning
      ? { thinkingLevelMap: { ...THINKING_LEVELS }, compat: { supportsReasoningEffort: true } }
      : {}),
  };
}

/** adapter 与目录 / shim 的绑定关系。 */
export interface RaccoonAdapterOptions {
  /** 当前模型目录；每次重建 profile 时读一次。 */
  catalog: () => readonly CatalogModel[];
  /** shim 的 baseURL（不含 `/v1`）。 */
  baseUrl: () => string;
  /** shim 的共享密钥；未启动时为空串（请求会 401，而不是打上游）。 */
  token: () => string;
}

/** 一次装配的结果。 */
export interface RaccoonAdapter {
  adapter: PiAiAdapter;
  /** 目录变化后调用；下一次请求会重建 profiles。 */
  invalidate: () => void;
}

/**
 * 构造 pi-ai provider + PiAiAdapter。
 *
 * @param options - 目录与 shim 身份的读取器。
 * @returns 可直接交给 `ctx.llm.registerAdapter` 的 adapter。
 */
export function createRaccoonAdapter(options: RaccoonAdapterOptions): RaccoonAdapter {
  const modelsBase = (): string => `${options.baseUrl()}/v1`;

  const buildProvider = (): Provider<'openai-completions'> =>
    createProvider({
      id: PROVIDER,
      name: DISPLAY_NAME,
      auth: {
        apiKey: {
          name: '小浣熊（本地 shim）',
          async resolve({ credential }) {
            const key = credential?.key;
            return key === undefined || key.length === 0
              ? undefined
              : { auth: { apiKey: key }, source: DISPLAY_NAME };
          },
        },
      },
      models: options.catalog().map((info) => toPiModel(info, modelsBase())),
      api: openAICompletionsApi(),
    });

  const profileFor = (providerKey: string): ResolvedPiAiProviderProfile => {
    const provider = buildProvider();
    return {
      provider: providerKey,
      displayName: DISPLAY_NAME,
      streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
      retryPolicy: resolveRetryPolicy(undefined, 'dsh-connect-raccoon retryPolicy'),
      configuredMaxTokens: new Map<string, number>(),
      modelErrors: new Map<string, string>(),
      ...REQUEST_IMAGE_BUDGETS,
      piProvider: providerKey === PROVIDER ? provider : { ...provider, id: providerKey },
    };
  };

  let profiles = new Map<string, ResolvedPiAiProviderProfile>([[PROVIDER, profileFor(PROVIDER)]]);

  const config: PiAiAdapterOptions = {
    profiles: () => profiles,
    auth: INERT_AUTH,
    resolveApiKey: async () => options.token(),
  };

  const adapter = new PiAiAdapter(config);

  return {
    adapter,
    invalidate: () => {
      // pi-ai 的 provider 模型列表是快照；目录变了必须重建 provider。
      profiles = new Map([[PROVIDER, profileFor(PROVIDER)]]);
    },
  };
}

/**
 * 把目录条目转成 DSH 的 `LlmModelInfo`（模型发现接口要用）。
 *
 * @param models - 目录。
 * @returns DSH 侧的模型描述；`badge` 用上游促销文案。
 */
export function toLlmModelInfos(models: readonly CatalogModel[]): LlmModelInfo[] {
  return models.map((model) => ({
    provider: PROVIDER,
    id: model.id,
    name: model.name,
    description:
      model.multiplier === ''
        ? `${String(Math.round(model.contextWindow / 1000))}K 上下文`
        : `${String(Math.round(model.contextWindow / 1000))}K 上下文 · 倍率 ${model.multiplier}`,
    inputModalities: model.vision ? (['text', 'image'] as const) : (['text'] as const),
    ...(model.promo === undefined ? {} : { badge: { text: model.promo, tone: 'info' as const } }),
  }));
}
