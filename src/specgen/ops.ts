// Operational seam for the hosted path: per-tool-call structured logging and
// the rate-limit gate. The gate defines a seat in the request path (keyed on
// a caller identity, consulted before any tool work) and, when a counter
// store is configured, enforces a fixed-window limit through it. With no
// store configured it stays the always-admit no-op, so a deployment opts in
// by setting environment variables (rateLimiterFromEnv) — the dispatch
// pipeline is untouched either way.
//
// SECURITY: nothing in this file may log the API key, the Authorization
// header, or tool arguments (which can carry payload secrets). Callers are
// identified by a short salted hash of the token — stable within one warm
// instance for correlation, useless for recovering the credential.

import { createHash, randomBytes } from 'node:crypto';
import type { Env } from '../_shared/hosts.js';

// Caller-id salt. Per process by default: ids correlate within an instance's
// log window but cannot be joined across instances or replayed offline
// against a key list. A shared rate-limit store needs the opposite — every
// instance must hash the same token to the same id, or each instance counts
// the caller under its own key and the limit silently becomes per-instance.
// The store's token is a deployment-wide secret present exactly when the
// store is, so it doubles as the salt (analytics.ts makes the same fallback
// to the PostHog key). Rotating that token then changes every caller id at
// once: in-flight counters restart and log lines cannot be correlated across
// the rotation. Production should set MCP_CALLER_SALT explicitly so the salt
// and the store credential rotate independently.
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

// The one operation a counter backend must provide. `incr` bumps the count
// under `key`, sets the key to expire `windowS` seconds after its FIRST
// increment, and returns the new count. Keys already name their window (see
// createRateLimiter), so expiry is garbage collection, not the window edge.
export interface RateLimitStore {
  incr(key: string, windowS: number): Promise<number>;
}

// In-process store for tests and local development only. It is per process,
// so on a multi-instance deployment every instance would keep its own
// counter — the hosted path never selects it (see rateLimiterFromEnv).
// Expired entries are pruned on each access, so the map stays bounded by the
// callers seen within one window.
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
// is added. One pipeline round trip per call: INCR, then EXPIRE with NX so
// only the first increment sets the TTL (Redis >= 7.0 syntax; Upstash tracks
// 8.x). The pipeline is not atomic, and a per-command EXPIRE error is not
// surfaced: a key whose EXPIRE fails has no TTL and lives forever. Every
// later call in the same window retries EXPIRE NX, so a key is orphaned only
// if EVERY call's EXPIRE fails — unlikely, and the cost is one stale key per
// caller-window, never a wrong verdict.
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

// Fixed-window counter. The key names the caller and the window it falls in,
// so a new window starts from zero with no reset step, and a denied caller is
// told how much of the window is left. Wall-clock time on purpose (unlike
// the monotonic clock in credential-check.ts): every instance sharing the
// store must agree on where a window starts.
//
// Fails OPEN: if the store throws, the call is admitted and one line is
// logged. A limiter outage must not become a tool outage — the WAF still
// bounds unauthenticated traffic and the upstream API keeps its own quotas.
// The line carries the caller hash and tool, never the store key or the
// error text (a fetch failure message can name the store host).
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
