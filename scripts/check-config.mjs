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

// Native V2 top-level keys. Anything that is neither a V2 key nor a known
// legacy key is reported as an error.
const KNOWN_TOP_LEVEL_KEYS = new Set([
  "$schema",
  "username",
  "model",
  "default_agent",
  "shell",
  "update",
  "snapshots",
  "instructions",
  "skills",
  "references",
  "agents",
  "commands",
  "providers",
  "mcp",
  "plugins",
  "permissions",
  "policies",
  "formatter",
  "lsp",
  "experimental",
  "tool_output",
  "compaction",
  "watcher",
  "media",
  "websearch",
  "warming",
  "worktree",
  "enterprise",
])

// V1 keys that V2 still accepts and normalizes. They keep working, but the
// native V2 form is preferred, so they only produce a warning.
const LEGACY_TOP_LEVEL_KEYS = {
  provider: "providers",
  plugin: "plugins",
  permission: "permissions",
  reference: "references",
  agent: "agents",
  command: "commands",
  snapshot: "snapshots",
  autoupdate: "update",
  small_model: "agents.title.model",
  attachment: "media",
  tools: "permissions",
  mode: "agents",
  logLevel: "OPENCODE_LOG_LEVEL",
  share: null,
  disabled_providers: "policies",
  enabled_providers: "policies",
  theme: "cli.json",
  keybinds: "cli.json",
  layout: "cli.json",
  attribution: null,
  tui: "cli.json",
}

const PERMISSION_EFFECTS = new Set(["allow", "ask", "deny"])
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

// V2 permissions are one ordered array of { action, resource, effect } rules.
// Action names are open-ended strings (plugins and MCP tools add their own),
// so only the shape and the effect are validated.
function checkPermissionRules(scope, permissions) {
  if (permissions === undefined) return

  if (!Array.isArray(permissions)) {
    error(`${scope}: permissions must be an array of { action, resource, effect } rules.`)
    return
  }

  permissions.forEach((rule, index) => {
    const where = `${scope}: permissions[${index}]`

    if (typeof rule !== "object" || rule === null || Array.isArray(rule)) {
      error(`${where} must be an object.`)
      return
    }

    for (const field of ["action", "resource", "effect"]) {
      if (typeof rule[field] !== "string" || rule[field] === "") {
        error(`${where} is missing a string '${field}'.`)
      }
    }

    if (typeof rule.effect === "string" && !PERMISSION_EFFECTS.has(rule.effect)) {
      error(`${where} has invalid effect '${rule.effect}'.`)
    }
  })
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
    if (KNOWN_TOP_LEVEL_KEYS.has(key)) continue

    if (key in LEGACY_TOP_LEVEL_KEYS) {
      const replacement = LEGACY_TOP_LEVEL_KEYS[key]
      warn(
        replacement
          ? `opencode.jsonc: '${key}' is a V1 key; use '${replacement}' instead.`
          : `opencode.jsonc: '${key}' is a V1 key with no V2 equivalent and is ignored.`,
      )
      continue
    }

    error(`opencode.jsonc: unknown top-level key '${key}'.`)
  }
}

// The read rules are the only thing standing between an agent and .env, so a
// missing or reordered rule is treated as a hard failure.
function checkSecretGuards(config) {
  const rules = Array.isArray(config.permissions) ? config.permissions : []
  const readRules = rules
    .map((rule, index) => ({ ...rule, index }))
    .filter((rule) => rule.action === "read")

  if (readRules.length === 0) {
    error("opencode.jsonc: no 'read' permission rules; .env files would be readable without a prompt.")
    return
  }

  for (const pattern of ["*.env", "*.env.*"]) {
    const rule = readRules.find((candidate) => candidate.resource === pattern)

    if (!rule || (rule.effect !== "ask" && rule.effect !== "deny")) {
      error(`opencode.jsonc: a 'read' rule for '${pattern}' must exist with effect 'ask' or 'deny'.`)
    }
  }

  // Last match wins, so the broad allow has to come before the narrow rules.
  const wildcard = readRules.find((rule) => rule.resource === "*")
  const env = readRules.find((rule) => rule.resource === "*.env")

  if (wildcard && env && wildcard.index > env.index) {
    error("opencode.jsonc: the 'read' rule for '*' must come before the *.env rules (last match wins).")
  }
}

function checkPlugins(config) {
  for (const entry of config.plugins ?? []) {
    const spec = typeof entry === "string" ? entry : entry?.package
    if (typeof spec !== "string") {
      error(`opencode.jsonc: plugin entry ${JSON.stringify(entry)} must be a string or { package, options } object.`)
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
  // V2 nests servers under mcp.servers; mcp.timeout holds shared defaults.
  for (const [name, server] of Object.entries(config.mcp?.servers ?? {})) {
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
  const references = config.references ?? config.reference ?? {}

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

    // V1 frontmatter fields that V2 documents as legacy for agents.
    for (const [legacy, replacement] of [
      ["permission", "permissions (an ordered rule list)"],
      ["temperature", "request.body.temperature"],
      ["top_p", "request.body.top_p"],
      ["disable", "disabled"],
      ["maxSteps", "steps"],
      ["tools", "permissions"],
    ]) {
      if (frontmatter[legacy] !== undefined) {
        error(`${scope}: '${legacy}' is a V1 field; use ${replacement}.`)
      }
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
  checkPermissionRules("opencode.jsonc", config.permissions)
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
