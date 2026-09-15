---
"@runpod/mcp-server": minor
---

Add hosted-only feedback, question, and private journal tools when a storage sink is configured. Contributions are optional and scrubbed for secrets. Scope journal reads to the authenticated account, bound reads, verify storage confirmation, and reject malformed storage requests. Local stdio does not advertise these tools.

Redact nested YAML/Compose secrets, Hugging Face tokens, and URL query credentials. Clarify that journals are not published to other accounts and Runpod stores submissions for review.
