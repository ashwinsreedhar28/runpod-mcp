---
'@runpod/mcp-server': patch
---

Fix two secret-redaction leaks in ALP submission scrubbing, and replace the config-assignment regex with an explicit scan.

`password: p&ss#word123` and `password=abc&def` were truncated at the `&` and everything after it was stored in plaintext. A sensitive assignment nested inside a non-sensitive value was skipped entirely, so `https://host/?password=secret` passed through untouched. Values now keep `&` and `#` unless the key sits in a URL query string, where those characters really do bound the value, and the scan resumes inside a non-sensitive value instead of past it. Unbalanced and unterminated quotes no longer disable redaction. Scrub version is now 5.
