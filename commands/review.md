---
description: Review current changes or a specific scope with a bug-focused mindset
agent: review
---

Review the current changes in this repository with a code-review mindset.
If `$ARGUMENTS` is not empty, treat it as additional review scope or context.

Focus on correctness, regressions, edge cases, risky assumptions, and missing tests.
Inspect the actual diff and the relevant files before concluding.
Present findings first with file references when possible. If there are no findings, say so explicitly and mention residual risks or testing gaps.

Additional context: $ARGUMENTS
