---
name: project-onboarding
description: Existing repo onboarding, codebase summary, architecture mapping, and command discovery. Use when entering an unfamiliar project or asked to summarize how a repository works.
---

# Project Onboarding

Use this when the task is to understand an existing repository before making changes.

## Goals

- Identify the stack, package manager, runtime, and toolchain.
- Find the exact dev, build, test, lint, and format commands from project files.
- Map the highest-leverage directories, entrypoints, and docs.
- Surface risks, unknowns, and missing project instructions.

## Workflow

1. Start with top-level guidance and manifests such as `AGENTS.md`, `README*`, `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `Makefile`, `Taskfile.yml`, `justfile`, and container config.
2. Detect the package manager and toolchain from lockfiles and config instead of assuming.
3. Use targeted search to find entrypoints, routes, background jobs, tests, and config directories. Do not read the whole repo blindly.
4. Prefer repo-defined scripts over generic commands and record them exactly.
5. If the user asked about a specific area, bias the second pass toward that slice of the repo.
6. If external library behavior is important, use `context7`, `github`, or `scout` to confirm it.
7. If the repo has no local `AGENTS.md` and is non-trivial, recommend creating one or running `/init` after the first pass.

## Output

Return:

- the stack and package manager
- exact developer commands
- key directories and entrypoints
- architecture notes relevant to the task
- important unknowns, risks, and next best actions
