import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setEndpointGpus } from '../src/specgen/tools/endpoint-gpus.js';
import { createToolContext } from '../src/specgen/context.js';

test('GPU selection sends a sparse REST update and preserves unrelated endpoint settings', async (t) => {
  const calls: Request[] = [];
  const endpoint = {
    id: 'ep',
    name: 'keep-name',
    gpu: { pools: ['ADA_24'], count: 1 },
    workers: { min: 0, max: 0 },
    scaling: { type: 'QUEUE_DELAY', queueDelay: 7 },
  };
  t.mock.method(
    globalThis,
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      calls.push(request);
      if (request.method === 'GET') return Response.json(endpoint);
      assert.equal(request.method, 'PATCH');
      const body = await request.json();
      assert.deepEqual(body, {
        gpu: { pools: ['ADA_24'], excludedTypes: ['NVIDIA L4'], count: 2 },
      });
      return Response.json({ ...endpoint, gpu: body.gpu });
    }
  );
  const result = await setEndpointGpus.handler(
    createToolContext({ apiKey: 'test-key', sdkRetry: false }),
    { endpointId: 'ep', gpuIds: 'ADA_24,-NVIDIA L4', gpuCount: 2 }
  );
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.deepEqual((result.payload as { endpoint: unknown }).endpoint, {
    id: 'ep',
    name: 'keep-name',
    gpuIds: 'ADA_24,-NVIDIA L4',
    gpuCount: 2,
    workersMin: 0,
    workersMax: 0,
  });
});

test('invalid GPU selections fail before reaching any API', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    assert.fail('invalid input reached the API');
  });
  const ctx = createToolContext({ apiKey: 'test-key', sdkRetry: false });
  for (const args of [
    { pools: 'ADA_24' },
    { gpuIds: 'ADA_24,', gpuCount: 1 },
    { pools: ['ADA_24'], gpuCount: 1.5 },
    { pools: ['ADA_24'], excludeGpuTypeIds: 'NVIDIA L4' },
    { pools: ['ADA_24'], allowedCudaVersions: 'not-a-version' },
    { pools: ['ADA_24'], allowedCudaVersions: '12.8', minCudaVersion: '12.4' },
  ]) {
    const result = await setEndpointGpus.handler(ctx, {
      endpointId: 'ep',
      ...args,
    });
    assert.equal(result.status, 400);
  }
});
