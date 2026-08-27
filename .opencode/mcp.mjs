import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

// Single entrypoint for every local MCP server. opencode.jsonc points each
// server at this script: node .opencode/mcp.mjs <server>. The script resolves
// the actual binary and required env vars so the config stays short.
const isWindows = process.platform === "win32"
const isDirectScript = Boolean(process.argv[1] && (process.argv[1].endsWith("mcp.mjs") || process.argv[1].endsWith("mcp.ts")))
const rawArgs = process.argv.slice(isDirectScript ? 2 : 1)
// --dry-run resolves the binary and validates env without spawning anything,
// so `npm run check:mcp` can verify every server in one pass.
const isDryRun = rawArgs.includes("--dry-run")
const positionalArgs = rawArgs.filter((arg) => arg !== "--dry-run")
const serverName = positionalArgs[0]
const forwardedArgs = positionalArgs.slice(1)
const configRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

// Remote stdio servers proxied through the `mcp-remote` npm package.
// Header templates are filled in from the merged env before launching.
const REMOTE_SERVERS = {
  github: {
    url: "https://api.githubcopilot.com/mcp/",
    transport: "http-only",
    headers: ["Authorization: Bearer {GITHUB_MCP_PAT}"],
    requiredEnv: ["GITHUB_MCP_PAT"],
  },
  context7: {
    url: "https://mcp.context7.com/mcp",
    transport: "http-only",
    headers: ["CONTEXT7_API_KEY: {CONTEXT7_API_KEY}"],
    requiredEnv: ["CONTEXT7_API_KEY"],
  },
}

// Env vars that must exist in .env before a local binary is allowed to start.
// Servers with no required keys are listed explicitly so --dry-run knows the
// full set of local servers to check.
const REQUIRED_ENV_BY_EXECUTABLE = {
  "brave-search-mcp-server": ["BRAVE_API_KEY"],
  "mcp-server-browsermcp": [],
  "mcp-docker-server": [],
}

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

// Dry-run output never includes header values, which carry tokens.
function reportDryRun(message) {
  process.stdout.write(`ok     ${message}\n`)
}

// Local npm binaries live in node_modules/.bin as .cmd files on Windows.
function resolveExecutable(name) {
  const candidate = path.join(
    configRoot,
    "node_modules",
    ".bin",
    isWindows ? `${name}.cmd` : name,
  )

  if (!fs.existsSync(candidate)) {
    fail(`Missing local npm binary: ${candidate}. Run npm install for ${name}.`)
  }

  return candidate
}

function stripWrappingQuotes(value) {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1)
    }
  }

  return value
}

// Minimal .env parser: KEY=VALUE per line, # for comments, quotes stripped.
function loadEnvFile(filePath) {
  const result = {}
  const content = fs.readFileSync(filePath, "utf8")

  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue

    const separatorIndex = line.indexOf("=")
    if (separatorIndex === -1) continue

    const key = line.slice(0, separatorIndex).trim()
    const value = stripWrappingQuotes(line.slice(separatorIndex + 1).trim())
    result[key] = value
  }

  return result
}

function getEnvCandidates() {
  return [path.join(configRoot, ".env")]
}

function getExistingEnvFiles() {
  return getEnvCandidates().filter((candidate) => fs.existsSync(candidate))
}

// Real process env first, then .env values override it.
function mergeEnvFiles() {
  const merged = { ...process.env }

  for (const filePath of getExistingEnvFiles()) {
    const fileEnv = loadEnvFile(filePath)
    for (const [key, value] of Object.entries(fileEnv)) {
      if (value) {
        merged[key] = value
      }
    }
  }

  return merged
}

// Replace {VAR} placeholders in a header template with env values.
function buildHeaders(headerTemplates, env) {
  return headerTemplates.map((template) =>
    template.replace(/\{([A-Z0-9_]+)\}/gu, (_, key) => env[key] || ""),
  )
}

// Spawn the real server and forward its stdio. On Windows, npm binaries are
// .cmd shims, so they need to run through cmd.exe; the exit code and signals
// are forwarded so the MCP connection is torn down correctly.
function spawnAndProxy(command, args, options) {
  const target = isWindows ? process.env.ComSpec || "cmd.exe" : command
  const targetArgs = isWindows ? ["/d", "/s", "/c", command, ...args] : args

  const child = spawn(target, targetArgs, {
    stdio: "inherit",
    cwd: options.cwd,
    env: options.env,
    shell: false,
  })

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal)
      return
    }

    process.exit(code ?? 0)
  })

  child.on("error", (error) => {
    fail(`Failed to launch MCP '${serverName}': ${error.message}`)
  })
}

// Prefer the local mcp-remote install, fall back to npx -y mcp-remote@latest.
function getMcpRemoteCommand() {
  const localBinary = path.join(
    configRoot,
    "node_modules",
    ".bin",
    isWindows ? "mcp-remote.cmd" : "mcp-remote",
  )

  if (fs.existsSync(localBinary)) {
    return { command: localBinary, args: [] }
  }

  return {
    command: isWindows ? "npx.cmd" : "npx",
    args: ["-y", "mcp-remote@latest"],
  }
}

function launchLocal() {
  const executablePath = resolveExecutable(serverName)
  const mergedEnv = mergeEnvFiles()

  const requiredEnv = REQUIRED_ENV_BY_EXECUTABLE[serverName] || []
  for (const key of requiredEnv) {
    if (!mergedEnv[key]) {
      fail(`Missing required variable ${key} in .env for ${serverName}.`)
    }
  }

  if (isDryRun) {
    reportDryRun(`local  ${serverName} -> ${executablePath}`)
    return
  }

  spawnAndProxy(executablePath, forwardedArgs, { cwd: configRoot, env: mergedEnv })
}

function launchRemote() {
  const config = REMOTE_SERVERS[serverName]
  const envFilePaths = getExistingEnvFiles()

  if (envFilePaths.length === 0) {
    fail(
      `Missing ${path.join(configRoot, ".env")}. Copy .env.example and fill in the required secrets.`,
    )
  }

  const mergedEnv = mergeEnvFiles()

  for (const key of config.requiredEnv) {
    if (!mergedEnv[key]) {
      fail(`Missing required variable ${key} in ${envFilePaths.join(", ")}.`)
    }
  }

  const runtime = getMcpRemoteCommand()
  const args = [...runtime.args, config.url, "--transport", config.transport]
  for (const header of buildHeaders(config.headers, mergedEnv)) {
    args.push("--header", header)
  }

  if (isDryRun) {
    reportDryRun(`remote ${serverName} -> ${runtime.command} ${config.url}`)
    return
  }

  spawnAndProxy(runtime.command, args, { cwd: configRoot, env: mergedEnv })
}

if (!serverName) {
  fail("Usage: node .opencode/mcp.mjs [--dry-run] <github|context7|bin-name> [...args]")
}

// Unknown names are treated as local npm binaries.
if (REMOTE_SERVERS[serverName]) {
  launchRemote()
} else {
  launchLocal()
}
