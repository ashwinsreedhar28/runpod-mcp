import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToolContext } from '../src/specgen/context.js';

test('published SDK keeps API keys isolated across tool contexts', async (t) => {
  const keys: string[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      keys.push(request.headers.get('Authorization')!);
      assert.ok(request.headers.get('X-Runpod-Session-Id'));
      return Response.json({ gpus: [] });
    }
  );
  const tracking = { transport: 'http' as const, serverVersion: 'test' };
  const first = createToolContext({
    apiKey: 'first-key',
    sdkRetry: false,
    tracking,
  });
  const second = createToolContext({
    apiKey: 'second-key',
    sdkRetry: false,
    tracking,
  });
  assert.notEqual(first.sdk, second.sdk);
  await first.sdk.GET('/v2/catalog/gpus');
  await second.sdk.GET('/v2/catalog/gpus');
  await first.sdk.GET('/v2/catalog/gpus');
  assert.deepEqual(keys, [
    'Bearer first-key',
    'Bearer second-key',
    'Bearer first-key',
  ]);
});
