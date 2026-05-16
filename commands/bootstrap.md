---
description: Bootstrap a new project or starter in the current directory
agent: build
---

Create the smallest viable project that satisfies this request:

$ARGUMENTS

Rules:
- Prefer official scaffolds or a minimal manual layout.
- Keep dependencies lean and avoid speculative infrastructure.
- Create basic project hygiene when appropriate: `README`, `.gitignore`, a test/lint/format entry point, and a local `AGENTS.md`.
- If the directory is not already a Git repo and this is a fresh start, recommend or perform `git init` when appropriate.

End with the exact run, test, and build commands plus any follow-up decisions still needed.
