// Read-only review checks. RUNPOD_API_KEY is required; output contains only
// operation names, status codes and counts, never response bodies or keys.
import assert from 'node:assert/strict';
import { createRunpodClient } from '@runpod/typescript-api-sdk';
import { boundedFetch } from '../src/specgen/clients/bounded-fetch.js';
import { createToolContext } from '../src/specgen/context.js';
import { dispatchGeneratedTool } from '../src/specgen/dispatch.js';
import { generatedTools } from '../src/specgen/generated/tools.gen.js';
import { listEndpoints } from '../src/specgen/tools/list-endpoints.js';
import { listTemplates } from '../src/specgen/tools/list-templates.js';
import {
  createSseReader,
  collectLogSnapshot,
} from '../src/specgen/clients/sse.js';

const apiKey = process.env.RUNPOD_API_KEY;
assert.ok(apiKey, 'Set RUNPOD_API_KEY before running live review checks');
const ctx = createToolContext({ apiKey, sdkRetry: false });
for (const name of [
  'list-pods',
  'list-gpu-types',
  'list-cpu-types',
  'list-data-centers',
]) {
  const tool = generatedTools.find((tool) => tool.name === name);
  assert.ok(tool, `Missing generated tool ${name}`);
  const result = await dispatchGeneratedTool(ctx.sdk, tool, {});
  assert.equal(result.ok, true, `${name}: HTTP ${result.status}`);
  console.log(JSON.stringify({ operation: name, status: result.status }));
}
for (const tool of [listEndpoints, listTemplates]) {
  const result = await tool.handler(ctx, {});
  assert.equal(result.ok, true, `${tool.name}: HTTP ${result.status}`);
  console.log(JSON.stringify({ operation: tool.name, status: result.status }));
}

// Fetch live REST data first, then inject stalled transport behavior locally.
// This verifies the client deadline without requiring an actual Runpod outage.
const client = createRunpodClient({ apiKey, retry: false });
const { data, response } = await client.GET('/v2/catalog/gpus');
assert.equal(response.status, 200);
const body = new TextEncoder().encode(JSON.stringify(data));
const url = 'https://api.runpod.io/v2/catalog/gpus';
await assert.rejects(
  boundedFetch(() => new Promise<Response>(() => {}), 30)(url),
  { name: 'TimeoutError' }
);
const stalledBody = new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(body.subarray(0, 20));
  },
});
const stalledResponse = await boundedFetch(
  async () => new Response(stalledBody),
  30
)(url);
await assert.rejects(stalledResponse.json(), { name: 'TimeoutError' });
assert.equal(stalledBody.locked, false);
console.log(
  JSON.stringify({
    operation: 'local transport stalls with live REST payload',
    result: 'deadline enforced; reader released',
  })
);

const sseBody = new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(
      new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`)
    );
  },
});
const reader = createSseReader({
  apiKey,
  fetchImpl: async () => new Response(sseBody),
});
const snapshot = await collectLogSnapshot(reader, url, { maxWaitMs: 30 });
assert.equal(snapshot.count, 1);
assert.equal(sseBody.locked, false);
console.log(
  JSON.stringify({
    operation: 'local SSE framing of live REST payload',
    result: 'snapshot returned at deadline; reader released',
  })
);
