import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FALLBACK_CATALOG,
  MEASURED_TEXT_ONLY,
  MEASURED_VISION,
  parseCatalog,
  visibleModels,
} from '../src/protocol/catalog.ts';
import type { CatalogModel } from '../src/protocol/catalog.ts';
import { RaccoonError } from '../src/protocol/errors.ts';

/** 断言解析抛 RaccoonError 且分类码符合预期。 */
function expectParseError(payload: unknown, expected: string): RaccoonError {
  try {
    parseCatalog(payload);
  } catch (error) {
    assert.ok(error instanceof RaccoonError, `期望抛出 RaccoonError，实际抛出 ${String(error)}`);
    assert.equal(error.code, expected, `期望分类码 ${expected}，实际 ${error.code}（文案：${error.message}）`);
    return error;
  }
  assert.fail(`期望 parseCatalog 抛出 RaccoonError(code=${expected})，但调用成功返回了`);
}

/** 造一份单模型目录响应。 */
function catalogOf(rows: readonly unknown[]): unknown {
  return { code: 0, data: { categories: [{ models: rows }] } };
}

test('真实形状解析：{code:0,data:{categories:[{models:[…]}]}} → 一条模型、窗口与输出上限取 params、来源 live', () => {
  const payload = {
    code: 0,
    data: {
      categories: [
        {
          models: [
            {
              name: 'glm-5-3',
              model_name: 'glm-5-3',
              params: { context_window: 200000, max_tokens: 8192 },
              tags: ['vision'],
            },
          ],
        },
      ],
    },
  };
  const catalog = parseCatalog(payload, 1_760_000_000_000);
  assert.equal(catalog.models.length, 1, `应解析出 1 条模型，实际 ${catalog.models.length} 条`);
  const model = catalog.models[0]!;
  assert.equal(model.id, 'glm-5-3', `模型 id 应取 model_name=glm-5-3，实际 ${model.id}`);
  assert.equal(model.contextWindow, 200000, `contextWindow 应取 params.context_window=200000，实际 ${String(model.contextWindow)}`);
  assert.equal(model.maxTokens, 8192, `maxTokens 应取 params.max_tokens=8192，实际 ${String(model.maxTokens)}`);
  assert.equal(catalog.source, 'live', `实时解析的 source 应为 live，实际 ${catalog.source}`);
  assert.equal(catalog.fetchedAtMs, 1_760_000_000_000, 'fetchedAtMs 应使用注入的抓取时间');
});

test('隐藏行：目录行带 visible:false → 被跳过，只剩可见模型', () => {
  const catalog = parseCatalog(
    catalogOf([
      { model_name: 'hidden-model', visible: false },
      { model_name: 'shown-model' },
    ]),
  );
  assert.equal(catalog.models.length, 1, `visible:false 的行不应入选，期望 1 条，实际 ${catalog.models.length} 条`);
  assert.equal(catalog.models[0]!.id, 'shown-model', `应保留可见的 shown-model，实际 ${catalog.models[0]!.id}`);
});

test('同名去重：两条同 model_name 的行 → 只留第一条', () => {
  const catalog = parseCatalog(
    catalogOf([
      { name: '第一条', model_name: 'dup-model' },
      { name: '第二条', model_name: 'dup-model' },
    ]),
  );
  assert.equal(catalog.models.length, 1, `同名模型应只保留 1 条，实际 ${catalog.models.length} 条`);
  assert.equal(catalog.models[0]!.name, '第一条', `应保留第一条（name=第一条），实际 ${catalog.models[0]!.name}`);
});

test('缺 params：目录行没有窗口字段 → contextWindow=131072、maxTokens=8192 保守默认', () => {
  const catalog = parseCatalog(catalogOf([{ model_name: 'no-params-model' }]));
  const model = catalog.models[0]!;
  assert.equal(
    model.contextWindow,
    131072,
    `缺 params 时 contextWindow 应为保守默认 131072，实际 ${String(model.contextWindow)}`,
  );
  assert.equal(model.maxTokens, 8192, `缺 params 时 maxTokens 应为保守默认 8192，实际 ${String(model.maxTokens)}`);
});

test('识图实测表覆盖 tags：glm-5-3 带 vision 标签 → vision=false；kimi-k3 不带标签 → vision=true', () => {
  assert.ok(MEASURED_TEXT_ONLY.includes('glm-5-3'), 'MEASURED_TEXT_ONLY 应包含 glm-5-3（探针依据）');
  assert.ok(MEASURED_VISION.includes('kimi-k3'), 'MEASURED_VISION 应包含 kimi-k3（探针依据）');

  const catalog = parseCatalog(
    catalogOf([
      { model_name: 'glm-5-3', tags: ['vision'] },
      { model_name: 'kimi-k3' },
    ]),
  );
  const byId = new Map(catalog.models.map((model) => [model.id, model]));
  assert.equal(byId.get('glm-5-3')?.vision, false, `glm-5-3 实测不能读图，vision 应为 false，实际 ${String(byId.get('glm-5-3')?.vision)}`);
  assert.equal(byId.get('kimi-k3')?.vision, true, `kimi-k3 实测能读图，vision 应为 true，实际 ${String(byId.get('kimi-k3')?.vision)}`);
});

test('空目录：categories 为空数组 → 抛 RaccoonError，code=invalid-response', () => {
  expectParseError({ code: 0, data: { categories: [] } }, 'invalid-response');
});

test('200 带业务错误：{code:200003,message:…} → 抛错且保留 upstreamCode=200003', () => {
  const error = expectParseError(
    { code: 200003, message: 'authorization_verify_error' },
    'invalid-response',
  );
  assert.equal(error.upstreamCode, 200003, `应保留上游业务码 200003（数字），实际 ${String(error.upstreamCode)}`);
});

test('兜底目录：FALLBACK_CATALOG → 至少 3 条，且 id/name/contextWindow/maxTokens/vision 齐全、窗口为正数', () => {
  assert.ok(
    FALLBACK_CATALOG.length >= 3,
    `兜底目录至少要有 3 条才能撑起选择器，实际 ${FALLBACK_CATALOG.length} 条`,
  );
  for (const model of FALLBACK_CATALOG as readonly CatalogModel[]) {
    const where = `兜底条目 ${String(model.id)}`;
    assert.equal(typeof model.id, 'string', `${where}：id 应为字符串`);
    assert.ok(model.id.length > 0, `${where}：id 不应为空串`);
    assert.equal(typeof model.name, 'string', `${where}：name 应为字符串`);
    assert.ok(model.name.length > 0, `${where}：name 不应为空串`);
    assert.equal(typeof model.contextWindow, 'number', `${where}：contextWindow 应为数字`);
    assert.ok(model.contextWindow > 0, `${where}：contextWindow 应大于 0，实际 ${String(model.contextWindow)}`);
    assert.equal(typeof model.maxTokens, 'number', `${where}：maxTokens 应为数字`);
    assert.ok(model.maxTokens > 0, `${where}：maxTokens 应大于 0，实际 ${String(model.maxTokens)}`);
    assert.equal(typeof model.vision, 'boolean', `${where}：vision 应为布尔值`);
  }
});

test('禁用名单：visibleModels → 只过滤命中 id 的条目，其余顺序不变', () => {
  const models: CatalogModel[] = [
    { id: 'glm-5-3', name: 'GLM-5.3', vision: false, contextWindow: 131_072, maxTokens: 8_192, multiplier: '', reasoning: false },
    { id: 'kimi-k3', name: 'Kimi-K3', vision: true, contextWindow: 262_144, maxTokens: 8_192, multiplier: '', reasoning: false },
    { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', vision: true, contextWindow: 131_072, maxTokens: 8_192, multiplier: '', reasoning: false },
  ];
  const visible = visibleModels(models, ['kimi-k3']);
  assert.deepEqual(
    visible.map((model) => model.id),
    ['glm-5-3', 'deepseek-v4.1-flash'],
    `禁用 kimi-k3 后应剩 glm-5-3 与 deepseek-v4.1-flash，实际 ${JSON.stringify(visible.map((model) => model.id))}`,
  );
});
