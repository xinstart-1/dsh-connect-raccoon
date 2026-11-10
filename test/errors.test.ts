import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RaccoonError,
  UPSTREAM_CODE_MAP,
  classifyThrown,
  classifyUpstream,
} from '../src/protocol/errors.ts';
import type { UpstreamErrorCode } from '../src/protocol/errors.ts';

/** 断言一次分类结果；失败信息里带上分类码与文案，便于直接定位。 */
function expectCode(input: Parameters<typeof classifyUpstream>[0], expected: UpstreamErrorCode): RaccoonError {
  const error = classifyUpstream(input);
  assert.equal(
    error.code,
    expected,
    `HTTP ${String(input.status)} + payload ${JSON.stringify(input.payload ?? null)} 应分类为 ${expected}，实际 ${error.code}（文案：${error.message}）`,
  );
  return error;
}

test('业务码映射：UPSTREAM_CODE_MAP 的每个键 → classifyUpstream 返回对应分类码', () => {
  const entries = Object.entries(UPSTREAM_CODE_MAP);
  assert.ok(entries.length > 0, 'UPSTREAM_CODE_MAP 不应为空，否则这条用例什么也没校验');
  for (const [upstreamCode, expected] of entries) {
    const error = expectCode({ status: 400, payload: { code: upstreamCode } }, expected);
    assert.equal(
      error.upstreamCode,
      upstreamCode,
      `业务码 ${upstreamCode} 应保留原文，实际 ${String(error.upstreamCode)}`,
    );
  }
});

test('HTTP 状态兜底：无业务码的响应 → 按状态码分类', () => {
  const matrix: ReadonlyArray<readonly [number, UpstreamErrorCode]> = [
    [400, 'bad-request'],
    [401, 'authorization-verify'],
    [403, 'authorization-verify'],
    [404, 'model-not-found'],
    [429, 'rate-limited'],
    [500, 'upstream-error'],
  ];
  for (const [status, expected] of matrix) {
    expectCode({ status, payload: {} }, expected);
  }
});

test('未知业务码：payload 带 code=whatever_new 与中文 message → 保留原文、分类落到 upstream-error', () => {
  const error = classifyUpstream({
    status: 500,
    payload: { code: 'whatever_new', message: '上游的新说法' },
  });
  assert.equal(error.code, 'upstream-error', `未知业务码应分类为 upstream-error，实际 ${error.code}`);
  assert.equal(error.upstreamCode, 'whatever_new', `未知业务码应保留原文，实际 ${String(error.upstreamCode)}`);
  assert.equal(error.message, '上游的新说法', `未知业务码应原样透出上游文案，实际「${error.message}」`);
});

test('换号策略：各分类码的 retriableWithOtherAccount → 400 一类为 false，其余可重试为 true', () => {
  const matrix: ReadonlyArray<readonly [UpstreamErrorCode, boolean]> = [
    ['bad-request', false],
    ['code-not-found', false],
    ['model-not-found', false],
    ['authorization-empty', false],
    ['authorization-verify', true],
    ['rate-limited', true],
    ['out-of-credit', true],
    ['upstream-error', true],
    ['network-error', true],
    ['timeout', true],
  ];
  for (const [code, expected] of matrix) {
    const error = new RaccoonError({ code, message: '用例' });
    assert.equal(
      error.retriableWithOtherAccount,
      expected,
      `分类码 ${code} 的 retriableWithOtherAccount 应为 ${String(expected)}，实际 ${String(error.retriableWithOtherAccount)}`,
    );
  }
});

test('嵌套信封：payload 形如 {error:{code,message}} → 仍能取出业务码并分类', () => {
  const error = classifyUpstream({
    status: 401,
    payload: { error: { code: '200003', message: 'authorization_verify_error' } },
  });
  assert.equal(error.code, 'authorization-verify', `嵌套信封的业务码应被识别，实际分类 ${error.code}`);
  assert.equal(error.upstreamCode, '200003', `嵌套信封应保留业务码 200003，实际 ${String(error.upstreamCode)}`);
});

test('classifyThrown：普通 Error → network-error；TimeoutError → timeout；已是 RaccoonError → 原样返回', () => {
  const network = classifyThrown(new Error('ECONNRESET'));
  assert.equal(network.code, 'network-error', `普通 Error 应归为 network-error，实际 ${network.code}`);

  const timeout = classifyThrown({ name: 'TimeoutError' });
  assert.equal(timeout.code, 'timeout', `TimeoutError 应归为 timeout，实际 ${timeout.code}`);

  const original = new RaccoonError({ code: 'rate-limited', message: '用例' });
  const passed = classifyThrown(original);
  assert.equal(passed, original, '已是 RaccoonError 时应返回同一引用，不要重新包装');
});
