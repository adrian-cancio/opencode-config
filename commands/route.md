---
description: Show recent OmniRoute routing decisions (model, provider, latency, cost)
agent: build
---

Read the last 20 lines of `~/.config/opencode/logs/route.jsonl` and present them as a compact table with columns: time (HH:mm:ss), model, provider, latency, cost, tokens in/out.

If the file does not exist, say the route monitor has not logged anything yet.

Highlight any point where the model changed between consecutive entries.

$ARGUMENTS
