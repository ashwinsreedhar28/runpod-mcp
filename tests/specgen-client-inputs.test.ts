import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRunpodClient } from '@runpod/typescript-api-sdk';
import { dispatchGeneratedTool } from '../src/specgen/dispatch.js';
import { generatedTools } from '../src/specgen/generated/tools.gen.js';
import { createRuntimeClient } from '../src/specgen/clients/runtime.js';
import { HttpError } from '../src/specgen/clients/http-error.js';

test('a null required path argument fails before any REST request', async () => {
  let requests = 0;
  const sdk = createRunpodClient({
    apiKey: 'test',
    fetch: async () => {
      requests++;
      return new Response('{}');
    },
  });
  const tool = generatedTools.find((tool) => tool.name === 'get-pod')!;
  const result = await dispatchGeneratedTool(sdk, tool, { id: null });
  assert.equal(result.status, 400);
  assert.match(JSON.stringify(result.payload), /Missing required argument: id/);
  assert.equal(requests, 0);
});

test('runtime client rejects endpoint path injection before sending a key', async () => {
  let requests = 0;
  const runtime = createRuntimeClient({
    apiKey: 'test',
    fetchImpl: async () => {
      requests++;
      return new Response('{}');
    },
  });
  for (const id of [
    'abc/../x',
    '..',
    '%2e%2e',
    'abc?other=x',
    'abc#x',
    'abc\\x',
    ' abc',
    '',
  ]) {
    await assert.rejects(
      runtime(id, '/health'),
      (error) => error instanceof HttpError && error.status === 400
    );
  }
  assert.equal(requests, 0);
  await runtime('endpoint_123-ab', '/health');
  assert.equal(requests, 1);
});
