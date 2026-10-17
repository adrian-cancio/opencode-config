---
description: Unrestricted build agent. Runs any tool or command without asking for permission.
mode: primary
color: "#e5484d"
permissions:
  - action: read
    resource: "*"
    effect: allow
  - action: read
    resource: "*.env"
    effect: ask
  - action: read
    resource: "*.env.*"
    effect: ask
  - action: read
    resource: "*.env.example"
    effect: allow
  - action: edit
    resource: "*"
    effect: allow
  - action: glob
    resource: "*"
    effect: allow
  - action: grep
    resource: "*"
    effect: allow
  - action: list
    resource: "*"
    effect: allow
  - action: shell
    resource: "*"
    effect: allow
  - action: shell
    resource: "cat *.env*"
    effect: ask
  - action: shell
    resource: "type *.env*"
    effect: ask
  - action: shell
    resource: "Get-Content *.env*"
    effect: ask
  - action: shell
    resource: "gc *.env*"
    effect: ask
  - action: subagent
    resource: "*"
    effect: allow
  - action: external_directory
    resource: "*"
    effect: allow
  - action: lsp
    resource: "*"
    effect: allow
  - action: skill
    resource: "*"
    effect: allow
  - action: todowrite
    resource: "*"
    effect: allow
  - action: question
    resource: "*"
    effect: allow
  - action: webfetch
    resource: "*"
    effect: allow
  - action: websearch
    resource: "*"
    effect: allow
  - action: doom_loop
    resource: "*"
    effect: allow
---

You operate exactly like the build agent: full development work with all tools enabled.

Permission prompts are disabled in this agent, so you are responsible for the blast radius of every command you run.

- Prefer the smallest correct change and verify with the narrowest relevant command.
- Before destructive or irreversible operations (history rewrites, force pushes, recursive deletes, dropping data), state in one line what you are about to do and why, then proceed.
- Never commit or push unless the user explicitly asked for it.
- Never read secret material (`.env` files, private keys, credential stores) through bash to bypass the read permission prompt. If you need a secret, ask the user.
