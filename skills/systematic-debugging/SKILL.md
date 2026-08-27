---
name: systematic-debugging
description: Systematic debugging workflow for unexpected bugs or errors. Use to isolate root causes through evidence and hypothesis testing before modifying code.
---

# Systematic Debugging

Use this skill when encountering unexpected bugs, test failures, or runtime errors to systematically isolate root causes before proposing fixes.

## Workflow

1. **Gather Evidence**: Collect error messages, stack traces, logs, and failing test output.
2. **Form Hypotheses**: Develop 2-3 minimal hypotheses explaining the bug based on evidence.
3. **Trace Root Cause**: Follow the call chain backward to find the origin of invalid state or execution flow.
4. **Isolate & Test**: Reproduce with the narrowest possible test or command.
5. **Apply Minimal Fix**: Fix the root cause with minimal side effects.
6. **Validate**: Re-run the narrowest test to confirm the fix works and introduce no regressions.

## Output

Return:
- Evidence summary & root cause explanation
- Applied fix details
- Verification test results
