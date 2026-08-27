import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

// Startup guard for this config directory. opencode loads opencode.jsonc once
// and hard-fails on invalid config, so this script catches the common breakages
// (bad JSONC, unknown top-level keys, malformed agents, missing MCP wiring)
// before a restart turns them into a dead session.
const configRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const configPath = path.join(configRoot, "opencode.jsonc")
const launcherPath = path.join(configRoot, ".opencode", "mcp.mjs")

// Mirrors the top-level keys opencode accepts. Anything else is rejected at
// startup with ConfigInvalidError, so an unknown key here is a real failure.
const KNOWN_TOP_LEVEL_KEYS = new Set([
  "$schema",
  "username",
  "model",
  "small_model",
  "default_agent",
  "shell",
  "logLevel",
  "share",
  "autoupdate",
  "snapshot",
  "instructions",
  "skills",
  "reference",
  "references",
  "agent",
  "command",
  "provider",
  "disabled_providers",
  "enabled_providers",
  "mcp",
  "plugin",
  "permission",
  "formatter",
  "lsp",
  "experimental",
  "tool_output",
  "compaction",
  "theme",
  "keybinds",
  "layout",
  "attribution",
  "tui",
])

const KNOWN_PERMISSION_KEYS = new Set([
  "read",
  "edit",
  "glob",
  "grep",
  "list",
  "bash",
  "task",
  "external_directory",
  "todowrite",
  "question",
  "webfetch",
  "websearch",
  "lsp",
  "doom_loop",
  "skill",
])

const PERMISSION_ACTIONS = new Set(["allow", "ask", "deny"])
const AGENT_MODES = new Set(["primary", "subagent", "all"])

const errors = []
const warnings = []

function error(message) {
  errors.push(message)
}

function warn(message) {
  warnings.push(message)
}

// Strips // and /* */ comments plus trailing commas so JSONC parses as JSON.
// Skips anything inside string literals to avoid mangling URLs like https://.
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

function parseFrontmatter(content) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(content)
  if (!match) return null

  const fields = {}
  for (const rawLine of match[1].split(/\r?\n/u)) {
    // Only top-level keys matter here; nested blocks are validated by opencode.
    const fieldMatch = /^([A-Za-z_][\w-]*):\s*(.*)$/u.exec(rawLine)
    if (fieldMatch) {
      fields[fieldMatch[1]] = fieldMatch[2].trim()
    }
  }

  return fields
}

function checkPermissionValue(scope, key, value) {
  if (typeof value === "string") {
    if (!PERMISSION_ACTIONS.has(value)) {
      error(`${scope}: permission.${key} has invalid action '${value}'.`)
    }
    return
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    error(`${scope}: permission.${key} must be an action string or a pattern object.`)
    return
  }

  for (const [pattern, action] of Object.entries(value)) {
    if (!PERMISSION_ACTIONS.has(action)) {
      error(`${scope}: permission.${key}['${pattern}'] has invalid action '${action}'.`)
    }
  }
}

function checkPermissionBlock(scope, permission) {
  if (permission === undefined) return

  if (typeof permission === "string") {
    if (!PERMISSION_ACTIONS.has(permission)) {
      error(`${scope}: permission must be an action string or an object.`)
    }
    return
  }

  if (typeof permission !== "object" || permission === null) {
    error(`${scope}: permission must be an action string or an object.`)
    return
  }

  for (const [key, value] of Object.entries(permission)) {
    if (!KNOWN_PERMISSION_KEYS.has(key)) {
      error(`${scope}: unknown permission key '${key}'.`)
      continue
    }

    checkPermissionValue(scope, key, value)
  }
}

function readConfig() {
  if (!fs.existsSync(configPath)) {
    error("Missing opencode.jsonc.")
    return null
  }

  const raw = fs.readFileSync(configPath, "utf8")

  try {
    return JSON.parse(stripJsonc(raw))
  } catch (parseError) {
    error(`opencode.jsonc is not valid JSONC: ${parseError.message}`)
    return null
  }
}

function checkTopLevel(config) {
  if (config.$schema !== "https://opencode.ai/config.json") {
    warn("opencode.jsonc should declare \"$schema\": \"https://opencode.ai/config.json\".")
  }

  for (const key of Object.keys(config)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
      error(`opencode.jsonc: unknown top-level key '${key}' will be rejected at startup.`)
    }
  }
}

// The read rules are the only thing standing between an agent and .env, so a
// missing or reordered block is treated as a hard failure.
function checkSecretGuards(config) {
  const read = config.permission?.read

  if (!read || typeof read !== "object") {
    error("opencode.jsonc: permission.read is missing; .env files would be readable without a prompt.")
    return
  }

  for (const pattern of ["*.env", "*.env.*"]) {
    if (read[pattern] !== "ask" && read[pattern] !== "deny") {
      error(`opencode.jsonc: permission.read['${pattern}'] must be 'ask' or 'deny'.`)
    }
  }

  // Last match wins, so the broad allow has to come before the narrow rules.
  const patterns = Object.keys(read)
  const wildcardIndex = patterns.indexOf("*")
  const envIndex = patterns.indexOf("*.env")

  if (wildcardIndex !== -1 && envIndex !== -1 && wildcardIndex > envIndex) {
    error("opencode.jsonc: permission.read['*'] must be declared before the *.env rules (last match wins).")
  }
}

function checkPlugins(config) {
  for (const entry of config.plugin ?? []) {
    const spec = Array.isArray(entry) ? entry[0] : entry
    if (typeof spec !== "string") {
      error(`opencode.jsonc: plugin entry ${JSON.stringify(entry)} must be a string or [name, options] tuple.`)
      continue
    }

    if (spec.startsWith("./") || spec.startsWith("../")) {
      const pluginPath = path.join(configRoot, spec)
      if (!fs.existsSync(pluginPath)) {
        error(`opencode.jsonc: plugin '${spec}' does not exist at ${pluginPath}.`)
      }
    }
  }
}

function checkMcp(config) {
  for (const [name, server] of Object.entries(config.mcp ?? {})) {
    if (!server.type) {
      error(`opencode.jsonc: mcp '${name}' is missing the required 'type' field.`)
      continue
    }

    if (server.type === "local") {
      if (!Array.isArray(server.command) || server.command.length === 0) {
        error(`opencode.jsonc: mcp '${name}' must define 'command' as a non-empty array.`)
        continue
      }

      // Local servers go through .opencode/mcp.mjs, whose last argument is the
      // binary or REMOTE_SERVERS key it should launch.
      if (server.command.some((part) => typeof part === "string" && part.includes("mcp.mjs"))) {
        if (!fs.existsSync(launcherPath)) {
          error(`opencode.jsonc: mcp '${name}' points at ${launcherPath}, which does not exist.`)
        }
      }
      continue
    }

    if (server.type === "remote" && !server.url) {
      error(`opencode.jsonc: remote mcp '${name}' is missing 'url'.`)
    }
  }
}

function checkReferences(config) {
  const references = config.reference ?? config.references ?? {}

  for (const [alias, value] of Object.entries(references)) {
    const target = typeof value === "string" ? value : value?.path
    if (!target) continue

    const resolved = target.startsWith("~")
      ? path.join(process.env.USERPROFILE || process.env.HOME || "", target.slice(1))
      : path.resolve(configRoot, target)

    if (!fs.existsSync(resolved)) {
      warn(`opencode.jsonc: reference '${alias}' points at ${resolved}, which does not exist.`)
    }
  }
}

function checkAgents() {
  const agentDir = path.join(configRoot, "agents")
  if (!fs.existsSync(agentDir)) return

  for (const file of fs.readdirSync(agentDir).filter((name) => name.endsWith(".md"))) {
    const scope = `agents/${file}`
    const content = fs.readFileSync(path.join(agentDir, file), "utf8")
    const frontmatter = parseFrontmatter(content)

    if (!frontmatter) {
      error(`${scope}: missing YAML frontmatter.`)
      continue
    }

    if (!frontmatter.description) {
      error(`${scope}: missing 'description'.`)
    }

    if (frontmatter.mode && !AGENT_MODES.has(frontmatter.mode)) {
      error(`${scope}: invalid mode '${frontmatter.mode}'.`)
    }

    if (frontmatter.prompt !== undefined) {
      error(`${scope}: remove 'prompt' from frontmatter; the file body is the prompt.`)
    }
  }
}

function checkSkills() {
  const skillsDir = path.join(configRoot, "skills")
  if (!fs.existsSync(skillsDir)) return

  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue

    const scope = `skills/${entry.name}/SKILL.md`
    const skillFile = path.join(skillsDir, entry.name, "SKILL.md")

    if (!fs.existsSync(skillFile)) {
      error(`skills/${entry.name}: missing SKILL.md.`)
      continue
    }

    const frontmatter = parseFrontmatter(fs.readFileSync(skillFile, "utf8"))

    if (!frontmatter) {
      error(`${scope}: missing YAML frontmatter.`)
      continue
    }

    // Skills without a description are filtered out and never surfaced.
    if (!frontmatter.description) {
      error(`${scope}: missing 'description'; the skill will never be surfaced.`)
    }

    if (frontmatter.name && frontmatter.name !== entry.name) {
      error(`${scope}: frontmatter name '${frontmatter.name}' does not match folder '${entry.name}'.`)
    }
  }
}

function checkCommands() {
  const commandDir = path.join(configRoot, "commands")
  if (!fs.existsSync(commandDir)) return

  for (const file of fs.readdirSync(commandDir).filter((name) => name.endsWith(".md"))) {
    const scope = `commands/${file}`
    const content = fs.readFileSync(path.join(commandDir, file), "utf8")
    const frontmatter = parseFrontmatter(content)

    if (!frontmatter?.description) {
      error(`${scope}: missing 'description' in frontmatter.`)
    }

    const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---/u, "").trim()
    if (!body) {
      error(`${scope}: command body is empty; it is the prompt that gets run.`)
    }
  }
}

// .env.example is the committed contract for what the launcher and dotenv
// plugin expect, so every {env:VAR} placeholder must appear in it.
function checkEnvExample(config) {
  const examplePath = path.join(configRoot, ".env.example")

  if (!fs.existsSync(examplePath)) {
    error("Missing .env.example.")
    return
  }

  const declared = new Set(
    fs
      .readFileSync(examplePath, "utf8")
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => line.split("=")[0].trim()),
  )

  const referenced = new Set()
  for (const match of JSON.stringify(config).matchAll(/\{env:([A-Z0-9_]+)\}/gu)) {
    referenced.add(match[1])
  }

  if (fs.existsSync(launcherPath)) {
    const launcher = fs.readFileSync(launcherPath, "utf8")
    for (const match of launcher.matchAll(/requiredEnv:\s*\[([^\]]*)\]/gu)) {
      for (const name of match[1].matchAll(/"([A-Z0-9_]+)"/gu)) {
        referenced.add(name[1])
      }
    }
    // Header templates interpolate {VAR} against the merged env.
    for (const match of launcher.matchAll(/headers:\s*\[([^\]]*)\]/gu)) {
      for (const name of match[1].matchAll(/\{([A-Z0-9_]+)\}/gu)) {
        referenced.add(name[1])
      }
    }
  }

  for (const name of [...referenced].sort()) {
    if (!declared.has(name)) {
      error(`.env.example: missing '${name}', which is referenced by the config or launcher.`)
    }
  }
}

function checkGitignore() {
  const gitignorePath = path.join(configRoot, ".gitignore")

  if (!fs.existsSync(gitignorePath)) {
    error("Missing .gitignore; .env could be committed.")
    return
  }

  const lines = fs
    .readFileSync(gitignorePath, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())

  if (!lines.some((line) => line === ".env" || line === "*.env" || line === ".env*")) {
    error(".gitignore does not ignore .env.")
  }
}

const config = readConfig()

if (config) {
  checkTopLevel(config)
  checkPermissionBlock("opencode.jsonc", config.permission)
  checkSecretGuards(config)
  checkPlugins(config)
  checkMcp(config)
  checkReferences(config)
  checkEnvExample(config)
}

checkAgents()
checkSkills()
checkCommands()
checkGitignore()

for (const message of warnings) {
  process.stdout.write(`warn  ${message}\n`)
}

for (const message of errors) {
  process.stdout.write(`error ${message}\n`)
}

if (errors.length > 0) {
  process.stdout.write(`\n${errors.length} error(s), ${warnings.length} warning(s).\n`)
  process.exit(1)
}

process.stdout.write(`Config OK (${warnings.length} warning(s)).\n`)
