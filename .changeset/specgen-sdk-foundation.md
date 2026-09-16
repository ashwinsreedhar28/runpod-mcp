---
"@runpod/mcp-server": major
---

Require Node.js 20 or newer and add the published Runpod TypeScript API SDK as the REST client foundation. Share deadline enforcement across REST, runtime, GraphQL, and log readers; preserve per-caller credentials and bounded polling. Update GPU selection with a sparse REST PATCH and isolate queued-job diagnostics by caller.

Pin the bundled TypeScript API SDK to 0.1.1. Reject null required arguments and invalid endpoint IDs before issuing requests.
