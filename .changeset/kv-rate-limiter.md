---
'@runpod/mcp-server': minor
---

Add opt-in per-caller rate limiting on the hosted server: set `MCP_RATE_LIMIT_PER_MIN` (calls per credential per minute; a value that is not a positive integer keeps 120) together with `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`, and calls are counted in Upstash Redis over its REST API in a fixed 60 s window. On multi-instance deployments also set `MCP_CALLER_SALT` so caller ids stay stable across Upstash token rotation. A denied call returns the existing retryable tool error with a wait hint. Unset, the limiter stays the always-admit no-op, so existing deployments and local stdio are unchanged; the Upstash variables alone never switch it on. Embedders of `handleMcpRequest` can pass a `rateLimiter` option to inject or disable it. A store outage admits the call rather than failing it.
