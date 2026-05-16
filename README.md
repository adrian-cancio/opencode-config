# OpenCode Global Config

Global OpenCode configuration for `~/.config/opencode`.

This repository contains the user-wide OpenCode setup used across projects.

## What This Adds

- Global MCP configuration for:
  - `github`
  - `context7`
  - `browsermcp`
  - `docker`
  - `brave-search`
- Global fallback rules in `AGENTS.md`
- Reusable global skills in `skills/`
- A global `review` subagent in `agents/`
- Reusable global slash commands in `commands/`
- Global TUI settings in `tui.json`
- Global runtime config in `opencode.json`
- Local launcher scripts in `.opencode/` for MCP startup and env loading

## Main Files

- `opencode.json`: global OpenCode runtime config
- `tui.json`: TUI behavior such as notifications and sound
- `AGENTS.md`: global fallback instructions
- `skills/`: reusable workflows that OpenCode can load on demand
- `agents/`: custom global agents
- `commands/`: custom global slash commands
- `.opencode/`: local helper scripts used by the MCP setup
- `.env.opencode-mcp.example`: example env file for MCP secrets

## Included Global Workflows

### Skills

- `project-onboarding`: understand an existing repository quickly
- `new-project-bootstrap`: create a new project with a minimal sensible setup
- `bug-triage`: reproduce, diagnose, and fix bugs
- `change-review`: review diffs and changes with a bug-focused mindset

### Agent

- `review`: read-only code review subagent focused on regressions, bugs, and missing tests

### Commands

- `/onboard`: summarize how a project works
- `/bug`: investigate a bug through to a fix
- `/review`: review current changes
- `/bootstrap`: scaffold a new project or starter

## References

The global config defines these reusable `@` references:

- `@opencode-config` -> `~/.config/opencode`
- `@code` -> `~/Code`

These can be used from any OpenCode session.

## MCP Notes

- Secrets are loaded from `.env.opencode-mcp`.
- `browsermcp` requires a connected BrowserMCP browser session.
- `brave-search` requires `BRAVE_API_KEY`.
- `github` and `context7` are started through the local remote launcher.

## Validation

Useful commands for checking this setup:

- `opencode debug config`
- `opencode mcp list`

## Restart Required

OpenCode loads config at startup. After changing `opencode.json`, `tui.json`, `AGENTS.md`, `skills/`, `agents/`, `commands/`, or plugins, restart OpenCode.
