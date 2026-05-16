---
name: bug-triage
description: Bug triage, reproduction, root cause analysis, and focused fixes. Use for bug reports, failing tests, stack traces, runtime errors, or broken behavior.
---

# Bug Triage

Use this when the user provides a bug report, error output, failing test, or a symptom that needs diagnosis.

## Workflow

1. Capture the expected behavior, actual behavior, and the shortest reliable reproduction.
2. Reproduce with the narrowest useful command, test, request, or UI path when feasible.
3. Read the concrete evidence first: stack traces, logs, failing assertions, screenshots, and the nearest code.
4. Form a small set of hypotheses ranked by evidence instead of changing code blindly.
5. Fix the root cause with the smallest correct change.
6. Add or update focused regression tests when appropriate.
7. Re-run the narrowest validation that proves the fix.

## Output

Return:

- reproduction or key evidence
- root cause
- fix applied or recommended
- validation performed
- residual risk or follow-up work
