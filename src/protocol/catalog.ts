/**
 * 模型目录：解析、兜底、以及「上游标签不可信」的覆盖表。
 *
 * 上游 `GET /llm/v2/model_catalog` 返回 `{code, data:{categories:[{models:[…]}]}}`。
 * 目录是模型选择器唯一的真源，所以解析必须**宽进严出**：字段缺失用保守默认，
 * 结构完全不对才抛错 —— 空目录会让选择器整组消失。
 *
 * @module dsh-connect-raccoon/protocol/catalog
 */

import { RaccoonError } from './errors.ts';

/** 一条模型目录条目。 */
export interface CatalogModel {
  /** 发请求用的 model id（`model_name`，缺则 `name`）。 */
  id: string;
  /** 给人看的名字。 */
  name: string;
  description?: string;
  /** 能否读图；按 {@link MEASURED_VISION} 与 `tags` 共同判定。 */
  vision: boolean;
  /** 上下文窗口（token）。 */
  contextWindow: number;
  /** 单次输出上限（token）。 */
  maxTokens: number;
  /** 计费倍率，例如 `x0.00`；拿不到为空串。 */
  multiplier: string;
  /** 促销文案；没有进行中的活动时缺省。 */
  promo?: string;
  /** 认不认 `reasoning_effort`（上游目录没有结构化声明，这里恒为 false）。 */
  reasoning: boolean;
}

/** 目录快照。 */
export interface Catalog {
  models: CatalogModel[];
  fetchedAtMs: number;
  source: 'live' | 'saved' | 'fallback';
}

/** 目录里没有 `params` 时的保守默认：宁可少宣称，也不要假装 1M 窗口。 */
const DEFAULT_CONTEXT_WINDOW = 131_072;
/** 见 {@link DEFAULT_CONTEXT_WINDOW}。 */
const DEFAULT_MAX_TOKENS = 8_192;

/**
 * 实测能读图的模型 id（前缀匹配）。
 *
 * 上游目录里唯一的能力信号是 `tags` 里的 `vision`，而实测它**两个方向都错过**：
 * 有标签却把图片直接丢掉（模型回「我看不到这张图片」，比拒绝更难发现），
 * 没标签却真的能读图。所以以实测为准，`tags` 只作为未知模型的线索。
 * 新上架的 id 不在表里时按 `tags` 判，用户可在卡片里手工纠正。
 */
export const MEASURED_VISION: readonly string[] = Object.freeze([
  'sensenova-6.8-flash-lite',
  'kimi-k3',
  'glm-5-3-flash',
  'deepseek-v4.1-flash',
]);

/** 实测**不能**读图但打了 `vision` 标签的模型 id。优先级高于 {@link MEASURED_VISION}。 */
export const MEASURED_TEXT_ONLY: readonly string[] = Object.freeze(['glm-5-3']);

/**
 * 静态兜底目录。
 *
 * 目录请求全失败时也要能注册出模型，否则「刚装好还没登录」的用户会看到
 * 选择器里一个模型都没有，而那个空选择器不会自己变好。字段值是**保守估计**，
 * 名字里带「兜底」提示，避免被当成上游的真实声明。
 */
export const FALLBACK_CATALOG: readonly CatalogModel[] = Object.freeze([
  {
    id: 'sensenova-6.8-flash-lite',
    name: 'SenseNova-6.8-Flash-Lite',
    description: '兜底目录条目：登录后会被上游目录替换',
    vision: true,
    contextWindow: 131_072,
    maxTokens: 8_192,
    multiplier: '',
    reasoning: false,
  },
  {
    id: 'kimi-k3',
    name: 'Kimi-K3',
    description: '兜底目录条目：登录后会被上游目录替换',
    vision: true,
    contextWindow: 262_144,
    maxTokens: 8_192,
    multiplier: '',
    reasoning: false,
  },
  {
    id: 'deepseek-v4.1-flash',
    name: 'DeepSeek-V4.1-Flash',
    description: '兜底目录条目：登录后会被上游目录替换',
    vision: true,
    contextWindow: 131_072,
    maxTokens: 8_192,
    multiplier: '',
    reasoning: false,
  },
] as CatalogModel[]);

/** 从任意值里取字符串。 */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** 从任意值里取正整数。 */
function posInt(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

/** 取一个对象。 */
function obj(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 判一个 id 是否命中表（允许上游带前缀/后缀变体）。 */
function hits(id: string, table: readonly string[]): boolean {
  const lower = id.toLowerCase();
  return table.some((entry) => lower === entry || lower.startsWith(`${entry}-`) || lower.includes(entry));
}

/** 按实测表 + `tags` 判定识图能力。 */
export function decideVision(id: string, tags: readonly string[]): boolean {
  if (hits(id, MEASURED_TEXT_ONLY)) return false;
  if (hits(id, MEASURED_VISION)) return true;
  return tags.some((tag) => tag.toLowerCase() === 'vision');
}

/** 把一条目录行的倍率字段拼成展示串。 */
function multiplierOf(row: Record<string, unknown>): string {
  const direct = str(row['billing_multiplier']) ?? str(row['multiplier']);
  if (direct !== undefined) return direct.startsWith('x') ? direct : `x${direct}`;
  const billing = obj(row['billing']);
  const nested = billing === undefined ? undefined : str(billing['multiplier']);
  if (nested !== undefined) return nested.startsWith('x') ? nested : `x${nested}`;
  return '';
}

/** 取促销文案；只认结构里明确带时间窗或文案的字段。 */
function promoOf(row: Record<string, unknown>): string | undefined {
  const direct = str(row['promotion']) ?? str(row['promo_label']) ?? str(row['discount_label']);
  if (direct !== undefined) return direct;
  const promo = obj(row['promotion_info']);
  return promo === undefined ? undefined : str(promo['label']) ?? str(promo['title']);
}

/** 解析一条目录行；缺 id 的行返回 `undefined`。 */
function parseRow(raw: unknown): CatalogModel | undefined {
  const row = obj(raw);
  if (row === undefined) return undefined;
  const id = str(row['model_name']) ?? str(row['name']);
  if (id === undefined) return undefined;
  if (row['visible'] === false) return undefined;
  const tags = Array.isArray(row['tags'])
    ? row['tags'].filter((tag): tag is string => typeof tag === 'string')
    : [];
  const params = obj(row['params']) ?? {};
  const promo = promoOf(row);
  const description = str(row['display_description']) ?? str(row['description']);
  return {
    id,
    name: str(row['display_name']) ?? str(row['name']) ?? id,
    ...(description === undefined ? {} : { description }),
    vision: decideVision(id, tags),
    contextWindow: posInt(params['context_window']) ?? posInt(row['context_window']) ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: posInt(params['max_tokens']) ?? posInt(row['max_tokens']) ?? DEFAULT_MAX_TOKENS,
    multiplier: multiplierOf(row),
    ...(promo === undefined ? {} : { promo }),
    reasoning: false,
  };
}

/**
 * 解析 `GET /model_catalog` 的响应。
 *
 * @param payload - 已解析的响应体。
 * @param now - 抓取时间（测试注入）。
 * @returns 目录快照；同名模型第一个生效。
 * @throws {RaccoonError} 结构完全不是目录（`invalid-response`）或目录为空。
 */
export function parseCatalog(payload: unknown, now: number = Date.now()): Catalog {
  const root = obj(payload);
  if (root === undefined) {
    throw new RaccoonError({ code: 'invalid-response', message: '小浣熊模型目录不是 JSON 对象' });
  }
  // 业务错误也可能以 HTTP 200 回来：`code` 不是 0 / 'OK' 时先按错误处理。
  const code = root['code'];
  if (typeof code === 'number' && code !== 0) {
    throw new RaccoonError({
      code: 'invalid-response',
      message: str(root['message']) ?? `小浣熊模型目录返回 code=${String(code)}`,
      upstreamCode: code,
    });
  }
  if (typeof code === 'string' && code !== 'OK' && code !== 'ok') {
    throw new RaccoonError({
      code: 'invalid-response',
      message: str(root['message']) ?? `小浣熊模型目录返回 code=${code}`,
      upstreamCode: code,
    });
  }

  const data = obj(root['data']) ?? root;
  const categories = Array.isArray(data['categories']) ? data['categories'] : [];
  const models: CatalogModel[] = [];
  const seen = new Set<string>();
  for (const category of categories) {
    const rows = obj(category)?.['models'];
    if (!Array.isArray(rows)) continue;
    for (const raw of rows) {
      const model = parseRow(raw);
      if (model === undefined || seen.has(model.id)) continue;
      seen.add(model.id);
      models.push(model);
    }
  }
  if (models.length === 0) {
    throw new RaccoonError({ code: 'invalid-response', message: '小浣熊返回的模型目录为空' });
  }
  return { models, fetchedAtMs: now, source: 'live' };
}

/** 按禁用名单过滤目录（过滤发生在出口，选择器读不到就不会出现）。 */
export function visibleModels(models: readonly CatalogModel[], disabled: readonly string[]): CatalogModel[] {
  const off = new Set(disabled);
  return models.filter((model) => !off.has(model.id));
}
