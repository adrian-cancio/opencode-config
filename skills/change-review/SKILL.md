---
name: change-review
description: Code review, diff review, and regression scanning. Use when reviewing local changes, pull requests, or patches rather than implementing new code.
---

# Change Review

Use this when the task is to review changes instead of writing them.

## Review Standard

- Inspect the actual diff and the relevant files before concluding.
- Prioritize correctness, regressions, edge cases, security, performance, and missing tests.
- Prefer concrete findings over style commentary.
- Only raise style issues when they materially affect maintainability or behavior.

## Output

- Present findings first, ordered by severity.
- Include file references when possible.
- If there are no findings, say so explicitly.
- Always mention residual risks or testing gaps.
