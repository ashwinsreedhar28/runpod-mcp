---
"@runpod/mcp-server": major
---

Require Node.js 20 or newer and replace the vendored REST client with the published @runpod/typescript-api-sdk package. Bundle the SDK in both MCP entrypoints and use its request deadlines, retries, and SSE parsing while retaining per-caller API keys, tracking headers, and bounded log snapshots.
