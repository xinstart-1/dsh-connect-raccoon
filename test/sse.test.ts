import test from 'node:test';
import assert from 'node:assert/strict';

import { findFailureInChunk, frameFailure, isRateLimitedFrame } from '../src/protocol/sse.ts';

test('frameFailure：标准 error 帧 → 取出 code 与 message', () => {
  const result = frameFailure({ error: { code: 'user_model_rate_limited', message: '频率超限' } });
  assert.deepEqual(result, { code: 'user_model_rate_limited', message: '频率超限' });
});

test('frameFailure：error 是字符串 → 只当 message', () => {
  assert.deepEqual(frameFailure({ error: '上游炸了' }), { message: '上游炸了' });
});

test('frameFailure：正常帧（有 choices）→ 不算失败', () => {
  assert.equal(
    frameFailure({ choices: [{ delta: { content: '你好' } }] }),
    undefined,
    '带 choices 的帧永远是正常数据，把它当错误会让每一次正常回复都被判失败',
  );
});

test('frameFailure：顶层 {code,message} 且没有 choices → 当失败', () => {
  assert.deepEqual(frameFailure({ code: '200003', message: 'authorization_verify_error' }), {
    code: '200003',
    message: 'authorization_verify_error',
  });
});

test('frameFailure：顶层 code 但**有** choices → 不算失败', () => {
  // 有的网关会在正常帧里也带一个状态码。只因为有 code 就判失败会误伤。
  assert.equal(frameFailure({ code: 0, choices: [{ delta: {} }] }), undefined);
});

test('frameFailure：空对象 / 非对象 / 空 error → undefined', () => {
  assert.equal(frameFailure({}), undefined);
  assert.equal(frameFailure(null), undefined);
  assert.equal(frameFailure('text'), undefined);
  assert.equal(frameFailure({ error: null }), undefined);
  assert.equal(frameFailure({ error: {} }), undefined);
});

test('isRateLimitedFrame：限流码 → true（决定要不要换号）', () => {
  assert.equal(isRateLimitedFrame({ code: 'user_model_rate_limited' }), true);
  assert.equal(isRateLimitedFrame({ message: '您的模型请求频率超限' }), true);
  assert.equal(isRateLimitedFrame({ code: 'rate_limit_exceeded' }), true);
});

test('isRateLimitedFrame：令牌失效不是限流 → false', () => {
  assert.equal(isRateLimitedFrame({ code: '200003', message: 'authorization_verify_error' }), false);
  assert.equal(isRateLimitedFrame(undefined), false);
});

test('findFailureInChunk：从多帧文本里找出错误帧', () => {
  const chunk = [
    'data: {"choices":[{"delta":{"content":"a"}}]}',
    '',
    'data: {"error":{"code":"user_model_rate_limited","message":"频率超限"}}',
    '',
  ].join('\n');
  const found = findFailureInChunk(chunk);
  assert.equal(found?.code, 'user_model_rate_limited');
  assert.equal(isRateLimitedFrame(found), true);
});

test('findFailureInChunk：正常数据与 [DONE] 不误判', () => {
  const chunk = 'data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n';
  assert.equal(findFailureInChunk(chunk), undefined);
});

test('findFailureInChunk：半帧（JSON 不完整）跳过而不抛', () => {
  // 上游的帧会跨 TCP 块被切断；这里不能因为「解析失败」就把整条流判成错误。
  const chunk = 'data: {"choices":[{"delta":{"content":"半';
  assert.equal(findFailureInChunk(chunk), undefined);
});

test('findFailureInChunk：非 data 行（event: / 空行 / 注释）忽略', () => {
  const chunk = ': keep-alive\nevent: message\n\n';
  assert.equal(findFailureInChunk(chunk), undefined);
});
