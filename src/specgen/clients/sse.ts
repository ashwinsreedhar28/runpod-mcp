import { iterateLogEvents, type LogEntry } from '@runpod/typescript-api-sdk';
export type { LogEntry } from '@runpod/typescript-api-sdk';

// Bounded SSE reader for the v2 log endpoints (GET /v2/pods/{id}/logs and
// GET /v2/serverless/{id}/workers/{workerId}/logs). Both serve
// text/event-stream and hold the connection open to tail live output, so the
// generated JSON dispatch cannot consume them; the curated log tools read a
// time- and byte-bounded snapshot instead. Ported from the official MCP
// server's reader (Apache-2.0, runpod/runpod-mcp).

import { withRateLimitHint } from '../../_shared/rate-limit.js';
import { HttpError, missingKeyError } from './http-error.js';

export const LOG_STREAM_DEFAULT_WAIT_MS = 5_000;
export const LOG_STREAM_MAX_BYTES = 256 * 1024;

export type SseReader = (
  url: string,
  opts: { maxWaitMs: number; maxBytes: number }
) => Promise<{ raw: string; truncated: boolean }>;

// Time-bounded by maxWaitMs (the stream stays open to tail live output) and
// byte-bounded by maxBytes; whichever fires first aborts and returns what was
// collected. A deadline ends an established stream normally; a timeout before
// response headers arrive is a failed request. Bytes are concatenated and decoded
// once at the end so a UTF-8 char split across chunks is never corrupted.
export function createSseReader(
  options: { apiKey?: string; fetchImpl?: typeof fetch } = {}
): SseReader {
  const apiKey = options.apiKey ?? process.env.RUNPOD_API_KEY;
  const fetchImpl = options.fetchImpl ?? fetch;

  return async (url, opts) => {
    if (!apiKey) throw missingKeyError();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.maxWaitMs);
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let truncated = false;
    let streamEstablished = false;
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'text/event-stream',
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new HttpError(
          `Runpod API error (${response.status})`,
          response.status,
          response.status === 429
            ? withRateLimitHint({ error: body }, response.headers)
            : body
        );
      }
      streamEstablished = true;
      if (response.body) {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          const boundedChunk = chunk.subarray(0, opts.maxBytes - bytes);
          chunks.push(boundedChunk);
          bytes += boundedChunk.length;
          if (bytes >= opts.maxBytes) {
            truncated = true;
            controller.abort();
            break;
          }
        }
      }
    } catch (err) {
      // Only our own abort on an established stream ends a snapshot normally.
      // Before headers, there is no successful log read to return; runTool
      // maps the timeout to a retryable 504 instead of an empty success.
      if (
        !(
          streamEstablished &&
          controller.signal.aborted &&
          err instanceof Error &&
          (err.name === 'AbortError' || err.name === 'TimeoutError')
        )
      ) {
        throw err;
      }
    } finally {
      clearTimeout(timer);
    }
    return { raw: Buffer.concat(chunks).toString('utf8'), truncated };
  };
}

export interface LogSnapshotParams {
  source?: 'container' | 'system' | 'both';
  tail?: number;
  since?: string;
  maxWaitMs?: number;
}

// Read a bounded snapshot of a log endpoint and return the parsed frames.
// `source: 'both'` (or omitted) sends no source param — the endpoint returns
// both streams when it is absent (the wire enum is only container|system).
export async function collectLogSnapshot(
  reader: SseReader,
  logsUrl: string,
  params: LogSnapshotParams
): Promise<{ items: LogEntry[]; count: number; truncated: boolean }> {
  const qs = new URLSearchParams();
  if (params.source && params.source !== 'both')
    qs.append('source', params.source);
  if (params.tail !== undefined) qs.append('tail', String(params.tail));
  if (params.since) qs.append('since', params.since);
  const query = qs.toString() ? `?${qs}` : '';
  const { raw, truncated } = await reader(`${logsUrl}${query}`, {
    maxWaitMs: params.maxWaitMs ?? LOG_STREAM_DEFAULT_WAIT_MS,
    maxBytes: LOG_STREAM_MAX_BYTES,
  });
  // The SDK handles SSE framing and discards an incomplete final event.
  // MCP keeps ownership of its time and total-byte snapshot limits above.
  const items: LogEntry[] = [];
  for await (const event of iterateLogEvents(new Response(raw).body!)) {
    items.push(event.data);
  }
  return { items, count: items.length, truncated };
}
