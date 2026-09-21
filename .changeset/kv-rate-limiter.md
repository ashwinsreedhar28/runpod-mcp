---
'@runpod/mcp-server': minor
---

Enforce a per-caller rate limit on the hosted server when an Upstash Redis store is configured (`UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`; `RATE_LIMIT_PER_MIN` sets the fixed-window limit, default 120). On multi-instance deployments also set `MCP_CALLER_SALT` so caller ids stay stable across Upstash token rotation. A denied call returns the existing retryable tool error with a wait hint. Unset, the limiter stays the always-admit no-op, so existing deployments and local stdio are unchanged. A store outage admits the call rather than failing it.
