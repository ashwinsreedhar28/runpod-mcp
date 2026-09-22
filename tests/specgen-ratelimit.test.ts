// The KV-backed rate limiter: fixed-window verdicts against the memory store
// with an injected clock, the Upstash store's wire shape against a fake
// fetch, and the env-driven selection. No network, no credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  callerId,
  createMemoryStore,
  createRateLimiter,
  createUpstashStore,
  noopRateLimiter,
  rateLimiterFromEnv,
  type RateLimiter,
} from '../src/specgen/ops.js';
import { createSpecgenServer } from '../src/specgen/server.js';
import { createToolContext } from '../src/specgen/context.js';

// A multiple of 60s, so a window starts here and retryAfterS is exact.
const WINDOW_START_MS = 1_700_000_040_000;

function memoryLimiter(limit: number) {
  let t = WINDOW_START_MS;
  const now = () => t;
  const limiter = createRateLimiter(createMemoryStore(now), {
    limit,
    windowS: 60,
    now,
  });
  return { limiter, advance: (ms: number) => void (t += ms) };
}

test('admits every call under the limit', async () => {
  const { limiter } = memoryLimiter(3);
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(await limiter('a', 'list-pods'), { allowed: true });
  }
});

test('denies at the limit with the seconds left in the window', async () => {
  const { limiter, advance } = memoryLimiter(3);
  advance(10_000);
  for (let i = 0; i < 3; i++) await limiter('a', 'list-pods');
  assert.deepEqual(await limiter('a', 'list-pods'), {
    allowed: false,
    retryAfterS: 50,
  });
  // The limit is per caller, not per tool.
  advance(45_000);
  assert.deepEqual(await limiter('a', 'get-pod'), {
    allowed: false,
    retryAfterS: 5,
  });
  // The last second of the window still says 1, never 0.
  advance(4_000);
  assert.equal((await limiter('a', 'list-pods')).retryAfterS, 1);
  advance(900);
  assert.equal((await limiter('a', 'list-pods')).retryAfterS, 1);
});

test('resets when the window rolls over', async () => {
  const { limiter, advance } = memoryLimiter(1);
  await limiter('a', 'list-pods');
  assert.equal((await limiter('a', 'list-pods')).allowed, false);
  advance(60_000);
  assert.deepEqual(await limiter('a', 'list-pods'), { allowed: true });
});

test('two callers do not share a counter', async () => {
  const { limiter } = memoryLimiter(1);
  await limiter('a', 'list-pods');
  assert.equal((await limiter('a', 'list-pods')).allowed, false);
  assert.deepEqual(await limiter('b', 'list-pods'), { allowed: true });
});

test('the store key is namespaced by caller and window start', async () => {
  const keys: string[] = [];
  const limiter = createRateLimiter(
    {
      incr: async (key) => {
        keys.push(key);
        return 1;
      },
    },
    { limit: 1, windowS: 60, now: () => WINDOW_START_MS + 10_000 }
  );
  await limiter('a', 'list-pods');
  assert.deepEqual(keys, [`runpod-mcp:rl:a:${WINDOW_START_MS / 1000}`]);
});

test('memory store expires a key after its window', async () => {
  let t = WINDOW_START_MS;
  const store = createMemoryStore(() => t);
  assert.equal(await store.incr('k', 60), 1);
  assert.equal(await store.incr('k', 60), 2);
  t += 60_000;
  assert.equal(await store.incr('k', 60), 1);
});

test('a throwing store fails open and logs one line without the error text', async () => {
  const limiter = createRateLimiter(
    {
      incr: async () => {
        throw new Error('connect ECONNREFUSED kv.example.invalid');
      },
    },
    { limit: 1, windowS: 60 }
  );
  const lines: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => void lines.push(args.join(' '));
  try {
    assert.deepEqual(await limiter('a', 'list-pods'), { allowed: true });
  } finally {
    console.error = realError;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^rate_limit_fail_open .*"tool":"list-pods"/);
  assert.doesNotMatch(
    lines[0],
    /ECONNREFUSED|kv\.example\.invalid/,
    'the error text can name the store host'
  );
  assert.doesNotMatch(lines[0], /rl:/, 'the store key names the window');
});

test('upstash store pipelines INCR + EXPIRE NX and returns the count', async () => {
  const seen: Array<{ url: string; auth: string | null; body: unknown }> = [];
  const store = createUpstashStore({
    url: 'https://kv.example.invalid/',
    token: 'test-token',
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        url: String(input),
        auth: new Headers(init?.headers).get('authorization'),
        body: JSON.parse(String(init?.body)),
      });
      return Response.json([{ result: 7 }, { result: 1 }]);
    }) as typeof fetch,
  });
  assert.equal(await store.incr('runpod-mcp:rl:a:100', 60), 7);
  assert.deepEqual(seen, [
    {
      url: 'https://kv.example.invalid/pipeline',
      auth: 'Bearer test-token',
      body: [
        ['INCR', 'runpod-mcp:rl:a:100'],
        ['EXPIRE', 'runpod-mcp:rl:a:100', 60, 'NX'],
      ],
    },
  ]);
});

test('upstash store rejects on an HTTP error or a failed INCR', async () => {
  const answering = (res: Response) =>
    createUpstashStore({
      url: 'https://kv.example.invalid',
      token: 't',
      fetch: (async () => res) as typeof fetch,
    });
  await assert.rejects(
    answering(new Response(null, { status: 500 })).incr('k', 60),
    /HTTP 500/
  );
  await assert.rejects(
    answering(
      Response.json([{ error: 'ERR value is not an int' }, { result: 0 }])
    ).incr('k', 60),
    /not an int/
  );
});

const UPSTASH = {
  UPSTASH_REDIS_REST_URL: 'https://kv.example.invalid',
  UPSTASH_REDIS_REST_TOKEN: 'test-token',
};

test('rateLimiterFromEnv is the no-op unless MCP_RATE_LIMIT_PER_MIN opts in with both Upstash vars', () => {
  const on = { MCP_RATE_LIMIT_PER_MIN: '120' };
  assert.equal(rateLimiterFromEnv({}), noopRateLimiter);
  // The Upstash names are what its Vercel integration injects: their
  // presence alone must not switch limiting on.
  assert.equal(rateLimiterFromEnv(UPSTASH), noopRateLimiter);
  assert.equal(
    rateLimiterFromEnv({ ...UPSTASH, MCP_RATE_LIMIT_PER_MIN: '' }),
    noopRateLimiter,
    'empty reads as unset'
  );
  assert.equal(
    rateLimiterFromEnv({
      ...on,
      UPSTASH_REDIS_REST_URL: UPSTASH.UPSTASH_REDIS_REST_URL,
    }),
    noopRateLimiter
  );
  assert.equal(
    rateLimiterFromEnv({
      ...on,
      UPSTASH_REDIS_REST_TOKEN: UPSTASH.UPSTASH_REDIS_REST_TOKEN,
    }),
    noopRateLimiter
  );
  assert.notEqual(rateLimiterFromEnv({ ...UPSTASH, ...on }), noopRateLimiter);
});

// What any instance computes for a token under a given salt — the value a
// shared counter needs every instance to agree on.
const idUnder = (salt: string, token: string) =>
  createHash('sha256').update(salt).update(token).digest('hex').slice(0, 12);

test('callerId resolves its salt per call: cross-instance stable only while limiting is on', () => {
  const on = { ...UPSTASH, MCP_RATE_LIMIT_PER_MIN: '120' };
  assert.equal(
    callerId('rpa_x', on),
    idUnder(UPSTASH.UPSTASH_REDIS_REST_TOKEN, 'rpa_x'),
    'limiting on: the Upstash token is the salt, reproducible anywhere'
  );
  assert.equal(
    callerId('rpa_x', { ...on, MCP_CALLER_SALT: 's1' }),
    idUnder('s1', 'rpa_x'),
    'an explicit salt wins over the token'
  );
  // Upstash vars alone change nothing: the per-process salt stays in force.
  assert.equal(callerId('rpa_x', UPSTASH), callerId('rpa_x', {}));
  assert.notEqual(
    callerId('rpa_x', UPSTASH),
    idUnder(UPSTASH.UPSTASH_REDIS_REST_TOKEN, 'rpa_x')
  );
  assert.equal(callerId(undefined, on), 'anonymous');
});

test('callerId sees env set after import', () => {
  const before = callerId('rpa_x');
  process.env.MCP_CALLER_SALT = 'late';
  try {
    assert.equal(callerId('rpa_x'), idUnder('late', 'rpa_x'));
  } finally {
    delete process.env.MCP_CALLER_SALT;
  }
  assert.equal(callerId('rpa_x'), before);
});

// Runs an env-selected limiter against a store answering with a fixed count,
// so a test can probe the configured limit without making that many calls.
async function admitsAt(limiter: RateLimiter, count: number): Promise<boolean> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json([{ result: count }, { result: 1 }])) as typeof fetch;
  try {
    return (await limiter('a', 'list-pods')).allowed;
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('MCP_RATE_LIMIT_PER_MIN sets the limit; a set value that is not a positive integer keeps 120', async () => {
  const cases: Array<[string, number]> = [
    ['abc', 120],
    ['0', 120],
    ['-5', 120],
    ['2.5', 120],
    ['7', 7],
  ];
  for (const [value, limit] of cases) {
    const limiter = rateLimiterFromEnv({
      ...UPSTASH,
      MCP_RATE_LIMIT_PER_MIN: value,
    });
    assert.equal(
      await admitsAt(limiter, limit),
      true,
      `${value}: call ${limit}`
    );
    assert.equal(
      await admitsAt(limiter, limit + 1),
      false,
      `${value}: call ${limit + 1}`
    );
  }
});

test('an enforcing limiter denies through a real MCP round trip', async () => {
  const now = () => WINDOW_START_MS;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({})) as typeof fetch;
  try {
    const server = createSpecgenServer(
      createToolContext({ apiKey: 'rpa_test', sdkRetry: false }),
      'test',
      {
        rateLimiter: createRateLimiter(createMemoryStore(now), {
          limit: 1,
          windowS: 60,
          now,
        }),
      }
    );
    const client = new Client({ name: 'test', version: '1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    const call = () =>
      client.callTool({ name: 'list-pods', arguments: {} }) as Promise<{
        isError?: boolean;
        content: Array<{ text: string }>;
      }>;
    assert.doesNotMatch((await call()).content[0].text, /Rate limited/);
    const denied = await call();
    assert.equal(denied.isError, true);
    assert.match(JSON.parse(denied.content[0].text).hint, /~60s/);
    await client.close();
  } finally {
    globalThis.fetch = realFetch;
  }
});
