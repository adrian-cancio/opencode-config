---
name: changelog-generator
description: Automatically creates user-facing changelogs from git commits by analyzing commit history, categorizing changes, and transforming technical commits into clear release notes.
---

# Changelog Generator

Use this skill when asked to generate release notes, CHANGELOG.md entries, or summaries of changes since a specific version or date range.

## Workflow

1. **Analyze Git History**: Inspect commits since the last release tag or over a specified date range (`git log`).
2. **Categorize Changes**: Group commits into Features, Improvements, Bug Fixes, Breaking Changes, and Security.
3. **Filter Internal Noise**: Exclude routine refactors, merge commits, or test-only commits unless requested.
4. **Format Output**: Write clear, professional release notes categorized with clear headings.

## Output

Return:
- Structured release notes with categorized changes
- Option to save directly to `CHANGELOG.md`
