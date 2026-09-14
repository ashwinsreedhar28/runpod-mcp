---
"@runpod/mcp-server": major
---

Serve the same REST v2 generated tools and skill resources over HTTP and stdio. Remove the legacy v1 fallback, hand-written tool surface, and package tools export. See specgen/old-mcp-tools.yaml for renamed tools and pod-action replacements. Include argument checks, compact lists, bounded log snapshots, upstream retry guidance, caller tracking, and opt-in hosted analytics. The REST SDK is bundled into both entrypoints.
