---
name: codebase-recon
description: Git history and risk mapping analysis. Use when onboarding, assessing technical debt, or mapping codebase hotspots and bug-prone files.
---

# Codebase Recon

Use this skill to analyze git history and identify high-risk areas, hotspots, and recent development momentum across the codebase.

## Workflow

1. **Find Hotspots**: Analyze commit frequencies to identify most frequently changed files.
2. **Identify Bug Magnets**: Search commit messages for fix/bug patterns to spot error-prone areas.
3. **Check Recency & Momentum**: Inspect recent git activity to understand active focus areas.
4. **Map Architecture**: Combine file structure with git churn data to highlight architectural risk points.

## Output

Return:
- Top 5-10 codebase hotspots (frequently modified files)
- High-risk or bug-prone areas
- Architecture and momentum summary
