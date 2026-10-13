---
name: shadow-pc
description: Use when a task needs commands or file transfers on Shadow PC.
---

# Shadow PC

Use the local `shadow-bridge` CLI over the existing SSH/Tailscale connection. Do not copy SSH keys or credentials into a repo or Google Drive. The bridge repository and full CLI reference are at `C:/Users/Cancio/Code/shadow-bridge/README.md`; the alias `shadow` is configured in the local user's `~/.ssh/config`. On Shadow, SSH uses Windows PowerShell 5.1, not Bash. For a project, do code changes in the project as usual; use Shadow only when the task calls for remote execution or GPU resources.

From `C:/Users/Cancio/Code/shadow-bridge`:

- `python -m shadow_bridge status --json` checks connectivity/GPU/space. `python -m shadow_bridge wait --timeout 1200 --interval 15` waits for SSH after Shadow starts. Power-on is **not** implemented; `power up|down|state` exits 20. Do not claim that this CLI can start the VM or shut it down.
- `python -m shadow_bridge run -- 'Get-Location'` executes PowerShell and propagates the exit code. Options: `--cwd`, `--env`, `--timeout`, `--log`. A timeout only kills the SSH process; the remote task may continue.
- For long tasks: `python -m shadow_bridge run --detach job-name -- '...'; python -m shadow_bridge job status job-name; python -m shadow_bridge job logs job-name --tail 100`. `job kill job-name` kills the process tree; ask before killing anything the user might own. A repeated completed job name overwrites its old logs.
- `python -m shadow_bridge put SRC DST` and `get SRC DST` verify SHA-256 and refuse an existing destination; `--force` can replace/delete it, so inspect before forcing. DST is the full final path. For huge data, shared Drive is a staging alternative: `G:/Otros ordenadores/Mi PC/Shadow PC Google Drive` locally and `C:/Users/Shadow/Shadow PC Google Drive` on Shadow. Verify complete sync and hash before executing a transferred artifact.

If OpenCode permissions deny access to `C:/Users/Cancio/Code/shadow-bridge` or commands outside the project, do not bypass policy. Report the limitation to Hermes to run the CLI and verify output. Never install extra tooling or modify Shadow configuration implicitly. Tests of the bridge use an injectable fake and must not contact the real host; production command execution is task-specific.
