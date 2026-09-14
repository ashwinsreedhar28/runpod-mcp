// Explicitly opt in: this creates a zero-worker endpoint, tests GPU selection,
// then deletes only that endpoint. No jobs are submitted or GPUs provisioned.
import assert from 'node:assert/strict';
import { createToolContext } from '../src/specgen/context.js';
import { setEndpointGpus } from '../src/specgen/tools/endpoint-gpus.js';

assert.ok(
  process.argv.includes('--allow-create'),
  'Pass --allow-create to test with a disposable zero-worker endpoint'
);
assert.ok(process.env.RUNPOD_API_KEY, 'Set RUNPOD_API_KEY');
const ctx = createToolContext({ sdkRetry: false });
const catalog = await ctx.sdk.GET('/v2/catalog/gpus');
assert.equal(catalog.response.status, 200);
const candidates = catalog.data!.gpus.filter((gpu) => gpu.pool === 'AMPERE_80');
assert.ok(
  candidates.length > 1,
  'Need more than one GPU type in the test pool'
);
const created = await ctx.sdk.POST('/v2/serverless', {
  body: {
    name: `mcp-sdk-review-${Date.now()}`,
    image: 'runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404',
    type: 'QUEUE',
    gpu: { pools: ['AMPERE_80'], count: 1 },
    scaling: { type: 'QUEUE_DELAY', queueDelay: 7 },
    workers: { min: 0, max: 0 },
  },
});
assert.ok(
  created.response.ok,
  `Create failed (${created.response.status}): ${JSON.stringify(created.error)}`
);
assert.ok(created.data?.id, 'Create returned no endpoint ID');
const params = { path: { id: created.data.id } };
try {
  const before = await ctx.sdk.GET('/v2/serverless/{id}', { params });
  assert.equal(before.response.status, 200);
  assert.equal(before.data!.workers?.min, 0);
  assert.equal(before.data!.workers?.max, 0);
  const result = await setEndpointGpus.handler(ctx, {
    endpointId: created.data.id,
    pools: ['AMPERE_80'],
    excludeGpuTypeIds: [candidates[0].id],
  });
  assert.equal(
    result.ok,
    true,
    `GPU update failed (${result.status}): ${JSON.stringify(result.payload)}`
  );
  const after = await ctx.sdk.GET('/v2/serverless/{id}', { params });
  assert.equal(after.response.status, 200);
  assert.deepEqual(after.data!.gpu?.excludedTypes, [candidates[0].id]);
  for (const field of [
    'name',
    'image',
    'workers',
    'scaling',
    'timeout',
    'env',
    'networkVolumes',
  ] as const) {
    assert.deepEqual(
      after.data![field],
      before.data![field],
      `${field} changed during a GPU-only update`
    );
  }
  console.log(
    'PASS: REST GPU exclusions updated; name, image, workers, scaling, timeouts, env and volumes preserved.'
  );
} finally {
  const deleted = await ctx.sdk.DELETE('/v2/serverless/{id}', { params });
  assert.ok(
    deleted.response.ok,
    `Cleanup failed (${deleted.response.status}); endpoint ${created.data.id} needs removal`
  );
  const gone = await ctx.sdk.GET('/v2/serverless/{id}', { params });
  assert.equal(
    gone.response.status,
    404,
    'Test endpoint is still present after deletion'
  );
  console.log(
    'PASS: disposable endpoint deleted and absence confirmed. No jobs submitted.'
  );
}
