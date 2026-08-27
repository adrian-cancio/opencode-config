import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

// Dry-runs every MCP server declared in opencode.jsonc so a broken binary or a
// missing key surfaces here instead of at startup. Each server is exercised
// through both argv shapes the launcher supports: `node mcp.mjs <name>` and the
// `node -e import(...)` form the config actually uses.
const configRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const configPath = path.join(configRoot, "opencode.jsonc")
const launcherPath = path.join(configRoot, ".opencode", "mcp.mjs")

function stripJsonc(source) {
  let result = ""
  let inString = false
  let inLineComment = false
  let inBlockComment = false
  let escaped = false

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    const next = source[index + 1]

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false
        result += char
      }
      continue
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false
        index += 1
      }
      continue
    }

    if (inString) {
      result += char
      if (escaped) {
        escaped = false
      } else if (char === "\\") {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      result += char
      continue
    }

    if (char === "/" && next === "/") {
      inLineComment = true
      index += 1
      continue
    }

    if (char === "/" && next === "*") {
      inBlockComment = true
      index += 1
      continue
    }

    result += char
  }

  return result.replace(/,(\s*[}\]])/gu, "$1")
}

const config = JSON.parse(stripJsonc(fs.readFileSync(configPath, "utf8")))

// Collect the server key each local MCP entry passes to the launcher: the last
// argument after the mcp.mjs import.
const targets = []
for (const [name, server] of Object.entries(config.mcp ?? {})) {
  if (server.type !== "local" || !Array.isArray(server.command)) continue

  const launcherIndex = server.command.findIndex(
    (part) => typeof part === "string" && part.includes("mcp.mjs"),
  )

  if (launcherIndex === -1) continue

  const serverKey = server.command[launcherIndex + 1]
  if (serverKey) {
    targets.push({ name, serverKey })
  }
}

if (targets.length === 0) {
  process.stdout.write("No local MCP servers found in opencode.jsonc.\n")
  process.exit(0)
}

const inlineImport =
  "import(require('url').pathToFileURL(require('os').homedir()+'/.config/opencode/.opencode/mcp.mjs'))"

// Both invocation shapes must resolve the same server. The argv branching in
// the launcher is what the 40ff5ee refactor unified, so it is worth testing.
const invocations = [
  { label: "direct", args: (key) => [launcherPath, "--dry-run", key] },
  // `--` stops node from parsing --dry-run as one of its own options.
  { label: "inline", args: (key) => ["-e", inlineImport, "--", "--dry-run", key] },
]

let failed = 0

for (const { name, serverKey } of targets) {
  for (const invocation of invocations) {
    const result = spawnSync(process.execPath, invocation.args(serverKey), {
      cwd: configRoot,
      encoding: "utf8",
    })

    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim()

    if (result.status === 0) {
      process.stdout.write(`ok     ${name} (${invocation.label})\n`)
      continue
    }

    failed += 1
    process.stdout.write(`error  ${name} (${invocation.label}): ${output}\n`)
  }
}

if (failed > 0) {
  process.stdout.write(`\n${failed} MCP check(s) failed.\n`)
  process.exit(1)
}

process.stdout.write(`\nAll ${targets.length} MCP server(s) OK.\n`)
