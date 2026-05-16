---
name: new-project-bootstrap
description: New project bootstrap, greenfield repo setup, initial scaffold, and project hygiene. Use when creating a project from scratch or from a near-empty repository.
---

# New Project Bootstrap

Use this when the user wants a new app, service, library, script, or starter repository.

## Workflow

1. Confirm only the decisions that materially affect the scaffold: stack, runtime, package manager, framework, and deployment target.
2. Prefer the smallest viable official scaffold or minimal manual layout that satisfies the request.
3. Keep dependencies lean. Do not add CI, containers, monorepo tooling, auth, databases, or cloud infrastructure unless requested.
4. Create basic project hygiene early when appropriate: `README`, `.gitignore`, a test/lint/format entry point, and a local `AGENTS.md` once conventions are clear.
5. If the repo is not under Git yet and the user is bootstrapping a fresh project, recommend `git init` early because OpenCode works best in Git repos for undo/redo.
6. For libraries, prioritize API shape, usage examples, and tests.
7. For services or apps, prioritize a runnable development path and clear setup instructions.
8. Preserve the user's chosen stack and visual language; do not impose a generic template.

## Output

Return the chosen structure, why it is minimal, the exact run, test, and build commands, and any follow-up decisions still needed.
