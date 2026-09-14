---
'@runpod/mcp-server': patch
---

Use the SDK deadline implementation for GraphQL, Serverless runtime, and bounded log reads so a non-cooperative fetch or body cannot hang a tool call. Keep polling intervals and per-request timeouts inside the remaining job-wait budget. Normalize configured API host whitespace and trailing slashes consistently across clients, and correct the REST v2 configuration examples.

Scope queued-job worker diagnostics to each caller context instead of sharing private worker state through an endpoint-only global cache.
