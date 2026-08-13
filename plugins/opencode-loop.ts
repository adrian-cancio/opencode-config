import { promises as fs } from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"

const SERVICE = "opencode-loop"
const STATE_DIR = ".opencode/opencode-loop"
const DEFAULT_ACTIVE_GUARD_MS = 45_000
const STALE_ACTIVE_RECOVERY_MS = 45_000
const IDLE_DEBOUNCE_MS = 1_200
const BUSY_RETRY_MS = 5_000
const SESSION_STATUS_CACHE_MS = 1_500
const MIN_DUE_TIMER_MS = 250
const MAX_DUE_TIMER_MS = 2_147_000_000
const HEARTBEAT_MS = 2_500
const MAX_SCAN_FILES = 200
const MAX_SCAN_BYTES = 2_000_000
const LOOP_OWNED_USER_MESSAGE_GUARD_MS = 10_000
const LOOP_OWNED_USER_MESSAGE_RETENTION_MS = 10 * 60_000
const LOCAL_COMMAND_AGENT = "opencode-loop-local"

const activeRuns = new Map()
const handledCommands = new Map()
const handledCommandEvents = new Map()
const sessionExecutionContexts = new Map()
const loopOwnedUserMessageGuards = new Map()
const idleTimers = new Map()
const dueTimers = new Map()
const watchdogTimers = new Map()
const runLocks = new Map()
const knownSessions = new Map()
const stateWriteLocks = new Map()
const activeToolCalls = new Map()
const sessionParents = new Map()
let heartbeatTimer
const sessionStatuses = new Map()
const sessionStatusSeenAt = new Map()

const DEFAULT_PROGRESS_MD = `# Progress

## Current Goal
Describe the current project goal here.

## Agent Rules
- Do not ask questions unless truly blocked.
- Make reasonable assumptions and continue.
- Work on unfinished TODOs in order.
- Mark completed TODOs with [x].
- Add new bugs, ideas, and follow-up work as TODOs.
- Run tests, lint, or build when available.
- Do not run destructive commands, force pushes, production deploys, or database resets.

## Active TODO
- [ ] Review the project structure and pick the next safe improvement.

## Completed
- [x] Created progress.md.

## Backlog Ideas
- [ ] Add more project-specific tasks here.

## Blocked
- None.
`

function now() {
  return Date.now()
}

function safeID(value) {
  return String(value || "job")
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "job"
}

function parseDuration(value) {
  const input = String(value || "").trim()
  if (input === "0") return 0
  const match = input.match(/^(\d+)\s*(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i)
  if (!match) return null
  const amount = Number.parseInt(match[1], 10)
  const unit = match[2].toLowerCase()
  if (!Number.isFinite(amount) || amount < 0) return null
  if (unit === "ms") return amount
  if (unit.startsWith("s")) return amount * 1000
  if (unit.startsWith("m")) return amount * 60_000
  if (unit.startsWith("h")) return amount * 3_600_000
  if (unit.startsWith("d")) return amount * 86_400_000
  return null
}

function durationToText(ms) {
  if (ms === 0) return "every idle"
  if (!Number.isFinite(ms)) return "unknown"
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`
  if (ms % 60_000 === 0) return `${ms / 60_000}m`
  if (ms % 1000 === 0) return `${ms / 1000}s`
  return `${ms}ms`
}

function splitFirst(input) {
  const match = String(input || "").trim().match(/^(\S+)\s*([\s\S]*)$/)
  if (!match) return ["", ""]
  return [match[1], (match[2] || "").trim()]
}

function stripOuterQuotes(value) {
  const input = String(value || "").trim()
  if ((input.startsWith('"') && input.endsWith('"')) || (input.startsWith("'") && input.endsWith("'"))) {
    return input.slice(1, -1)
  }
  return input
}

function escapeRegExp(value) {
  return String(value).replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")
}

function takeFlag(rest, flag) {
  const pattern = new RegExp(`(^|\\s)${escapeRegExp(flag)}(?=\\s|$)`, "i")
  const found = pattern.test(rest)
  return [found, rest.replace(pattern, " ").replace(/\s+/g, " ").trim()]
}

function takeFlagValue(rest, flag) {
  const pattern = new RegExp(`(^|\\s)${escapeRegExp(flag)}\\s+(?:\"([^\"]*)\"|'([^']*)'|(\\S+))`, "i")
  const match = rest.match(pattern)
  if (!match) return [undefined, rest]
  const value = match[2] ?? match[3] ?? match[4]
  return [value, rest.replace(pattern, " ").replace(/\s+/g, " ").trim()]
}

function takeAllFlagValues(rest, flag) {
  const values = []
  let current = rest
  while (true) {
    const [value, next] = takeFlagValue(current, flag)
    if (value === undefined) return [values, current]
    values.push(value)
    current = next
  }
}

function parsePositiveInt(value, fallback = 0) {
  const parsed = Number.parseInt(String(value || ""), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parseCompactEvery(value) {
  const duration = parseDuration(value)
  if (duration !== null) return { compactEveryMs: duration }
  const runs = parsePositiveInt(value, 0)
  return runs > 0 ? { compactEveryRuns: runs } : {}
}

function parseLoopArgs(raw, defaults = {}) {
  let input = stripOuterQuotes(String(raw || "").trim())
  let first = ""
  let rest = input
  let intervalMs = defaults.intervalMs ?? null

  if (!input && defaults.action) {
    rest = defaults.action
  } else {
    ;[first, rest] = splitFirst(input)
    if (first === "--watch") {
      intervalMs = defaults.intervalMs ?? 0
      rest = input
    } else if (first) {
      const parsedDuration = parseDuration(first)
      if (parsedDuration !== null) intervalMs = parsedDuration
      else if (intervalMs === null) return { ok: false, error: "Usage: /loop 0s <prompt> | /loop 5m <prompt> | /loop-command 200m /compact | /loop-shell 10m npm test | /loop --watch progress.md <prompt>" }
      else rest = input
    }
  }

  if (intervalMs === null) intervalMs = 0

  const job = {
    id: `${now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`,
    name: defaults.name,
    action: defaults.action || "",
    kind: defaults.kind || undefined,
    intervalMs,
    immediate: defaults.immediate ?? true,
    maxRuns: defaults.maxRuns ?? 0,
    maxRuntimeMs: defaults.maxRuntimeMs ?? 0,
    maxFailures: defaults.maxFailures ?? 0,
    timeoutMs: defaults.timeoutMs ?? 0,
    until: defaults.until,
    stopFile: defaults.stopFile,
    progressFile: defaults.progressFile,
    promptFile: defaults.promptFile,
    includeFiles: Array.isArray(defaults.includeFiles) ? [...defaults.includeFiles] : [],
    watchPaths: Array.isArray(defaults.watchPaths) ? [...defaults.watchPaths] : [],
    compactEveryRuns: defaults.compactEveryRuns ?? 0,
    compactEveryMs: defaults.compactEveryMs ?? 0,
    testCommand: defaults.testCommand,
    verifyCommand: defaults.verifyCommand,
    preflightCommand: defaults.preflightCommand,
    postrunCommand: defaults.postrunCommand,
    notifyCommand: defaults.notifyCommand,
    branch: defaults.branch,
    branchDone: false,
    noOverlap: defaults.noOverlap ?? true,
    safe: defaults.safe ?? false,
    quiet: defaults.quiet ?? false,
    askNever: defaults.askNever ?? false,
    pauseOnVerifyFail: defaults.pauseOnVerifyFail ?? false,
    gitCheckpoint: defaults.gitCheckpoint ?? false,
    checkpointOnly: defaults.checkpointOnly ?? false,
    dryRun: defaults.dryRun ?? false,
    multi: defaults.multi ?? false,
    batch: defaults.batch ?? 0,
    runCount: 0,
    failureCount: 0,
    lastRunAt: 0,
    lastCompactAt: 0,
    lastCompactRunCount: 0,
    watchSnapshot: {},
    watchTriggered: false,
    createdAt: new Date().toISOString(),
    enabled: true,
    paused: false,
  }

  let found
  let value

  ;[found, rest] = takeFlag(rest, "--no-now"); if (found) job.immediate = false
  ;[found, rest] = takeFlag(rest, "--now"); if (found) job.immediate = true
  ;[found, rest] = takeFlag(rest, "--no-overlap"); if (found) job.noOverlap = true
  ;[found, rest] = takeFlag(rest, "--allow-overlap"); if (found) job.noOverlap = false
  ;[found, rest] = takeFlag(rest, "--safe"); if (found) job.safe = true
  ;[found, rest] = takeFlag(rest, "--quiet"); if (found) job.quiet = true
  ;[found, rest] = takeFlag(rest, "--ask-never"); if (found) job.askNever = true
  ;[found, rest] = takeFlag(rest, "--git-checkpoint"); if (found) job.gitCheckpoint = true
  ;[found, rest] = takeFlag(rest, "--checkpoint-only"); if (found) job.checkpointOnly = true
  ;[found, rest] = takeFlag(rest, "--pause-on-verify-fail"); if (found) job.pauseOnVerifyFail = true
  ;[found, rest] = takeFlag(rest, "--dry-run"); if (found) job.dryRun = true
  ;[found, rest] = takeFlag(rest, "--multi"); if (found) job.multi = true
  ;[found, rest] = takeFlag(rest, "--replace"); if (found) job.multi = false
  ;[found, rest] = takeFlag(rest, "--prompt"); if (found) job.kind = "prompt"
  ;[found, rest] = takeFlag(rest, "--ask"); if (found) job.kind = "prompt"
  ;[found, rest] = takeFlag(rest, "--command"); if (found) job.kind = "command"
  ;[found, rest] = takeFlag(rest, "--cmd"); if (found) job.kind = "command"
  ;[found, rest] = takeFlag(rest, "--slash"); if (found) job.kind = "command"
  ;[found, rest] = takeFlag(rest, "--shell"); if (found) job.kind = "shell"
  ;[found, rest] = takeFlag(rest, "--compact"); if (found) job.kind = "compact"

  ;[value, rest] = takeFlagValue(rest, "--name"); if (value !== undefined) job.name = value.trim()
  ;[value, rest] = takeFlagValue(rest, "--max-runs"); if (value !== undefined) job.maxRuns = parsePositiveInt(value, 0)
  ;[value, rest] = takeFlagValue(rest, "--max-turns"); if (value !== undefined) job.maxRuns = parsePositiveInt(value, 0)
  ;[value, rest] = takeFlagValue(rest, "--timeout"); if (value !== undefined) job.timeoutMs = parseDuration(value) ?? 0
  ;[value, rest] = takeFlagValue(rest, "--max-runtime"); if (value !== undefined) job.maxRuntimeMs = parseDuration(value) ?? 0
  ;[value, rest] = takeFlagValue(rest, "--max-failures"); if (value !== undefined) job.maxFailures = parsePositiveInt(value, 0)
  ;[value, rest] = takeFlagValue(rest, "--until"); if (value !== undefined) job.until = stripOuterQuotes(value)
  ;[value, rest] = takeFlagValue(rest, "--stop-file"); if (value !== undefined) job.stopFile = stripOuterQuotes(value)
  ;[value, rest] = takeFlagValue(rest, "--progress-file"); if (value !== undefined) job.progressFile = stripOuterQuotes(value)
  ;[value, rest] = takeFlagValue(rest, "--prompt-file"); if (value !== undefined) job.promptFile = stripOuterQuotes(value)
  ;[value, rest] = takeFlagValue(rest, "--test"); if (value !== undefined) job.testCommand = stripOuterQuotes(value)
  ;[value, rest] = takeFlagValue(rest, "--verify"); if (value !== undefined) job.verifyCommand = stripOuterQuotes(value)
  ;[value, rest] = takeFlagValue(rest, "--preflight"); if (value !== undefined) job.preflightCommand = stripOuterQuotes(value)
  ;[value, rest] = takeFlagValue(rest, "--postrun"); if (value !== undefined) job.postrunCommand = stripOuterQuotes(value)
  ;[value, rest] = takeFlagValue(rest, "--notify"); if (value !== undefined) job.notifyCommand = stripOuterQuotes(value)
  ;[value, rest] = takeFlagValue(rest, "--branch"); if (value !== undefined) job.branch = stripOuterQuotes(value)
  ;[value, rest] = takeFlagValue(rest, "--batch"); if (value !== undefined) job.batch = parsePositiveInt(value, 0)
  ;[value, rest] = takeFlagValue(rest, "--compact-every")
  if (value !== undefined) Object.assign(job, parseCompactEvery(value))

  const watch = takeAllFlagValues(rest, "--watch")
  job.watchPaths.push(...watch[0].map(stripOuterQuotes).filter(Boolean))
  rest = watch[1]

  const includes = takeAllFlagValues(rest, "--include-file")
  job.includeFiles.push(...includes[0].map(stripOuterQuotes).filter(Boolean))
  rest = includes[1]

  job.action = stripOuterQuotes(rest || job.action || "")
  job.watchPaths = [...new Set(job.watchPaths)]
  job.includeFiles = [...new Set(job.includeFiles)]
  job.lastRunAt = job.immediate ? 0 : now()

  if (!job.action && !job.promptFile) return { ok: false, error: "Missing action. Example: /loop 0s continue from progress.md, or /loop 0s --prompt-file loop-prompt.md" }
  return { ok: true, job }
}

function stateDir(directory) { return path.join(directory, STATE_DIR) }
function statePath(directory, sessionID) { return path.join(stateDir(directory), `${safeID(sessionID)}.json`) }
async function ensureDir(directory) { await fs.mkdir(directory, { recursive: true }) }
async function pathExists(filePath) { try { await fs.access(filePath); return true } catch { return false } }

function stateLockKey(directory, sessionID) {
  return `${path.resolve(directory)}:${safeID(sessionID)}`
}

async function withStateWriteLock(directory, sessionID, fn) {
  const key = stateLockKey(directory, sessionID)
  const previous = stateWriteLocks.get(key) || Promise.resolve()
  let release
  const current = new Promise((resolve) => { release = resolve })
  const next = previous.catch(() => {}).then(() => current)
  stateWriteLocks.set(key, next)
  await previous.catch(() => {})
  try {
    return await fn()
  } finally {
    release()
    if (stateWriteLocks.get(key) === next) stateWriteLocks.delete(key)
  }
}

async function readState(directory, sessionID) {
  const target = statePath(directory, sessionID)
  try {
    const parsed = JSON.parse(await fs.readFile(target, "utf8"))
    return { version: 4, jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [] }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      try {
        await ensureDir(stateDir(directory))
        await fs.copyFile(target, `${target}.corrupt-${Date.now()}`)
      } catch {}
    }
    return { version: 4, jobs: [] }
  }
}

async function writeState(directory, sessionID, state) {
  await withStateWriteLock(directory, sessionID, async () => {
    await ensureDir(stateDir(directory))
    const target = statePath(directory, sessionID)
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`
    try {
      await fs.writeFile(temp, JSON.stringify({ version: 4, jobs: state.jobs || [] }, null, 2))
      await fs.rename(temp, target)
    } finally {
      try { await fs.rm(temp, { force: true }) } catch {}
    }
  })
}

async function removeState(directory, sessionID) {
  await withStateWriteLock(directory, sessionID, async () => {
    try { await fs.unlink(statePath(directory, sessionID)) } catch {}
  })
}

function sdkError(result) {
  if (!result || typeof result !== "object") return undefined
  return result.error || result.error === null ? result.error : undefined
}

function sdkData(result) {
  if (!result || typeof result !== "object") return result
  return Object.prototype.hasOwnProperty.call(result, "data") ? result.data : result
}

function sdkErrorMessage(error) {
  if (!error) return "unknown SDK error"
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (typeof error === "object") {
    if (typeof error.message === "string") return error.message
    if (typeof error.name === "string") return error.name
    try { return JSON.stringify(error).slice(0, 400) } catch {}
  }
  return String(error)
}

async function sdkCall(method, ...argsList) {
  let firstError
  for (const args of argsList) {
    if (args === undefined) continue
    try {
      const result = await method(args)
      const error = sdkError(result)
      if (!error) return sdkData(result)
      firstError = firstError || new Error(sdkErrorMessage(error))
    } catch (error) {
      firstError = firstError || error
    }
  }
  throw firstError || new Error("SDK call failed without arguments")
}

function fireSdk(client, label, method, ...argsList) {
  Promise.resolve()
    .then(() => sdkCall(method, ...argsList))
    .catch((error) => log(client, "warn", `${label} failed`, { error: sdkErrorMessage(error) }))
}

async function executeTuiCommand(client, command) {
  if (!client?.tui?.executeCommand) throw new Error("client.tui.executeCommand is not available")
  return await sdkCall(
    client.tui.executeCommand.bind(client.tui),
    { body: { command } },
    { command },
  )
}

function compactTuiCommandName(command = "compact") {
  const normalized = String(command || "compact").replace(/^\/+/, "").trim().toLowerCase()
  if (normalized === "compact" || normalized === "summarize") return "session_compact"
  return undefined
}

async function compactSession(client, sessionID) {
  // OpenCode's TUI API accepts legacy keybind aliases (session_compact) in
  // current builds, while some older docs/examples mention the event value
  // (session.compact). Try the alias first, then the event value, then the
  // session summarize endpoint as a last resort.
  for (const command of ["session_compact", "session.compact"]) {
    try {
      await executeTuiCommand(client, command)
      return true
    } catch (error) {
      await log(client, "warn", `tui ${command} failed`, { error: sdkErrorMessage(error) })
    }
  }
  try {
    await sdkCall(
      client.session.summarize.bind(client.session),
      { path: { id: sessionID }, body: {} },
      { path: { sessionID }, body: {} },
      { sessionID },
    )
    return true
  } catch (error) {
    await log(client, "warn", "session.summarize fallback failed", { error: sdkErrorMessage(error) })
  }
  await toast(client, "Could not run /compact from loop. Check OpenCode version and active TUI session.", "error")
  return false
}

async function log(client, level, message, extra) {
  try {
    await sdkCall(
      client.app.log.bind(client.app),
      { body: extra === undefined ? { service: SERVICE, level, message } : { service: SERVICE, level, message, extra } },
      extra === undefined ? { service: SERVICE, level, message } : { service: SERVICE, level, message, extra },
    )
  } catch {}
}

async function toast(client, message, variant = "info") {
  try { await sdkCall(client.tui.showToast.bind(client.tui), { body: { message, variant } }, { message, variant }) } catch {}
}

function guardLoopOwnedUserMessage(sessionID) {
  if (!sessionID) return
  const current = loopOwnedUserMessageGuards.get(sessionID) || { pending: 0, until: 0, messageIDs: new Map() }
  current.pending += 1
  current.until = Math.max(current.until || 0, now() + LOOP_OWNED_USER_MESSAGE_GUARD_MS)
  for (const [messageID, expiresAt] of current.messageIDs.entries()) if (expiresAt < now()) current.messageIDs.delete(messageID)
  loopOwnedUserMessageGuards.set(sessionID, current)
  for (const [key, entry] of loopOwnedUserMessageGuards.entries()) {
    for (const [messageID, expiresAt] of entry.messageIDs.entries()) if (expiresAt < now()) entry.messageIDs.delete(messageID)
    if ((entry.pending || 0) <= 0 && entry.messageIDs.size === 0 && (entry.until || 0) < now()) loopOwnedUserMessageGuards.delete(key)
  }
}

function loopOwnedUserMessageGuardActive(sessionID, messageID) {
  const entry = loopOwnedUserMessageGuards.get(sessionID)
  if (!entry || typeof entry !== "object") return false
  for (const [id, expiresAt] of entry.messageIDs.entries()) if (expiresAt < now()) entry.messageIDs.delete(id)
  const id = typeof messageID === "string" ? messageID : ""
  if (id && entry.messageIDs.has(id)) return true
  if ((entry.pending || 0) > 0 && (entry.until || 0) >= now()) {
    entry.pending -= 1
    if (id) entry.messageIDs.set(id, now() + LOOP_OWNED_USER_MESSAGE_RETENTION_MS)
    loopOwnedUserMessageGuards.set(sessionID, entry)
    return true
  }
  if ((entry.pending || 0) <= 0 && entry.messageIDs.size === 0) loopOwnedUserMessageGuards.delete(sessionID)
  return false
}

async function say(client, sessionID, text) {
  guardLoopOwnedUserMessage(sessionID)
  try {
    await sdkCall(
      client.session.prompt.bind(client.session),
      { path: { id: sessionID }, body: { noReply: true, parts: [{ type: "text", text }] } },
      { path: { sessionID }, body: { noReply: true, parts: [{ type: "text", text }] } },
      { sessionID, noReply: true, parts: [{ type: "text", text }] },
    )
  } catch {}
}

function commandKey(sessionID, name, args) { return `${sessionID || "no-session"}:${name || ""}:${normalizeArgsForKey(args)}` }
function markHandled(sessionID, name, args) {
  const key = commandKey(sessionID, name, args)
  const previous = handledCommands.get(key)
  const pending = previous && now() - previous.time < 30_000 ? previous.pending + 1 : 1
  handledCommands.set(key, { time: now(), pending })
  for (const [entryKey, entry] of handledCommands.entries()) if (now() - entry.time > 30_000) handledCommands.delete(entryKey)
  for (const [entryKey, time] of handledCommandEvents.entries()) if (now() - time > 30_000) handledCommandEvents.delete(entryKey)
}
function consumeHandled(sessionID, name, args) {
  const key = commandKey(sessionID, name, args)
  const entry = handledCommands.get(key)
  if (!entry || now() - entry.time >= 30_000) {
    handledCommands.delete(key)
    return false
  }
  if (entry.pending <= 1) handledCommands.delete(key)
  else handledCommands.set(key, { time: entry.time, pending: entry.pending - 1 })
  return true
}
function commandEventKey(sessionID, messageID) {
  return `${sessionID || "no-session"}:event:${messageID || "no-message"}`
}

function commandName(name) { return String(name || "") }
function isPreset(name) { return ["loop-dev", "loop-testfix", "loop-compact", "loop-progress", "loop-safe-dev", "loop-command", "loop-cmd", "loop-prompt", "loop-ask", "loop-shell"].includes(name) }
function isLoopCommandName(name) {
  return name === "loop" || name === "loop-stop" || name === "loop-remove" || name === "loop-clear" || name === "loop-status" || name === "loop-logs" || name === "loop-help" || name === "loop-now" || name === "loop-pause" || name === "loop-resume" || name === "loop-doctor" || name === "loop-init" || name === "loop-export" || isPreset(name)
}

function normalizeArgsForKey(args) {
  if (args === undefined || args === null) return ""
  if (typeof args === "string") return args.trim().replace(/\s+/g, " ")
  if (Array.isArray(args)) return args.map(normalizeArgsForKey).join(" ").trim().replace(/\s+/g, " ")
  try { return JSON.stringify(args) } catch { return String(args) }
}

function commandArgsText(args) {
  if (args === undefined || args === null) return ""
  if (typeof args === "string") return args
  if (Array.isArray(args)) return args.map(commandArgsText).join(" ")
  if (typeof args === "object") {
    for (const key of ["arguments", "args", "message", "text", "value"]) {
      if (args[key] !== undefined) return commandArgsText(args[key])
    }
  }
  return String(args)
}

function rememberSession(directory, client, sessionID) {
  if (!sessionID) return
  knownSessions.set(sessionID, { directory, client, seenAt: now() })
  startHeartbeat()
}

function normalizedModelRef(model) {
  if (typeof model === "string") {
    const separator = model.indexOf("/")
    if (separator > 0) return { providerID: model.slice(0, separator), modelID: model.slice(separator + 1) }
    return undefined
  }
  const providerID = model?.providerID
  const modelID = model?.modelID || model?.id
  if (typeof providerID !== "string" || typeof modelID !== "string") return undefined
  return { providerID, modelID }
}

function updateSessionExecutionContext(info) {
  const sessionID = info?.sessionID || info?.id
  if (typeof sessionID !== "string") return
  const previous = sessionExecutionContexts.get(sessionID) || {}
  const candidateAgent = info?.agent || (info?.role === "assistant" ? info?.mode : undefined)
  const agent = typeof candidateAgent === "string" && candidateAgent !== LOCAL_COMMAND_AGENT
    ? candidateAgent
    : previous.agent
  const model = normalizedModelRef(info?.model) || normalizedModelRef(info) || previous.model
  sessionExecutionContexts.set(sessionID, { agent, model })
}

async function captureSessionExecutionContext(client, sessionID) {
  if (client?.session?.get) {
    try {
      const info = await sdkCall(
        client.session.get.bind(client.session),
        { path: { id: sessionID } },
        { path: { sessionID } },
        { sessionID },
      )
      updateSessionExecutionContext(info)
    } catch {}
  }
  const context = sessionExecutionContexts.get(sessionID) || {}
  const normalized = { agent: context.agent || "build", model: context.model }
  sessionExecutionContexts.set(sessionID, normalized)
  return normalized
}

function hasActiveToolCalls(sessionID) {
  return (activeToolCalls.get(sessionID)?.size || 0) > 0
}

function markToolCallActive(input) {
  const sessionID = input?.sessionID
  const callID = input?.callID
  if (typeof sessionID !== "string" || typeof callID !== "string") return
  const calls = activeToolCalls.get(sessionID) || new Set()
  calls.add(callID)
  activeToolCalls.set(sessionID, calls)
  sessionStatuses.set(sessionID, "busy")
  sessionStatusSeenAt.set(sessionID, now())
}

function markToolCallFinished(input) {
  const sessionID = input?.sessionID
  const callID = input?.callID
  if (typeof sessionID !== "string" || typeof callID !== "string") return
  const calls = activeToolCalls.get(sessionID)
  if (!calls) return
  calls.delete(callID)
  if (!calls.size) activeToolCalls.delete(sessionID)
}

function updateSessionRelationship(info, removed = false) {
  const sessionID = info?.id
  if (typeof sessionID !== "string") return
  if (removed || typeof info?.parentID !== "string") sessionParents.delete(sessionID)
  else sessionParents.set(sessionID, info.parentID)
  if (!removed) updateSessionExecutionContext(info)
  else sessionExecutionContexts.delete(sessionID)
}

function updateSessionRelationshipFromEvent(event) {
  if (!["session.created", "session.updated", "session.deleted"].includes(event?.type)) return
  updateSessionRelationship(event?.properties?.info, event.type === "session.deleted")
}

function isDescendantSession(sessionID, ancestorID) {
  const visited = new Set()
  let current = sessionID
  while (sessionParents.has(current) && !visited.has(current)) {
    visited.add(current)
    current = sessionParents.get(current)
    if (current === ancestorID) return true
  }
  return false
}

function hasBusyDescendant(sessionID) {
  for (const childID of sessionParents.keys()) {
    if (!isDescendantSession(childID, sessionID)) continue
    const status = sessionStatuses.get(childID)
    if (status === "busy" || status === "retry" || hasActiveToolCalls(childID)) return true
  }
  return false
}

async function refreshSessionRelationships(client, directory) {
  if (!client?.session?.list) return
  try {
    const sessions = await sdkCall(
      client.session.list.bind(client.session),
      { query: { directory } },
      { directory },
      {},
    )
    if (Array.isArray(sessions)) for (const info of sessions) updateSessionRelationship(info)
  } catch {}
}

function updateToolActivityFromEvent(event) {
  const props = event?.properties || {}
  if (event?.type === "message.part.updated") {
    const part = props.part
    if (part?.type !== "tool") return
    const sessionID = part.sessionID || props.sessionID
    if (["pending", "running"].includes(part.state?.status)) {
      markToolCallActive({ sessionID, callID: part.callID })
    }
    if (["completed", "error"].includes(part.state?.status)) {
      // Task/subagent hooks have used the part id as their hook call id in some
      // OpenCode versions, while normal tools use part.callID. Clear either.
      const identifiers = [...new Set([part.callID, part.id].filter((value) => typeof value === "string"))]
      for (const callID of identifiers) markToolCallFinished({ sessionID, callID })
    }
    return
  }

  const started = ["session.next.shell.started", "session.next.tool.called"].includes(event?.type)
  const finished = ["session.next.shell.ended", "session.next.tool.success", "session.next.tool.failed"].includes(event?.type)
  if (started) markToolCallActive(props)
  if (finished) markToolCallFinished(props)
}

function startHeartbeat() {
  if (heartbeatTimer) return
  heartbeatTimer = setInterval(() => {
    for (const [sessionID, info] of [...knownSessions.entries()]) {
      if (!info || now() - (info.seenAt || 0) > 12 * 60 * 60 * 1000) {
        knownSessions.delete(sessionID)
        continue
      }
      Promise.resolve()
        .then(async () => {
          await finalizeActiveRun(info.directory, info.client, sessionID, { requireIdle: true, forceStale: true })
          await maybeRunDueJobs(info.directory, info.client, sessionID, { heartbeat: true })
        })
        .catch((error) => appendLoopLog(info.directory, "heartbeat-error", { sessionID, error: sdkErrorMessage(error) }).catch(() => {}))
    }
    if (!knownSessions.size && heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = undefined
    }
  }, HEARTBEAT_MS)
}

function disposeRuntime(directory, client) {
  const sessions = [...knownSessions.entries()]
    .filter(([, info]) => info?.directory === directory && info?.client === client)
    .map(([sessionID]) => sessionID)
  for (const sessionID of sessions) {
    clearActiveRun(sessionID)
    const idle = idleTimers.get(sessionID); if (idle) clearTimeout(idle)
    const due = dueTimers.get(sessionID); if (due) clearTimeout(due)
    const watchdog = watchdogTimers.get(sessionID); if (watchdog) clearInterval(watchdog)
    idleTimers.delete(sessionID)
    dueTimers.delete(sessionID)
    watchdogTimers.delete(sessionID)
    runLocks.delete(sessionID)
    knownSessions.delete(sessionID)
    loopOwnedUserMessageGuards.delete(sessionID)
    activeToolCalls.delete(sessionID)
    sessionParents.delete(sessionID)
    sessionStatuses.delete(sessionID)
    sessionStatusSeenAt.delete(sessionID)
    sessionExecutionContexts.delete(sessionID)
    for (const key of handledCommands.keys()) if (key.startsWith(`${sessionID}:`)) handledCommands.delete(key)
    for (const key of handledCommandEvents.keys()) if (key.startsWith(`${sessionID}:`)) handledCommandEvents.delete(key)
  }
  if (!knownSessions.size && heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = undefined
  }
}

function presetDefaults(name) {
  // parseLoopArgs owns duration/flag/action parsing. Presets only provide real
  // defaults; deriving an action from the raw string made flag-only invocations
  // such as `/loop-compact --dry-run` use "--dry-run" as the action.
  if (name === "loop-compact") return { intervalMs: parseDuration("200m"), action: "/compact", kind: "compact", name: "compact", immediate: false }
  if (name === "loop-command" || name === "loop-cmd") return { intervalMs: 0, kind: "command", name: "command", immediate: false }
  if (name === "loop-prompt") return { intervalMs: 0, kind: "prompt", name: "prompt", immediate: true }
  if (name === "loop-ask") return { intervalMs: 0, kind: "prompt", name: "ask", immediate: false }
  if (name === "loop-shell") return { intervalMs: 0, kind: "shell", name: "shell", immediate: false }
  if (name === "loop-testfix") return { intervalMs: 0, name: "testfix", safe: true, askNever: true, verifyCommand: "npm test", testfixPreset: true, action: "Run the project tests. Fix failures. Re-run the tests. Test command hint: npm test" }
  if (name === "loop-progress") return { intervalMs: 0, name: "progress", safe: true, askNever: true, progressFile: "progress.md", action: "Read progress.md and continue the next unfinished TODO. Mark completed TODOs with [x]. Add useful TODOs when you discover them." }
  if (name === "loop-safe-dev") return { intervalMs: 0, name: "safe-dev", safe: true, askNever: true, noOverlap: true, checkpointOnly: true, batch: 5, progressFile: "progress.md", action: "Develop the project from progress.md. Work in small safe batches. Mark completed TODOs with [x]. Add new ideas to progress.md. Run tests/lint/build if available." }
  return { intervalMs: 0, name: "dev", askNever: true, progressFile: "progress.md", action: "Continue developing the project from progress.md. Mark completed TODOs with [x]. Add new ideas to progress.md. Run tests/lint/build if available." }
}

function jobLabel(job) {
  const title = job.name ? `${job.name}: ` : ""
  const kind = job.kind ? ` [${job.kind}]` : ""
  const limit = job.maxRuns > 0 ? `, max ${job.maxRuns}` : ""
  const runtime = job.maxRuntimeMs > 0 ? `, runtime ${durationToText(job.maxRuntimeMs)}` : ""
  const timeout = job.timeoutMs > 0 ? `, timeout ${durationToText(job.timeoutMs)}` : ""
  const compact = job.compactEveryRuns > 0 ? `, compact every ${job.compactEveryRuns} runs` : job.compactEveryMs > 0 ? `, compact every ${durationToText(job.compactEveryMs)}` : ""
  const verify = job.verifyCommand ? ", verify" : ""
  const preflight = job.preflightCommand ? ", preflight" : ""
  const failures = job.maxFailures > 0 ? `, max failures ${job.maxFailures}` : ""
  const stopFile = job.stopFile ? ", stop-file" : ""
  const watch = job.watchPaths?.length ? `, watch ${job.watchPaths.join(",")}` : ""
  const paused = job.paused ? ", paused" : ""
  return `${title}${durationToText(job.intervalMs)}${kind} -> ${job.action || `[prompt-file: ${job.promptFile}]`}${limit}${runtime}${timeout}${compact}${verify}${preflight}${failures}${stopFile}${watch}${paused}`
}

function matchJob(job, target, index) {
  const text = String(target || "").trim()
  if (!text || text.toLowerCase() === "all") return true
  return job.id === text || job.name === text || String(index + 1) === text
}

async function appendLoopLog(directory, line, extra = {}) {
  try {
    await ensureDir(stateDir(directory))
    await fs.appendFile(path.join(stateDir(directory), "loop.log"), JSON.stringify({ time: new Date().toISOString(), line, ...extra }) + "\n")
  } catch {}
}

async function readSmallTextFile(filePath, maxBytes = 120_000) {
  try {
    const stat = await fs.stat(filePath)
    if (!stat.isFile() || stat.size > maxBytes) return ""
    return await fs.readFile(filePath, "utf8")
  } catch { return "" }
}

async function runProcess(command, args, cwd, timeoutMs = 60_000) {
  return await new Promise((resolve) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true })
    const stdout = []
    const stderr = []
    const timer = setTimeout(() => { try { child.kill("SIGTERM") } catch {} }, timeoutMs)
    child.stdout?.on("data", (data) => stdout.push(Buffer.from(data)))
    child.stderr?.on("data", (data) => stderr.push(Buffer.from(data)))
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: -1, stdout: "", stderr: String(error) }) })
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 0, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }) })
  })
}

async function runShellCommand(command, cwd, timeoutMs = 120_000) {
  return await new Promise((resolve) => {
    const child = spawn(command, [], { cwd, shell: true, windowsHide: true })
    const stdout = []
    const stderr = []
    const timer = setTimeout(() => { try { child.kill("SIGTERM") } catch {} }, timeoutMs)
    child.stdout?.on("data", (data) => stdout.push(Buffer.from(data)))
    child.stderr?.on("data", (data) => stderr.push(Buffer.from(data)))
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: -1, stdout: "", stderr: String(error) }) })
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 0, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }) })
  })
}

async function notifyJob(directory, job, reason) {
  if (!job.notifyCommand) return
  const command = String(job.notifyCommand).replace(/\{reason\}/g, String(reason || "")).replace(/\{job\}/g, String(job.name || job.id || ""))
  await runShellCommand(command, directory, 60_000)
}

function dangerousShell(command) {
  const text = String(command || "").toLowerCase()
  return [
    /\brm\b(?=[^\r\n]*\s-{1,2}(?:[a-z]*r[a-z]*|recursive)\b)(?=[^\r\n]*\s-{1,2}(?:[a-z]*f[a-z]*|force)\b)/,
    /\bremove-item\b[^\r\n]*(?:-recurse|-force)/,
    /\bgit\s+reset\b/,
    /\bgit\s+clean\b/,
    /\bgit\s+push\b/,
    /\bdel\b[^\r\n]*\s\/s\b/,
    /\b(?:rmdir|rd)\b[^\r\n]*\s\/s\b/,
    /(?:^|[;&|]\s*)format(?:\.com)?\s+(?:[a-z]:|\/(?:fs|q)\b)/,
    /\bterraform\s+destroy\b/,
    /\bkubectl\s+delete\b/,
    /\bdeploy\b.*\bproduction\b/,
  ].some((pattern) => pattern.test(text))
}

function actionKind(action, job = {}) {
  const text = String(action || "").trim()
  const forced = String(job.kind || "").trim().toLowerCase()
  if (forced === "compact") return "compact"
  if (text === "/compact" || text === "/summarize") return "compact"
  if (forced === "prompt" || forced === "ask") return "prompt"
  if (forced === "command" || forced === "cmd" || forced === "slash") return "command"
  if (forced === "shell") return "shell"
  if (text.startsWith("/")) return "command"
  if (text.startsWith("!") || text.startsWith("$")) return "shell"
  return "prompt"
}

function decoratePrompt(job) {
  const additions = []
  if (job.progressFile) additions.push(`Use ${job.progressFile} as the main progress/TODO state file. Read it before choosing the next task and update it after work.`)
  if (job.lastVerifyFailure) additions.push("Previous verify command failed. Fix this before moving on. Failure summary: " + String(job.lastVerifyFailure).slice(0, 1200))
  if (job.askNever) additions.push("Do not ask the user questions. Make reasonable assumptions and continue. Only write a short BLOCKED note if truly blocked.")
  if (job.safe) additions.push("Safety rules: do not run destructive commands such as git reset, git clean, rm -rf, del /s, rmdir /s, force push, production deploys, production migrations, terraform destroy, or deleting user data. If such an action seems needed, write a BLOCKED note instead.")
  if (job.batch > 0) additions.push(`Batch rule: in this run, work on at most ${job.batch} unfinished TODO item(s). Mark completed items with [x].`)
  if (job.quiet) additions.push("Keep replies short. Summarize only what changed, tests run, and next step.")
  if (job.testCommand) additions.push(`After making changes, run this test/check command if applicable: ${job.testCommand}. If it fails, fix the failure and try again.`)
  if (job.checkpointOnly || job.gitCheckpoint) additions.push("Keep changes incremental and easy to review because the loop will create a checkpoint after the run.")
  if (!additions.length) return job.action
  return `${job.action}\n\nOpenCode loop instructions:\n- ${additions.join("\n- ")}`
}

async function buildPrompt(directory, job) {
  const sections = []
  if (job.promptFile) {
    const text = await readSmallTextFile(path.resolve(directory, job.promptFile))
    if (text.trim()) sections.push(`Instructions from ${job.promptFile}:\n${text.trim()}`)
    else sections.push(`Prompt file ${job.promptFile} was requested but could not be read. Continue from the regular action instead.`)
  }
  if (job.action) sections.push(decoratePrompt(job))
  for (const file of job.includeFiles || []) {
    const text = await readSmallTextFile(path.resolve(directory, file), 80_000)
    if (text.trim()) sections.push(`Context from ${file}:\n${text.trim().slice(0, 20_000)}`)
  }
  return sections.join("\n\n---\n\n") || decoratePrompt(job)
}

async function ensureBranch(directory, job, client, sessionID) {
  if (!job.branch || job.branchDone) return job
  const branch = safeID(job.branch)
  const inRepo = await runProcess("git", ["rev-parse", "--is-inside-work-tree"], directory, 10_000)
  if (inRepo.code !== 0) { job.branchDone = true; return job }
  let result = await runProcess("git", ["switch", branch], directory, 30_000)
  if (result.code !== 0) result = await runProcess("git", ["switch", "-c", branch], directory, 30_000)
  job.branchDone = true
  await toast(client, result.code === 0 ? `Loop branch active: ${branch}` : `Could not switch/create branch: ${branch}`, result.code === 0 ? "success" : "warning")
  await appendLoopLog(directory, "branch", { sessionID, branch, code: result.code })
  return job
}

async function maybeCompact(client, sessionID, job) {
  const dueRuns = job.compactEveryRuns > 0 && (job.runCount || 0) > 0 && (job.runCount || 0) % job.compactEveryRuns === 0 && job.lastCompactRunCount !== job.runCount
  const dueTime = job.compactEveryMs > 0 && (!job.lastCompactAt || now() - job.lastCompactAt >= job.compactEveryMs)
  if (!dueRuns && !dueTime) return job
  if (await compactSession(client, sessionID)) {
    job.lastCompactAt = now()
    job.lastCompactRunCount = job.runCount || 0
  }
  return job
}

async function snapshotPaths(directory, files) {
  const snapshot = {}
  for (const file of files || []) {
    try {
      const stat = await fs.stat(path.resolve(directory, file))
      snapshot[file] = `${stat.mtimeMs}:${stat.size}`
    } catch { snapshot[file] = "missing" }
  }
  return snapshot
}

async function watchChanged(directory, job) {
  if (!job.watchPaths?.length) return false
  const next = await snapshotPaths(directory, job.watchPaths)
  const previous = job.watchSnapshot || {}
  const changed = job.watchPaths.some((file) => previous[file] !== next[file])
  if (changed) job.watchSnapshot = next
  return changed
}

async function fileContains(filePath, needle) {
  try {
    const stat = await fs.stat(filePath)
    if (!stat.isFile() || stat.size > MAX_SCAN_BYTES) return false
    return (await fs.readFile(filePath, "utf8")).includes(needle)
  } catch { return false }
}

async function untilReached(directory, job) {
  if (!job.until) return false
  const files = ["progress.md", "PROGRESS.md", "todo.md", "TODO.md", "todolist.md", "TODOLIST.md", path.join(".opencode", "opencode-loop", "until.txt")]
  for (const file of files) if (await fileContains(path.resolve(directory, file), job.until)) return true
  let scanned = 0
  async function walk(current) {
    if (scanned >= MAX_SCAN_FILES) return false
    let entries
    try { entries = await fs.readdir(current, { withFileTypes: true }) } catch { return false }
    for (const entry of entries) {
      if (scanned >= MAX_SCAN_FILES) return false
      if ([".git", "node_modules", "dist", "build", ".next", "coverage"].includes(entry.name)) continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) { if (await walk(full)) return true }
      else if (entry.isFile() && /\.(md|txt|json|yaml|yml)$/i.test(entry.name)) { scanned++; if (await fileContains(full, job.until)) return true }
    }
    return false
  }
  return await walk(directory)
}

async function createCheckpoint(directory, sessionID, job, client) {
  if (!job.checkpointOnly && !job.gitCheckpoint) return
  const inRepo = await runProcess("git", ["rev-parse", "--is-inside-work-tree"], directory, 10_000)
  if (inRepo.code !== 0) return
  const status = await runProcess("git", ["status", "--short"], directory, 30_000)
  if (!status.stdout.trim()) return
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const checkpointDir = path.join(stateDir(directory), "checkpoints", safeID(sessionID))
  await ensureDir(checkpointDir)
  const diff = await runProcess("git", ["diff", "--binary"], directory, 120_000)
  const staged = await runProcess("git", ["diff", "--cached", "--binary"], directory, 120_000)
  const prefix = `${timestamp}-${safeID(job.name || job.id)}`
  await fs.writeFile(path.join(checkpointDir, `${prefix}.status.txt`), status.stdout + status.stderr)
  await fs.writeFile(path.join(checkpointDir, `${prefix}.patch`), `${diff.stdout}\n${staged.stdout}`)
  if (job.gitCheckpoint) {
    await runProcess("git", ["add", "-A"], directory, 120_000)
    await runProcess("git", ["commit", "-m", `chore: opencode loop checkpoint ${timestamp}`], directory, 120_000)
  }
  await toast(client, `Loop checkpoint saved: ${prefix}`, "success")
}

function updateSessionStatusFromEvent(event) {
  const sessionID = event?.properties?.sessionID
  if (typeof sessionID !== "string") return undefined
  if (event?.type === "session.idle") {
    sessionStatuses.set(sessionID, "idle")
    sessionStatusSeenAt.set(sessionID, now())
    return { sessionID, idle: true }
  }
  if (event?.type === "session.status") {
    const status = event?.properties?.status
    const type = status && typeof status === "object" ? status.type : undefined
    if (typeof type === "string") {
      sessionStatuses.set(sessionID, type)
      sessionStatusSeenAt.set(sessionID, now())
    }
    return { sessionID, idle: type === "idle" }
  }
  return undefined
}

function userInterruptSessionFromEvent(event) {
  if (!["message.updated", "message.created"].includes(String(event?.type || ""))) return undefined
  const props = event?.properties || {}
  const info = props.info || props.message || props
  const role = info?.role
  const sessionID = info?.sessionID || props.sessionID
  const messageID = info?.id || props.messageID
  if (role !== "user" || typeof sessionID !== "string") return undefined
  if (loopOwnedUserMessageGuardActive(sessionID, messageID)) return undefined
  return sessionID
}

function staleActiveRun(sessionID) {
  const active = activeRuns.get(sessionID)
  if (!active) return false
  const age = now() - (active.startedAt || 0)
  const configured = Number(active.job?.staleActiveRecoveryMs || active.job?.activeRecoveryMs || 0)
  const threshold = Number.isFinite(configured) && configured > 0 ? configured : STALE_ACTIVE_RECOVERY_MS
  return age >= threshold
}

async function canFinalizeActiveRun(directory, client, sessionID, active, options = {}) {
  if (hasActiveToolCalls(sessionID) || hasBusyDescendant(sessionID)) return false
  if (!options.requireIdle && !options.forceStale) return true
  if (options.forceStale && staleActiveRun(sessionID)) return true
  if (!options.requireIdle) return false

  const live = await readLiveSessionStatus(client, sessionID, directory)
  if (live?.type) return live.type === "idle"

  const cached = sessionStatuses.get(sessionID)
  const seenAt = sessionStatusSeenAt.get(sessionID) || 0
  return cached === "idle" && seenAt > (active.startedAt || 0)
}

async function readLiveSessionStatus(client, sessionID, directory) {
  const argsList = []
  if (directory) argsList.push({ query: { directory } }, { directory }, { workspace: directory })
  argsList.push({})
  for (const args of argsList) {
    try {
      const result = await client.session.status(args)
      const error = sdkError(result)
      if (error) continue
      const data = sdkData(result)
      if (!data || typeof data !== "object" || Array.isArray(data)) continue
      const observedAt = now()
      for (const [observedSessionID, observedStatus] of Object.entries(data)) {
        const observedType = observedStatus && typeof observedStatus === "object" ? observedStatus.type : undefined
        if (typeof observedType !== "string") continue
        sessionStatuses.set(observedSessionID, observedType)
        sessionStatusSeenAt.set(observedSessionID, observedAt)
      }
      // OpenCode's status list contains active sessions; idle sessions are
      // normally omitted. Clear a completed descendant that was previously busy.
      for (const childID of sessionParents.keys()) {
        if (!isDescendantSession(childID, sessionID) || data[childID]) continue
        sessionStatuses.set(childID, "idle")
        sessionStatusSeenAt.set(childID, observedAt)
      }
      if (hasBusyDescendant(sessionID)) return { type: "busy", source: "descendant" }
      const status = data?.[sessionID]
      const type = status && typeof status === "object" ? status.type : undefined
      if (typeof type === "string") return { type, source: "sdk" }
      return { type: "idle", source: "sdk" }
    } catch {}
  }
  return undefined
}

async function sessionStatusType(client, sessionID, directory, options = {}) {
  // OpenCode can briefly report an idle session while a long-running tool or
  // subtask is still executing. Tool lifecycle hooks are the more specific
  // signal here, so never enqueue another turn until every active call ends.
  if (hasActiveToolCalls(sessionID) || hasBusyDescendant(sessionID)) {
    sessionStatuses.set(sessionID, "busy")
    sessionStatusSeenAt.set(sessionID, now())
    return "busy"
  }

  const cached = sessionStatuses.get(sessionID)
  const seenAt = sessionStatusSeenAt.get(sessionID) || 0

  // Idle is safe to trust until OpenCode tells us otherwise. Busy/retry is only
  // trusted briefly: OpenCode custom commands such as /loop-status create their
  // own short assistant turn, and some TUI builds do not always emit the final
  // idle event after that turn. If we cache busy forever, due loop work can get
  // stuck at "due in every idle" until the user types another command.
  if (cached === "idle") return cached
  if (cached && now() - seenAt < SESSION_STATUS_CACHE_MS) return cached

  const live = await readLiveSessionStatus(client, sessionID, directory)
  if (live?.type) {
    // Some OpenCode 1.15.x TUI builds can leave session.status at busy after a
    // plugin-injected turn until the next user command touches the session.
    // When the only reason we still think the session is busy is our own stale
    // active-run guard, recover instead of waiting for another manual command.
    if ((live.type === "busy" || live.type === "retry") && options.recoverStaleActive !== false && staleActiveRun(sessionID)) {
      sessionStatuses.set(sessionID, "idle")
      sessionStatusSeenAt.set(sessionID, now())
      return "idle"
    }
    sessionStatuses.set(sessionID, live.type)
    sessionStatusSeenAt.set(sessionID, now())
    return live.type
  }

  const fallback = activeRuns.has(sessionID) && !staleActiveRun(sessionID) ? "busy" : "idle"
  sessionStatuses.set(sessionID, fallback)
  sessionStatusSeenAt.set(sessionID, now())
  return fallback
}

async function sessionIsIdle(client, sessionID, directory, options = {}) {
  return await sessionStatusType(client, sessionID, directory, options) === "idle"
}

function scheduleIdleWork(directory, client, sessionID) {
  const previous = idleTimers.get(sessionID)
  if (previous) clearTimeout(previous)
  const timer = setTimeout(() => {
    idleTimers.delete(sessionID)
    Promise.resolve()
      .then(async () => {
        if (!await sessionIsIdle(client, sessionID, directory)) {
          await scheduleDueWork(directory, client, sessionID, BUSY_RETRY_MS)
          return
        }
        await finalizeActiveRun(directory, client, sessionID)
        if (!await sessionIsIdle(client, sessionID, directory)) {
          await scheduleDueWork(directory, client, sessionID, BUSY_RETRY_MS)
          return
        }
        await maybeRunDueJobs(directory, client, sessionID)
      })
      .catch((error) => {
        toast(client, `Loop idle handler failed: ${sdkErrorMessage(error)}`, "error").catch(() => {})
        appendLoopLog(directory, "idle-error", { sessionID, error: sdkErrorMessage(error) }).catch(() => {})
      })
  }, IDLE_DEBOUNCE_MS)
  idleTimers.set(sessionID, timer)
}

function jobDueAt(job, current = now()) {
  if (!job.enabled || job.paused) return Infinity
  if (job.maxRuns > 0 && (job.runCount || 0) >= job.maxRuns) return Infinity
  if (job.watchPaths?.length) return Infinity
  const created = Date.parse(job.createdAt || new Date().toISOString())
  if (job.maxRuntimeMs > 0 && current - created >= job.maxRuntimeMs) return current
  if (job.intervalMs === 0) return current
  if (!job.lastRunAt) return current
  return job.lastRunAt + (job.intervalMs || 0)
}

function nextDueDelay(state) {
  const current = now()
  let soonest = Infinity
  for (const job of state.jobs || []) soonest = Math.min(soonest, jobDueAt(job, current))
  if (!Number.isFinite(soonest)) return Infinity
  return Math.max(0, soonest - current)
}

async function startWatchdog(directory, client, sessionID) {
  if (watchdogTimers.has(sessionID)) return
  const timer = setInterval(() => {
    Promise.resolve()
      .then(async () => {
        const state = await readState(directory, sessionID)
        const delay = nextDueDelay(state)
        const hasJobs = (state.jobs || []).some((job) => job.enabled !== false && !job.paused)
        if (!hasJobs || !Number.isFinite(delay)) {
          const existing = watchdogTimers.get(sessionID)
          if (existing) clearInterval(existing)
          watchdogTimers.delete(sessionID)
          return
        }
        if (delay <= 0) await maybeRunDueJobs(directory, client, sessionID)
        else await scheduleDueWork(directory, client, sessionID)
      })
      .catch((error) => appendLoopLog(directory, "watchdog-error", { sessionID, error: sdkErrorMessage(error) }).catch(() => {}))
  }, Math.max(1_000, BUSY_RETRY_MS))
  // Keep this interval referenced. In current OpenCode TUI builds, plugin hooks
  // are event-driven; a referenced watchdog helps scheduled loops wake up even
  // when no manual /loop-status command is typed.
  watchdogTimers.set(sessionID, timer)
}

function stopWatchdog(sessionID) {
  const timer = watchdogTimers.get(sessionID)
  if (timer) clearInterval(timer)
  watchdogTimers.delete(sessionID)
}

async function scheduleDueWork(directory, client, sessionID, minDelayMs = 0) {
  const previous = dueTimers.get(sessionID)
  if (previous) clearTimeout(previous)

  const state = await readState(directory, sessionID)
  const delay = nextDueDelay(state)
  if (!Number.isFinite(delay)) {
    dueTimers.delete(sessionID)
    return
  }

  const wait = Math.min(Math.max(delay, minDelayMs, MIN_DUE_TIMER_MS), MAX_DUE_TIMER_MS)
  const timer = setTimeout(() => {
    dueTimers.delete(sessionID)
    Promise.resolve()
      .then(async () => {
        if (!await sessionIsIdle(client, sessionID, directory)) {
          await scheduleDueWork(directory, client, sessionID, BUSY_RETRY_MS)
          return
        }
        await finalizeActiveRun(directory, client, sessionID)
        if (!await sessionIsIdle(client, sessionID, directory)) {
          await scheduleDueWork(directory, client, sessionID, BUSY_RETRY_MS)
          return
        }
        await maybeRunDueJobs(directory, client, sessionID)
      })
      .catch((error) => {
        toast(client, `Loop due timer failed: ${sdkErrorMessage(error)}`, "error").catch(() => {})
        appendLoopLog(directory, "due-timer-error", { sessionID, error: sdkErrorMessage(error) }).catch(() => {})
      })
  }, wait)
  dueTimers.set(sessionID, timer)
  await startWatchdog(directory, client, sessionID)
}

function dueJobs(state, force = false) {
  const current = now()
  return (state.jobs || []).filter((job) => {
    if (!job.enabled || job.paused) return false
    if (job.maxRuns > 0 && (job.runCount || 0) >= job.maxRuns) return false
    if (job.maxRuntimeMs > 0 && current - Date.parse(job.createdAt || new Date().toISOString()) >= job.maxRuntimeMs) return true
    if (force) return true
    if (job.watchPaths?.length) return job.watchTriggered === true
    return job.intervalMs === 0 || !job.lastRunAt || current - job.lastRunAt >= job.intervalMs
  })
}

function clearActiveRun(sessionID) {
  const active = activeRuns.get(sessionID)
  if (active?.timer) clearTimeout(active.timer)
  activeRuns.delete(sessionID)
}

async function finalizeActiveRun(directory, client, sessionID, options = {}) {
  const active = activeRuns.get(sessionID)
  if (!active) return
  if (!await canFinalizeActiveRun(directory, client, sessionID, active, options)) return false
  const recoveredStale = staleActiveRun(sessionID)
  clearActiveRun(sessionID)
  const state = await readState(directory, sessionID)
  let job = (state.jobs || []).find((candidate) => candidate.id === active.jobId)
  if (!job) return
  job.lastFinishedAt = now()
  if (recoveredStale) await appendLoopLog(directory, "active-stale-recovery", { sessionID, job: job.name || job.id, startedAt: active.startedAt })

  if (job.verifyCommand) {
    const verify = await runShellCommand(job.verifyCommand, directory, job.timeoutMs || 300_000)
    job.lastVerifyAt = now()
    job.lastVerifyCode = verify.code
    if (verify.code === 0) {
      job.failureCount = 0
      job.lastVerifyFailure = ""
      await toast(client, "Loop verify passed: " + job.verifyCommand, "success")
    } else {
      job.failureCount = (job.failureCount || 0) + 1
      job.lastVerifyFailure = (job.verifyCommand + "\nexit=" + verify.code + "\n" + verify.stdout + "\n" + verify.stderr).slice(0, 4000)
      await toast(client, "Loop verify failed: " + job.verifyCommand, "warning")
      if (job.pauseOnVerifyFail || (job.maxFailures > 0 && job.failureCount >= job.maxFailures)) {
        job.paused = true
        await notifyJob(directory, job, "verify_failed")
      }
    }
    await appendLoopLog(directory, "verify", { sessionID, job: job.name || job.id, command: job.verifyCommand, code: verify.code, failures: job.failureCount || 0 })
  }

  if (job.postrunCommand) {
    if (job.safe && dangerousShell(job.postrunCommand)) await appendLoopLog(directory, "postrun-blocked", { sessionID, job: job.name || job.id, command: job.postrunCommand })
    else {
      const postrun = await runShellCommand(job.postrunCommand, directory, job.timeoutMs || 300_000)
      job.lastPostrunCode = postrun.code
      job.lastPostrunAt = now()
      if (postrun.code !== 0) {
        job.failureCount = (job.failureCount || 0) + 1
        job.lastPostrunFailure = (job.postrunCommand + "\nexit=" + postrun.code + "\n" + postrun.stdout + "\n" + postrun.stderr).slice(0, 4000)
        if (job.maxFailures > 0 && job.failureCount >= job.maxFailures) {
          job.paused = true
          await notifyJob(directory, job, "postrun_failed")
        }
      }
      await appendLoopLog(directory, "postrun", { sessionID, job: job.name || job.id, command: job.postrunCommand, code: postrun.code })
    }
  }

  state.jobs = (state.jobs || []).map((candidate) => candidate.id === job.id ? job : candidate).filter((candidate) => candidate.enabled !== false)
  await writeState(directory, sessionID, state)
  await createCheckpoint(directory, sessionID, job, client)
  await scheduleDueWork(directory, client, sessionID)
  return true
}

async function fireAction(directory, client, sessionID, job) {
  const action = String(job.action || "").trim()
  const kind = actionKind(action, job)
  const agent = job.agent || "build"
  const model = normalizedModelRef(job.model)
  if (kind === "compact") {
    const ok = await compactSession(client, sessionID)
    return { startsAssistantTurn: ok, pause: !ok, reason: "compact_failed" }
  }
  if (kind === "command") {
    const normalized = action.startsWith("/") ? action.slice(1) : action
    const [command, argumentsText] = splitFirst(normalized)
    if (!command) {
      await toast(client, "Loop command action is empty. Example: /loop-command 200m /compact", "warning")
      return { startsAssistantTurn: false, pause: true, reason: "empty_command" }
    }
    const tuiCommand = compactTuiCommandName(command)
    if (tuiCommand) {
      guardLoopOwnedUserMessage(sessionID)
      await compactSession(client, sessionID)
      return { startsAssistantTurn: true }
    }
    guardLoopOwnedUserMessage(sessionID)
    const commandBody = { command, arguments: argumentsText, agent }
    if (model) commandBody.model = `${model.providerID}/${model.modelID}`
    await sdkCall(
      client.session.command.bind(client.session),
      { path: { id: sessionID }, body: commandBody },
      { path: { sessionID }, body: commandBody },
      { sessionID, ...commandBody },
    )
    return { startsAssistantTurn: true }
  }
  if (kind === "shell") {
    const command = action.replace(/^[!$]\s*/, "").trim()
    if (job.safe && dangerousShell(command)) {
      await toast(client, `Blocked dangerous shell command in safe mode: ${command}`, "error")
      await appendLoopLog(directory, "blocked", { sessionID, job: job.name || job.id, command })
      return { startsAssistantTurn: false, pause: true, reason: "safe_shell_blocked" }
    }
    guardLoopOwnedUserMessage(sessionID)
    const shellBody = { command, agent }
    if (model) shellBody.model = model
    fireSdk(
      client,
      "session.shell",
      client.session.shell.bind(client.session),
      { path: { id: sessionID }, body: shellBody },
      { path: { sessionID }, body: shellBody },
      { sessionID, ...shellBody },
    )
    return { startsAssistantTurn: true }
  }
  const prompt = await buildPrompt(directory, job)
  const prefix = "AUTONOMOUS OPENCODE LOOP ITERATION. Continue the configured task now. Do not explain the /loop command. Do not search for documentation about this plugin. Do not create scheduler files. Do not ask questions. Make reasonable assumptions and work directly."
  const promptText = `${prefix}

${prompt}`
  guardLoopOwnedUserMessage(sessionID)
  const promptBody = { agent, parts: [{ type: "text", text: promptText }] }
  if (model) promptBody.model = model
  fireSdk(
    client,
    "session.prompt",
    client.session.prompt.bind(client.session),
    { path: { id: sessionID }, body: promptBody },
    { path: { sessionID }, body: promptBody },
    { sessionID, ...promptBody },
  )
  return { startsAssistantTurn: true }
}

async function maybeRunDueJobs(directory, client, sessionID, options = {}) {
  rememberSession(directory, client, sessionID)
  const reschedule = async (minDelayMs = 0) => { await scheduleDueWork(directory, client, sessionID, minDelayMs) }

  if (runLocks.has(sessionID)) {
    await reschedule(BUSY_RETRY_MS)
    return
  }
  runLocks.set(sessionID, now())
  let job
  try {
    await finalizeActiveRun(directory, client, sessionID, { requireIdle: true, forceStale: true })
    if (!await sessionIsIdle(client, sessionID, directory)) {
      if (options.force) await toast(client, "Loop queued: session is busy; it will run on the next idle check.", "info")
      await reschedule(BUSY_RETRY_MS)
      return
    }

    const active = activeRuns.get(sessionID)
    const activeAge = active ? now() - (active.startedAt || 0) : 0
    const activeGuard = active?.job?.timeoutMs || active?.job?.activeRecoveryMs || DEFAULT_ACTIVE_GUARD_MS
    if (active && active.job?.noOverlap !== false && activeAge < activeGuard) {
      await reschedule(BUSY_RETRY_MS)
      return
    }
    if (active && activeAge >= activeGuard) clearActiveRun(sessionID)

    const state = await readState(directory, sessionID)
    for (const candidate of state.jobs || []) {
      if (candidate.watchPaths?.length && !candidate.paused && candidate.enabled && await watchChanged(directory, candidate)) candidate.watchTriggered = true
    }
    const due = dueJobs(state, options.force)
    if (!due.length) {
      await writeState(directory, sessionID, state)
      await reschedule()
      return
    }
    job = due[0]

    if (job.maxRuntimeMs > 0 && now() - Date.parse(job.createdAt || new Date().toISOString()) >= job.maxRuntimeMs) {
      state.jobs = (state.jobs || []).filter((candidate) => candidate.id !== job.id)
      await writeState(directory, sessionID, state)
      await notifyJob(directory, job, "max_runtime_reached")
      await toast(client, `Loop stopped by --max-runtime: ${job.name || job.id}`, "success")
      await appendLoopLog(directory, "max-runtime", { sessionID, job: job.name || job.id })
      await reschedule()
      return
    }
    if (job.stopFile && await pathExists(path.resolve(directory, job.stopFile))) {
      state.jobs = (state.jobs || []).filter((candidate) => candidate.id !== job.id)
      await writeState(directory, sessionID, state)
      await notifyJob(directory, job, "stop_file")
      await toast(client, "Loop stopped by --stop-file: " + job.stopFile, "success")
      await reschedule()
      return
    }
    if (await untilReached(directory, job)) {
      state.jobs = (state.jobs || []).filter((candidate) => candidate.id !== job.id)
      await writeState(directory, sessionID, state)
      await notifyJob(directory, job, "until_reached")
      await toast(client, `Loop stopped by --until: ${job.until}`, "success")
      await reschedule()
      return
    }

    if (job.preflightCommand) {
      if (job.safe && dangerousShell(job.preflightCommand)) {
        job.paused = true
        await writeState(directory, sessionID, state)
        await notifyJob(directory, job, "preflight_blocked")
        await toast(client, "Preflight blocked in safe mode and loop paused: " + job.preflightCommand, "error")
        await reschedule()
        return
      }
      const preflight = await runShellCommand(job.preflightCommand, directory, job.timeoutMs || 300_000)
      await appendLoopLog(directory, "preflight", { sessionID, job: job.name || job.id, command: job.preflightCommand, code: preflight.code })
      if (preflight.code !== 0) {
        job.paused = true
        job.failureCount = (job.failureCount || 0) + 1
        job.lastPreflightFailure = (job.preflightCommand + "\nexit=" + preflight.code + "\n" + preflight.stdout + "\n" + preflight.stderr).slice(0, 4000)
        state.jobs = (state.jobs || []).map((candidate) => candidate.id === job.id ? job : candidate)
        await writeState(directory, sessionID, state)
        await notifyJob(directory, job, "preflight_failed")
        await toast(client, "Preflight failed and loop paused: " + job.preflightCommand, "warning")
        await reschedule()
        return
      }
    }

    job = await ensureBranch(directory, job, client, sessionID)
    job = await maybeCompact(client, sessionID, job)
    job.watchTriggered = false
    job.lastRunAt = now()
    job.runCount = (job.runCount || 0) + 1
    if (job.maxRuns > 0 && job.runCount >= job.maxRuns) {
      job.enabled = false
      await notifyJob(directory, job, "max_runs_reached")
    }
    state.jobs = (state.jobs || []).map((candidate) => candidate.id === job.id ? job : candidate)
    await writeState(directory, sessionID, state)
    await appendLoopLog(directory, "run", { sessionID, job: job.name || job.id, runCount: job.runCount })
    await toast(client, `Loop running: ${job.name || job.id}`, "info")

    try {
      const result = await fireAction(directory, client, sessionID, job)
      if (!result.startsAssistantTurn) {
        const fresh = await readState(directory, sessionID)
        if (result.pause) {
          fresh.jobs = (fresh.jobs || []).map((candidate) => candidate.id === job.id ? {
            ...candidate,
            paused: true,
            failureCount: (candidate.failureCount || 0) + 1,
            lastFailureReason: result.reason || "action_did_not_start",
          } : candidate)
        }
        fresh.jobs = (fresh.jobs || []).filter((candidate) => candidate.enabled !== false)
        await writeState(directory, sessionID, fresh)
        await reschedule()
        return
      }
      let timer
      if (job.timeoutMs > 0) timer = setTimeout(() => { fireSdk(client, "session.abort", client.session.abort.bind(client.session), { path: { id: sessionID }, body: {} }, { path: { sessionID }, body: {} }, { sessionID }); toast(client, `Loop timeout fired: ${job.name || job.id}`, "warning").catch(() => {}) }, job.timeoutMs)
      activeRuns.set(sessionID, { jobId: job.id, job, startedAt: now(), timer })
      sessionStatuses.set(sessionID, "busy")
      sessionStatusSeenAt.set(sessionID, now())
      await reschedule(BUSY_RETRY_MS)
    } catch (error) {
      clearActiveRun(sessionID)
      await toast(client, `Loop job failed: ${error instanceof Error ? error.message : String(error)}`, "error")
      await appendLoopLog(directory, "error", { sessionID, job: job?.name || job?.id, error: error instanceof Error ? error.message : String(error) })
      await reschedule(BUSY_RETRY_MS)
    }
  } finally {
    runLocks.delete(sessionID)
  }
}

function normalizeActionForCompare(value) {
  return String(value || "").replace(/\s+/g, " ").trim()
}

function sameLoopDefinition(a, b) {
  if (!a || !b) return false
  return (a.name || "") === (b.name || "") &&
    Number(a.intervalMs || 0) === Number(b.intervalMs || 0) &&
    normalizeActionForCompare(a.action) === normalizeActionForCompare(b.action) &&
    normalizeActionForCompare(a.kind) === normalizeActionForCompare(b.kind) &&
    normalizeActionForCompare(a.promptFile) === normalizeActionForCompare(b.promptFile)
}

async function addLoop(directory, client, sessionID, args, defaults = {}) {
  const parsed = parseLoopArgs(args, defaults)
  if (!parsed.ok) { await toast(client, parsed.error, "warning"); return }
  const executionContext = sessionExecutionContexts.get(sessionID) || { agent: "build" }
  parsed.job.agent = defaults.agent || executionContext.agent || "build"
  parsed.job.model = normalizedModelRef(defaults.model) || executionContext.model
  if (defaults.testfixPreset) {
    const defaultCommand = String(defaults.verifyCommand || "npm test")
    const parsedAction = String(parsed.job.action || "").trim()
    const usedDefaultAction = parsedAction === String(defaults.action || "").trim()
    if (!usedDefaultAction && parsed.job.verifyCommand === defaults.verifyCommand) {
      parsed.job.verifyCommand = parsedAction
      parsed.job.action = `Run the project tests. Fix failures. Re-run the tests. Test command hint: ${parsedAction}`
    } else if (usedDefaultAction && parsed.job.verifyCommand !== defaults.verifyCommand) {
      parsed.job.action = `Run the project tests. Fix failures. Re-run the tests. Test command hint: ${parsed.job.verifyCommand || defaultCommand}`
    }
  }
  if (parsed.job.watchPaths.length) parsed.job.watchSnapshot = await snapshotPaths(directory, parsed.job.watchPaths)
  if (!parsed.job.activeRecoveryMs) {
    parsed.job.activeRecoveryMs = Math.max(DEFAULT_ACTIVE_GUARD_MS, Math.min(90_000, (parsed.job.intervalMs || 0) + 10_000))
  }
  if (parsed.job.dryRun) { await toast(client, `Loop dry run: ${jobLabel(parsed.job)}`, "info"); await say(client, sessionID, "OpenCode loop dry run:\n```json\n" + JSON.stringify(parsed.job, null, 2) + "\n```"); return }
  const state = await readState(directory, sessionID)
  const jobs = Array.isArray(state.jobs) ? state.jobs : []

  // Default behavior is replace/upsert, not append forever. This prevents duplicate
  // loops when OpenCode emits both command.execute.before and command.executed,
  // and it matches the common expectation that /loop configures the current loop.
  let replaced = false
  if (!parsed.job.multi) {
    const targetName = parsed.job.name || "default"
    parsed.job.name = targetName
    state.jobs = jobs.filter((existing) => {
      const existingName = existing.name || "default"
      const shouldReplace = existingName === targetName || sameLoopDefinition(existing, parsed.job)
      if (shouldReplace) replaced = true
      return !shouldReplace
    })
  } else {
    state.jobs = jobs
  }

  state.jobs.push(parsed.job)
  await writeState(directory, sessionID, state)
  await scheduleDueWork(directory, client, sessionID)
  if (parsed.job.immediate) scheduleIdleWork(directory, client, sessionID)
  await toast(client, `${replaced ? "Loop replaced" : "Loop added"}: ${jobLabel(parsed.job)}`, "success")
  await appendLoopLog(directory, replaced ? "replace" : "add", { sessionID, job: parsed.job.name || parsed.job.id, label: jobLabel(parsed.job) })
}

async function stopLoop(directory, client, sessionID, args) {
  const target = String(args || "").trim()
  if (!target || target.toLowerCase() === "all") {
    await removeState(directory, sessionID)
    clearActiveRun(sessionID)
    const due = dueTimers.get(sessionID); if (due) clearTimeout(due); dueTimers.delete(sessionID)
    stopWatchdog(sessionID)
    await toast(client, "All loops stopped for this session.", "success")
    return
  }
  const state = await readState(directory, sessionID)
  const before = state.jobs.length
  state.jobs = state.jobs.filter((job, index) => !matchJob(job, target, index))
  await writeState(directory, sessionID, state)
  await scheduleDueWork(directory, client, sessionID)
  await toast(client, `Stopped ${before - state.jobs.length} loop(s).`, "success")
}

async function updateJobState(directory, client, sessionID, args, updater, message) {
  const target = String(args || "").trim() || "all"
  const state = await readState(directory, sessionID)
  let count = 0
  state.jobs = (state.jobs || []).map((job, index) => matchJob(job, target, index) ? (count++, updater(job)) : job)
  await writeState(directory, sessionID, state)
  await scheduleDueWork(directory, client, sessionID)
  await toast(client, `${message}: ${count} loop(s).`, count ? "success" : "warning")
}

async function statusLoop(directory, client, sessionID) {
  const state = await readState(directory, sessionID)
  const jobs = state.jobs || []
  const lines = jobs.length ? jobs.map((job, index) => {
    const dueIn = Math.max(0, job.intervalMs - (now() - (job.lastRunAt || 0)))
    const flags = [job.paused ? "paused" : "active", job.safe ? "safe" : undefined, job.askNever ? "ask-never" : undefined, job.noOverlap ? "no-overlap" : undefined, job.checkpointOnly ? "checkpoint-only" : undefined, job.gitCheckpoint ? "git-checkpoint" : undefined].filter(Boolean).join(",")
    return `${index + 1}. ${job.id}${job.name ? ` (${job.name})` : ""}: ${jobLabel(job)} | runs=${job.runCount || 0} | failures=${job.failureCount || 0} | due in ${durationToText(dueIn)} | ${flags}`
  }) : ["No active loop jobs."]
  await toast(client, jobs.length ? `${jobs.length} loop job(s).` : "No active loop jobs.", jobs.length ? "info" : "warning")
  await say(client, sessionID, "OpenCode loop status:\n" + lines.join("\n"))
}

async function logsLoop(directory, client, sessionID) {
  let text = "No loop log found."
  try { text = (await fs.readFile(path.join(stateDir(directory), "loop.log"), "utf8")).trim().split(/\r?\n/).slice(-80).join("\n") || text } catch {}
  await say(client, sessionID, "OpenCode loop logs:\n" + text)
}

async function helpLoop(client, sessionID) {
  await say(client, sessionID, [
    "OpenCode Loop help:",
    "/loop 0s <prompt>                                Claude Code style auto-continue",
    "/loop 5m --ask-never --safe <prompt>              interval autonomous prompt loop",
    "/loop-command 200m /compact                       OpenCode slash-command loop, waits for idle",
    "/loop-ask 1h did you run tests and tsc --noEmit?   scheduled question/check prompt",
    "/loop-shell 10m npm test                           shell loop, waits for idle",
    "/loop 200m --command /compact                     same as command loop",
    "/loop 0s --verify \"npm test\" <prompt>            verify after each assistant turn",
    "/loop 0s --prompt-file loop-prompt.md             load prompt from a file",
    "/loop 0s --max-runtime 6h --max-failures 3 <task> stop safely after limits",
    "/loop-doctor | /loop-init | /loop-export",
  ].join("\n"))
}

async function runNow(directory, client, sessionID, args) {
  const target = String(args || "").trim() || "all"
  const state = await readState(directory, sessionID)
  let count = 0
  for (const [index, job] of (state.jobs || []).entries()) if (matchJob(job, target, index)) { job.lastRunAt = 0; job.paused = false; count++ }
  await writeState(directory, sessionID, state)
  await toast(client, `Marked ${count} loop job(s) due now.`, count ? "success" : "warning")
  await maybeRunDueJobs(directory, client, sessionID, { force: true })
}

async function doctorLoop(directory, client, sessionID) {
  const state = await readState(directory, sessionID)
  await say(client, sessionID, [
    "OpenCode Loop doctor:",
    `- plugin: ${SERVICE}`,
    `- project directory: ${directory}`,
    `- state directory: ${stateDir(directory)}`,
    `- active jobs: ${(state.jobs || []).length}`,
    `- node: ${process.version}`,
    `- platform: ${process.platform}`,
    "- smoke test: /loop 0s --max-runs 1 --dry-run continue from progress.md",
  ].join("\n"))
}

async function initLoop(directory, client, sessionID, args) {
  const target = String(args || "").trim() || "progress.md"
  const full = path.resolve(directory, target)
  if (await pathExists(full)) { await toast(client, `${target} already exists.`, "warning"); return }
  await fs.writeFile(full, DEFAULT_PROGRESS_MD, "utf8")
  await toast(client, `Created ${target}.`, "success")
  await appendLoopLog(directory, "init", { sessionID, file: target })
}

async function exportLoop(directory, client, sessionID) {
  const state = await readState(directory, sessionID)
  await say(client, sessionID, "OpenCode loop state export:\n```json\n" + JSON.stringify(state, null, 2) + "\n```")
}

async function handleCommand(directory, client, input, fallbackName, fallbackArgs, output, source = "before") {
  const name = commandName(input?.command ?? input?.name ?? fallbackName)
  const sessionID = input?.sessionID
  const args = commandArgsText(input?.arguments ?? fallbackArgs ?? "")
  if (!sessionID || !name) return false
  rememberSession(directory, client, sessionID)
  if (isLoopCommandName(name)) await captureSessionExecutionContext(client, sessionID)
  if (source === "event") {
    if (consumeHandled(sessionID, name, args)) return true
    const eventKey = commandEventKey(sessionID, input?.messageID)
    if (handledCommandEvents.has(eventKey)) return true
    handledCommandEvents.set(eventKey, now())
  } else {
    // Every before-hook invocation is an intentional command. Keep a pending
    // count only so the matching command.executed compatibility event can be
    // consumed without suppressing a genuine repeated command.
    markHandled(sessionID, name, args)
  }
  if (isLoopCommandName(name)) guardLoopOwnedUserMessage(sessionID)

  const handled = () => {
    if (output && Array.isArray(output.parts)) {
      // The command has already been completed through toasts/noReply prompts
      // and local state. Leaving a placeholder prompt starts an unnecessary
      // model turn; weaker agents may even call tools or spawn subagents.
      output.parts.length = 0
    }
    return true
  }

  if (name === "loop") return await addLoop(directory, client, sessionID, args), handled()
  if (isPreset(name)) return await addLoop(directory, client, sessionID, args, presetDefaults(name, args)), handled()
  if (name === "loop-stop" || name === "loop-remove") return await stopLoop(directory, client, sessionID, args), handled()
  if (name === "loop-clear") return await stopLoop(directory, client, sessionID, "all"), handled()
  if (name === "loop-status") return await statusLoop(directory, client, sessionID), handled()
  if (name === "loop-logs") return await logsLoop(directory, client, sessionID), handled()
  if (name === "loop-help") return await helpLoop(client, sessionID), handled()
  if (name === "loop-now") return await runNow(directory, client, sessionID, args), handled()
  if (name === "loop-pause") return await updateJobState(directory, client, sessionID, args, (job) => ({ ...job, paused: true }), "Paused"), handled()
  if (name === "loop-resume") return await updateJobState(directory, client, sessionID, args, (job) => ({ ...job, paused: false, lastRunAt: 0 }), "Resumed"), handled()
  if (name === "loop-doctor") return await doctorLoop(directory, client, sessionID), handled()
  if (name === "loop-init") return await initLoop(directory, client, sessionID, args), handled()
  if (name === "loop-export") return await exportLoop(directory, client, sessionID), handled()
  if (source === "event") handledCommandEvents.delete(commandEventKey(sessionID, input?.messageID))
  else consumeHandled(sessionID, name, args)
  return false
}

export const OpenCodeLoopPlugin = async ({ client, directory }) => {
  // OpenCode's local SDK can be slow or unavailable while a project instance
  // is still waiting for its plugins to return their hooks. Defer bootstrap
  // calls so headless/server sessions cannot deadlock during plugin loading.
  const bootstrap = setTimeout(() => {
    log(client, "info", "Plugin initialized", { directory }).catch(() => {})
    refreshSessionRelationships(client, directory).catch(() => {})
  }, 0)
  bootstrap.unref?.()
  return {
    dispose: async () => { disposeRuntime(directory, client) },
    "command.execute.before": async (input, output) => { await handleCommand(directory, client, input, undefined, undefined, output) },
    "tool.execute.before": async (input) => { markToolCallActive(input) },
    "tool.execute.after": async (input) => { markToolCallFinished(input) },
    event: async ({ event }) => {
      updateSessionRelationshipFromEvent(event)
      if (event.type === "message.updated") updateSessionExecutionContext(event?.properties?.info)
      updateToolActivityFromEvent(event)
      if (event.type === "command.executed") {
        const props = event.properties || {}
        await handleCommand(directory, client, props, props.name, props.arguments, undefined, "event")
      }
      const interruptedSessionID = userInterruptSessionFromEvent(event)
      if (interruptedSessionID) rememberSession(directory, client, interruptedSessionID)
      const statusUpdate = updateSessionStatusFromEvent(event)
      if (statusUpdate?.sessionID) rememberSession(directory, client, statusUpdate.sessionID)
      if (statusUpdate?.idle) scheduleIdleWork(directory, client, statusUpdate.sessionID)
    },
  }
}

export default OpenCodeLoopPlugin
