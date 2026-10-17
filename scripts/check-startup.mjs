import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

// Runs `opencode debug agents`, which is the cheapest way to prove the config
// actually loads. A config that fails validation makes this command exit
// non-zero, so it catches breakage the static checks cannot see.
const configRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const isWindows = process.platform === "win32"
const command = isWindows ? "opencode.cmd" : "opencode"

const result = spawnSync(command, ["debug", "agents"], {
  cwd: configRoot,
  encoding: "utf8",
  shell: isWindows,
})

if (result.error) {
  process.stdout.write(`skip  opencode CLI not runnable: ${result.error.message}\n`)
  process.exit(0)
}

const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim()

if (result.status !== 0) {
  process.stdout.write(`${output}\n`)
  process.stdout.write(`\nerror 'opencode debug agents' exited with code ${result.status}.\n`)
  process.exit(1)
}

// The command dumps every resolved permission rule as JSON, which is far too
// noisy for a smoke test. Only the agent ids and modes are worth reporting.
let agents
try {
  agents = JSON.parse(output)
} catch (parseError) {
  process.stdout.write(`error 'opencode debug agents' did not return JSON: ${parseError.message}\n`)
  process.exit(1)
}

if (!Array.isArray(agents) || agents.length === 0) {
  process.stdout.write("error 'opencode debug agents' returned no agents.\n")
  process.exit(1)
}

for (const agent of agents) {
  process.stdout.write(`ok     ${agent.id} (${agent.mode})\n`)
}

process.stdout.write(`\nStartup OK (${agents.length} agent(s)).\n`)
