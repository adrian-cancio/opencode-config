# Global OpenCode Rules

These rules apply across projects. When a repository has its own `AGENTS.md`, `CLAUDE.md`, or more specific project instructions, follow those for repo-specific behavior and use this file as the fallback.

## Working Style

- Build context before editing. Start with the smallest useful read/search pass instead of guessing.
- Prefer the smallest correct change. Reuse existing patterns, scripts, and conventions before introducing new ones.
- Verify with the narrowest relevant command or check.
- For review requests, inspect the actual diff and relevant files, then present findings first with file references.

## Existing Projects

- On first touch in an unfamiliar repo, identify the stack, package manager, test/lint/build commands, entrypoints, and important directories before editing.
- Prefer commands defined by the repo: `package.json` scripts, `Makefile`, `Taskfile.yml`, `justfile`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `docker compose`, and similar project-native entrypoints.
- If the repo has no local `AGENTS.md` and it is non-trivial, recommend creating one or running `/init` once the structure is understood.

## New Projects

- Prefer the smallest viable scaffold that fits the requested stack.
- Use official scaffolds or existing team templates when available instead of inventing bespoke structure.
- Add basic project hygiene early when it makes sense: `README`, `.gitignore`, a test/lint/format entry point, and a project `AGENTS.md`.
- If the project starts from scratch and is not already under Git, recommend initializing Git early so session undo/redo remains reliable.

## Skills

- Prefer loading a matching global skill instead of re-deriving the same workflow each time.
- Available global workflows cover project onboarding, new project bootstrap, bug triage, and change review.

## Tools And MCPs

- Prefer `context7` for library/framework documentation and examples.
- Prefer `github` for GitHub-hosted context, issues, pull requests, review comments, releases, and code search.
- Prefer `browsermcp` for real browser behavior, rendered UI debugging, screenshots, and tab state. It requires a connected browser tab.
- Prefer `docker` for container logs, stats, exec, restarts, and runtime inspection.
- Prefer `brave-search` for fresh web research. If it is unavailable, continue with native tools such as `webfetch`.
- Use `scout` when you need upstream library or dependency research without modifying the current workspace.
