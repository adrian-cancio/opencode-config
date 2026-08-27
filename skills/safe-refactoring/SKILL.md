---
name: safe-refactoring
description: Safe refactoring workflow for code cleanup and structural changes. Use when restructuring, renaming, or refactoring existing code without changing external behavior.
---

# Safe Refactoring

Use this skill when modifying existing code structure, cleaning technical debt, or renaming/extracting components while preserving external behavior.

## Workflow

1. Ensure existing tests or verification checks are passing before starting.
2. Identify the target interface and verify callers across the codebase.
3. Apply micro-refactorings step-by-step (e.g., extract function, rename symbol, inline redundant code).
4. Re-run tests or validation checks after each small change to catch regressions immediately.
5. Verify external behavior and contract remain identical.

## Output

Return:
- summary of structural changes made
- callers updated
- verification status (test results)
