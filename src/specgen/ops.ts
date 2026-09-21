// Operational seam for the hosted path: per-tool-call structured logging and
// the rate-limit gate. The gate is a seat in the request path (keyed on a
// caller identity, consulted before any tool work): it enforces a fixed
// window through a counter store when one is configured and admits
// everything otherwise, so a deployment opts in by environment variable.
//
// SECURITY: nothing in this file may log the API key, the Authorization
// header, or tool arguments (which can carry payload secrets). Callers are
// identified by a short salted hash of the token — stable within one warm
// instance for correlation, useless for recovering the credential.

import { createHash, randomBytes } from 'node:crypto';
import type { Env } from '../_shared/hosts.js';

// Caller-id salt. Per process by default, so ids correlate within one
// instance's logs but cannot be joined across instances or replayed against
// a key list. A shared rate-limit store needs the opposite — every instance
// must hash a token to the same id — so the store's token doubles as the
// salt when set (analytics.ts makes the same fallback to the PostHog key).
// Rotating it then changes every caller id at once; production should set
// MCP_CALLER_SALT so the salt and the credential rotate independently.
const SALT =
  process.env.MCP_CALLER_SALT ||
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  randomBytes(16).toString('hex');

export function callerId(token: string | undefined): string {
  if (!token) return 'anonymous';
  return createHash('sha256')
    .update(SALT)
    .update(token)
    .digest('hex')
    .slice(0, 12);
}

// ---- rate limiting ----

export interface RateLimitVerdict {
  allowed: boolean;
  /** Seconds the caller should wait; only set when denied. */
  retryAfterS?: number;
}

export type RateLimiter = (
  caller: string,
  toolName: string
) => Promise<RateLimitVerdict>;

// Always admits: the default whenever no counter store is configured, so an
// existing deployment is unchanged until it opts in.
export const noopRateLimiter: RateLimiter = async () => ({ allowed: true });

// The one operation a counter backend must provide: bump `key`, set it to
// expire `windowS` seconds after its FIRST increment, return the new count.
// Keys already name their window, so expiry is garbage collection only.
export interface RateLimitStore {
  incr(key: string, windowS: number): Promise<number>;
}

// For tests and local development only: per process, so on a multi-instance
// deployment each instance would count alone. The hosted path never selects
// it. Expired entries are pruned on each access, which bounds the map.
export function createMemoryStore(
  now: () => number = Date.now
): RateLimitStore {
  const entries = new Map<string, { count: number; expiresAt: number }>();
  return {
    async incr(key, windowS) {
      const t = now();
      for (const [k, entry] of entries) {
        if (entry.expiresAt <= t) entries.delete(k);
      }
      const entry = entries.get(key);
      if (entry) {
        entry.count += 1;
        return entry.count;
      }
      entries.set(key, { count: 1, expiresAt: t + windowS * 1000 });
      return 1;
    },
  };
}

// A counter check must never hold a tool call open for long: past this the
// store counts as failed and the limiter fails open.
const UPSTASH_TIMEOUT_MS = 2_000;

// Upstash Redis over its REST API, through the global fetch so no dependency
// is added. One pipeline per call: INCR, then EXPIRE NX so only the first
// increment sets the TTL. The pipeline is not atomic and an EXPIRE error is
// not surfaced, so a key whose EXPIRE fails keeps no TTL; every later call in
// the window retries it, so a key is orphaned only if every attempt fails —
// one stale key, never a wrong verdict.
// https://upstash.com/docs/redis/features/restapi
export function createUpstashStore(opts: {
  url: string;
  token: string;
  fetch?: typeof fetch;
}): RateLimitStore {
  const endpoint = `${opts.url.replace(/\/+$/, '')}/pipeline`;
  return {
    async incr(key, windowS) {
      const res = await (opts.fetch ?? fetch)(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${opts.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify([
          ['INCR', key],
          ['EXPIRE', key, windowS, 'NX'],
        ]),
        signal: AbortSignal.timeout(UPSTASH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`upstash: HTTP ${res.status}`);
      const results = (await res.json()) as Array<{
        result?: unknown;
        error?: string;
      }>;
      const count = results[0]?.result;
      if (typeof count !== 'number') {
        throw new Error(results[0]?.error ?? 'upstash: no count in response');
      }
      return count;
    },
  };
}

export interface RateLimitOptions {
  /** Calls admitted per caller in one window. */
  limit: number;
  /** Window length in seconds. */
  windowS: number;
  /** Wall-clock milliseconds; tests inject a fake. */
  now?: () => number;
}

// Fixed-window counter. The key names the caller and the window, so a new
// window starts from zero with no reset step and a denied caller learns how
// much of the window is left. Wall-clock on purpose (credential-check.ts is
// monotonic): every instance sharing the store must agree where a window
// starts. Fails OPEN — a store error admits the call and logs one line with
// the caller hash and tool, never the key or the error text (which can name
// the store host). A limiter outage must not become a tool outage.
export function createRateLimiter(
  store: RateLimitStore,
  opts: RateLimitOptions
): RateLimiter {
  const now = opts.now ?? Date.now;
  return async (caller, toolName) => {
    const nowS = Math.floor(now() / 1000);
    const windowStart = nowS - (nowS % opts.windowS);
    let count: number;
    try {
      count = await store.incr(`rl:${caller}:${windowStart}`, opts.windowS);
    } catch (err) {
      console.error(
        'rate_limit_fail_open',
        JSON.stringify({
          tool: toolName,
          caller,
          error: err instanceof Error ? err.name : 'unknown',
        })
      );
      return { allowed: true };
    }
    if (count <= opts.limit) return { allowed: true };
    return { allowed: false, retryAfterS: windowStart + opts.windowS - nowS };
  };
}

export const DEFAULT_RATE_LIMIT_PER_MIN = 120;

// Hosted-path selection. Both Upstash variables set → an Upstash-backed
// limiter at RATE_LIMIT_PER_MIN calls per caller per minute (default 120; a
// value that is not a positive integer is ignored, so a typo can neither
// zero nor disable the limit). Anything less → the no-op, exactly as before.
export function rateLimiterFromEnv(env: Env = process.env): RateLimiter {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return noopRateLimiter;
  const perMin = Number(env.RATE_LIMIT_PER_MIN);
  const limit =
    Number.isInteger(perMin) && perMin > 0
      ? perMin
      : DEFAULT_RATE_LIMIT_PER_MIN;
  return createRateLimiter(createUpstashStore({ url, token }), {
    limit,
    windowS: 60,
  });
}

// ---- structured tool-call logging ----

export interface ToolCallLog {
  tool: string;
  caller: string;
  ok: boolean;
  status: number;
  durationMs: number;
}

// One line per tool call, visible in Vercel's logs and on local stderr.
// stdout belongs exclusively to the MCP JSON-RPC transport on stdio.
export function logToolCall(entry: ToolCallLog): void {
  console.error('tool_call', JSON.stringify(entry));
}
