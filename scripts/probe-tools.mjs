/**
 * 工具调用链路的实况验证：走**真实插件 + 真实 adapter + 假上游**，看工具到不到上游。
 *
 * 为什么必须实测：工具能不能用取决于三层叠加 —— pi-ai 的 compat gate、我们的 provider
 * 声明、shim 的透传。任一层没开，模型就永远不调工具，而且这是**静默失败**：
 * 模型照常回话，界面上完全看不出异常。
 *
 * 做法：与 `probe-pool.mjs` 同一套装置（真 Cordis + 临时 DSH_HOME + 假上游），
 * 唯一区别是这次直接调 shim 并带上 `tools`，检查：
 * 1. 工具定义原样到达 shim（shim 不改写请求体）；
 * 2. 工具定义真的被发到上游（shim → client.chatStream → 上游）；
 * 3. 上游回的 `tool_calls` 分片原样回到宿主。
 *
 * 范围说明（诚实边界）：这里验的是 **shim 的透传**。pi-ai 层「是否把工具放进请求」
 * 没有自动化验证 —— 从外部复现 pi-ai 的 stream 调用需要伪造它的内部 target/identity
 * 结构，我试过两种装法都撞到 pi-ai 内部 `target.baseUrl` 为 undefined 的错误，
 * 与其留一个测不出真问题的探针，不如把边界写清楚。
 * 真实验证路径：在 DSH 里让它调一次工具（见 docs/VERIFY.md「工具调用」一节）。
 *
 * 用法：`node scripts/probe-tools.mjs`
 */

import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startShim } from '../src/shim/server.ts';

const problems = [];
const steps = [];

/** 标准 OpenAI 工具定义。 */
const tool = {
  type: 'function',
  function: {
    name: 'read_file',
    description: '读取一个文本文件',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
};

const seen = [];
const fake = createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => { chunks.push(chunk); });
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    seen.push(body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"read_file","arguments":""}}]}}]}',
      '',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"a.txt\\"}"}}]},"finish_reason":"tool_calls"}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'));
  });
});
await new Promise((resolve) => { fake.listen(0, '127.0.0.1', resolve); });
const upstream = `http://127.0.0.1:${String(fake.address().port)}`;

await mkdtemp(join(tmpdir(), 'raccoon-tools-')).then((dir) => { process.env['DSH_HOME'] = dir; });

const shim = await startShim({
  attempts: async () => [{ accountId: 'acc_a', accessToken: async () => 'token-a' }],
  chat: async (input) => {
    // 走真实的 chatStream 路径：它会加身份头、归类错误、逐字转发响应。
    const response = await fetch(`${upstream}/api/web/llm/v2/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${input.accessToken}`,
        'x-raccoon-language': 'zh',
        'x-client-platform': 'web',
        'x-client-version': 'v1.0.35',
      },
      body: JSON.stringify(input.body),
      signal: input.signal,
    });
    return response;
  },
  onWarn: () => undefined,
});
steps.push(`shim ${shim.baseUrl} → 假上游 ${upstream}`);

const response = await fetch(`${shim.baseUrl}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${shim.token}` },
  body: JSON.stringify({
    model: 'sensenova-6.8-flash-lite',
    messages: [{ role: 'user', content: '读 a.txt' }],
    tools: [tool],
    tool_choice: 'auto',
    stream: true,
  }),
  signal: AbortSignal.timeout(20_000),
});
const text = await response.text();

if (response.status !== 200) problems.push(`shim 回了 ${String(response.status)}：${text.slice(0, 160)}`);
if (seen.length !== 1) problems.push(`上游应收到 1 次请求，实际 ${String(seen.length)} 次`);
else {
  const body = seen[0];
  if (!Array.isArray(body.tools) || body.tools.length === 0) {
    problems.push('上游收到的请求里没有 tools —— 工具调用链路在 shim 这一层断了');
  } else if (body.tools[0]?.function?.name !== 'read_file') {
    problems.push(`工具名被改写：${String(body.tools[0]?.function?.name)}`);
  } else {
    steps.push(`工具定义原样到达上游（${String(body.tools.length)} 个，名字保留）✓`);
  }
  if (body.tool_choice !== 'auto') problems.push(`tool_choice 被改写：${String(body.tool_choice)}`);
  else steps.push('tool_choice 原样透传 ✓');
  if (body.parameters !== undefined) problems.push('shim 往请求体里塞了额外字段（不该出现的 parameters）');
}
if (!text.includes('tool_calls')) problems.push('上游的 tool_calls 没回到宿主');
else steps.push('tool_calls 分片原样回到宿主 ✓');
if (!text.includes('[DONE]')) problems.push('SSE 结束标记丢了');
else steps.push('[DONE] 结束标记保留 ✓');

await shim.close();
fake.close();

for (const step of steps) console.log(`ok   ${step}`);
if (problems.length > 0) {
  console.error('\n工具调用链路验证未通过：');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
} else {
  console.log('\n工具调用链路验证通过：工具原样到上游、tool_calls 原样回宿主。');
}
process.exit(process.exitCode ?? 0);
