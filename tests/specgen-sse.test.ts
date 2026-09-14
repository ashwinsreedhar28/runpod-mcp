// Bounded SSE snapshot: the last event is kept or dropped on whether it is
// WHOLE (ends with a blank line), never on the truncated flag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectLogSnapshot,
  createSseReader,
  type SseReader,
} from '../src/specgen/clients/sse.js';

const frame = (line: string) =>
  `id: 1\ndata: ${JSON.stringify({ source: 'container', line, ts: 't' })}\n\n`;
const readerOf =
  (raw: string, truncated: boolean): SseReader =>
  async () => ({ raw, truncated });

test('a complete final event survives the byte cap', async () => {
  // The cap landed exactly on an event boundary. The old code popped on
  // `truncated` alone and turned a complete crash line into an empty result.
  const r = await collectLogSnapshot(
    readerOf(frame('FATAL: out of memory'), true),
    'https://x/logs',
    {}
  );
  assert.equal(r.truncated, true);
  assert.equal(r.count, 1);
  assert.equal(r.items[0]?.line, 'FATAL: out of memory');
});

test('a genuinely partial final event is dropped, whatever ended the read', async () => {
  const partial = frame('ok') + 'id: 2\ndata: {"line":"parti';
  for (const truncated of [true, false]) {
    const r = await collectLogSnapshot(
      readerOf(partial, truncated),
      'https://x/logs',
      {}
    );
    assert.equal(r.count, 1, `truncated=${truncated}`);
    assert.equal(r.items[0]?.line, 'ok');
  }
});

test('a trailing newline mid-event is still a partial', async () => {
  // Ends with "\n" but not a blank line: the JSON is cut, parses as { raw },
  // and the old endsWith('\n') check let it through as a real entry.
  const r = await collectLogSnapshot(
    readerOf(frame('ok') + 'data: {"line":"parti\n', false),
    'https://x/logs',
    {}
  );
  assert.equal(r.count, 1);
  assert.equal(r.items[0]?.line, 'ok');
});

test('CRLF event boundaries count as complete', async () => {
  const crlf = 'id: 1\r\ndata: {"line":"done"}\r\n\r\n';
  const r = await collectLogSnapshot(
    readerOf(crlf, true),
    'https://x/logs',
    {}
  );
  assert.equal(r.count, 1);
});

test('partial heartbeat or metadata does not discard a preceding complete log', async () => {
  for (const newline of ['\n', '\r\n']) {
    for (const tail of [
      ': heartbeat',
      'event: log',
      'id: 123',
      'retry: 1000',
      'data: {"line":"partial',
    ]) {
      for (const truncated of [false, true]) {
        const raw = `data: {"line":"container crashed"}${newline}${newline}${tail}${newline}`;
        const result = await collectLogSnapshot(
          async () => ({ raw, truncated }),
          'https://example.invalid',
          {}
        );
        assert.deepEqual(result.items, [{ line: 'container crashed' }]);
        assert.equal(result.truncated, truncated);
      }
    }
  }
});

test('SDK parser handles CR-only frames and preserves invalid log data as raw', async () => {
  const result = await collectLogSnapshot(
    readerOf('data: {"line":"hé😀"}\r\rdata: {"line":42}\r\r', false),
    'https://example.invalid/logs',
    {}
  );
  assert.deepEqual(result.items, [{ line: 'hé😀' }, { raw: '{"line":42}' }]);
});

test('snapshot byte cap bounds a single oversized network chunk', async () => {
  let cancelled = false;
  const reader = createSseReader({
    apiKey: 'test-key',
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(frame('ok') + 'x'.repeat(2_000_000))
            );
          },
          cancel() {
            cancelled = true;
          },
        })
      ),
  });
  const result = await reader('https://example.invalid/logs', {
    maxWaitMs: 1000,
    maxBytes: 100,
  });
  assert.equal(Buffer.byteLength(result.raw), 100);
  assert.equal(result.truncated, true);
  assert.equal(cancelled, true);
});

test('SSE deadline returns collected frames even when the source ignores abort', async () => {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frame('ready')));
    },
  });
  const reader = createSseReader({
    apiKey: 'test-key',
    fetchImpl: async () => new Response(source),
  });
  const result = await collectLogSnapshot(
    reader,
    'https://example.invalid/logs',
    { maxWaitMs: 20 }
  );
  assert.equal(result.items[0]?.line, 'ready');
  assert.equal(source.locked, false);
});
