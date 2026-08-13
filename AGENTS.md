# Global OpenCode Rules

These rules apply across projects. When a repository has its own `AGENTS.md`, `CLAUDE.md`, or more specific project instructions, follow those for repo-specific behavior and use this file as the fallback.

## Language Policy

This is a strict, non-negotiable rule that applies to every decision you make:

- **All committed artifacts must be written in 100% English.** This includes: source code, comments, doc comments, commit messages, error messages in code, variable names, identifiers, config values, README, and any other file tracked by git.
- **Respond to the user in whatever language they write to you.** If they write in Spanish, reply in Spanish. If they switch to English, switch to English. Never force a language on the user.
- **Fix existing non-English content when you touch it.** If you edit a file that contains Spanish comments, descriptions, or identifiers, translate them to English as part of the change. Past commits may be in another language; that history is left alone.

If you are unsure whether a file will be committed: assume it will be, and write it in English.

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

## This Configuration Directory

This repo is the global opencode config (`~/.config/opencode`). It is loaded once at startup: after editing `opencode.jsonc`, agents, plugins, or skills, tell the user to restart opencode. Verify agent changes with `opencode agent list`.

Layout:

- `opencode.jsonc` — providers, plugins, permissions, references, MCP servers.
- `tui.json` — TUI behavior (notifications, sounds, theme).
- `AGENTS.md` — global fallback rules.
- `agents/*.md` — custom agents. `mode: primary` shows in the Tab cycle; `mode: subagent` is invoked with `@name`. Per-agent `permission` overrides the global `permission` block, so an agent can be more or less permissive than the default.
- `commands/*.md` — custom slash commands (frontmatter `description` + prompt body).
- `skills/*/SKILL.md` — on-demand workflows, loaded when the task matches the description.
- `plugins/*.ts` — TypeScript plugins (bun runtime). `dotenv.ts` loads `.env` into the main process.
- `.opencode/` — helpers. `mcp.mjs` is the single launcher for all local MCP servers.
- `node_modules/` — the MCP server binaries are npm packages installed here.
- `.env` (gitignored) — secrets. `.env.example` is the committed template.

## Adding an MCP Server

Local servers are launched through `.opencode/mcp.mjs`, which resolves the binary in `node_modules/.bin`, merges `.env` variables, and forwards stdio. To add one:

1. `npm install <package>` in this directory so the binary exists under `node_modules/.bin`.
2. Add an entry to `mcp` in `opencode.jsonc`:
   ```json
   "name": {
     "type": "local",
     "command": ["node", "-e", "import(require('url').pathToFileURL(require('os').homedir()+'/.config/opencode/.opencode/mcp.mjs'))", "<bin-name>"],
     "timeout": 60000
   }
   ```
   The `-e` import resolves `.opencode/mcp.mjs` relative to the user's home config directory in one short line. It works identically on Windows, Linux, and macOS without hardcoding paths or backslashes, and needs no TypeScript flag because the launcher is plain ESM (`.mjs`).
3. If the server needs a key, add it to `.env.example` and, if it must exist at startup, to `REQUIRED_ENV_BY_EXECUTABLE` in `.opencode/mcp.mjs`.
4. Remote stdio servers that run through `mcp-remote` (like `github` and `context7`) get an entry in `REMOTE_SERVERS` in `.opencode/mcp.mjs` instead, then a matching `command` entry pointing at the server key.

Never put real secrets in `opencode.jsonc` or any committed file. Use `{env:VAR}` placeholders and keep values in `.env`.

## Secrets Handling

- `.env` is gitignored; `.env.example` lists every required variable and is the source of truth for what the launcher and `dotenv.ts` expect.
- The global `permission` rules block reading `*.env` and `*.env.*` files and asking before `git push/reset/restore/clean` and `rm`. Do not bypass these with bash.
- The `security` subagent (`@security`) scans staged diffs for leaked secrets before committing; run it when a commit includes new files or config.
