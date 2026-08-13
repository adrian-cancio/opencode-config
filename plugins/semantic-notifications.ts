import type {
  TuiAttentionSoundName,
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from "@opencode-ai/plugin/tui"
import type {
  Event,
  PermissionRequest,
  Session,
} from "@opencode-ai/sdk/v2"

const pluginID = "local.semantic-notifications"

const SUBAGENT_DONE_SOUND_ENABLED = process.env["OPENCODE_SUBAGENT_DONE_SOUND"] === "1"

const DANGEROUS_BASH_PATTERNS = [
  /(^|\s)rm(\s|$)/i,
  /(^|\s)del(\s|$)/i,
  /(^|\s)rmdir(\s|$)/i,
  /remove-item/i,
  /git\s+reset\b/i,
  /git\s+restore\b/i,
  /git\s+clean\b/i,
  /git\s+checkout\s+--/i,
  /shutdown\b/i,
  /reboot\b/i,
  /poweroff\b/i,
  /format\b/i,
  /mkfs\b/i,
] as const

const EDITING_TOOLS = new Set<string>([
  "edit",
  "write",
  "apply_patch",
  "github_create_or_update_file",
  "github_push_files",
  "github_delete_file",
])

type SessionInfo = Pick<Session, "title" | "parentID">

type CycleState = {
  baselineDiff: string
  hadEdit: boolean
  hadTool: boolean
  hadSubtask: boolean
  hadError: boolean
  retried: boolean
}

type SessionLike = TuiPluginApi["state"]["session"] & {
  get: (sessionID: string) => Session | undefined
}

type EventQuestionAsked = Extract<Event, { type: "question.asked" }>
type EventQuestionReplied = Extract<Event, { type: "question.replied" }>
type EventQuestionRejected = Extract<Event, { type: "question.rejected" }>
type EventPermissionAsked = Extract<Event, { type: "permission.asked" }>
type EventPermissionReplied = Extract<Event, { type: "permission.replied" }>
type EventMessagePartUpdated = Extract<Event, { type: "message.part.updated" }>
type EventSessionError = Extract<Event, { type: "session.error" }>
type EventSessionStatus = Extract<Event, { type: "session.status" }>
type EventSessionCreated = Extract<Event, { type: "session.created" }>
type EventSessionUpdated = Extract<Event, { type: "session.updated" }>

function diffFingerprint(api: TuiPluginApi, sessionID: string) {
  return api.state.session
    .diff(sessionID)
    .map((item) => `${item.file}:${item.additions}:${item.deletions}`)
    .sort()
    .join("|")
}

function rememberPending(map: Map<string, Set<string>>, sessionID: string, requestID: string) {
  const requests = map.get(sessionID) ?? new Set<string>()
  if (requests.has(requestID)) return false
  requests.add(requestID)
  map.set(sessionID, requests)
  return true
}

function clearPending(map: Map<string, Set<string>>, sessionID: string, requestID: string) {
  const requests = map.get(sessionID)
  if (!requests) return
  requests.delete(requestID)
  if (requests.size === 0) map.delete(sessionID)
}

function hasPending(
  questions: Map<string, Set<string>>,
  permissions: Map<string, Set<string>>,
  sessionID: string,
) {
  return (questions.get(sessionID)?.size ?? 0) > 0 || (permissions.get(sessionID)?.size ?? 0) > 0
}

function isDangerousPermission(input: Pick<PermissionRequest, "permission" | "patterns" | "always">) {
  if (input.permission !== "bash") return false
  const text = [...input.patterns, ...input.always].join("\n")
  return DANGEROUS_BASH_PATTERNS.some((pattern) => pattern.test(text))
}

function sessionErrorMessage(error: EventSessionError["properties"]["error"]) {
  if (error?.name === "MessageAbortedError") return "Session aborted"

  const dataMessage =
    error?.data && typeof error.data === "object" && "message" in error.data && typeof error.data.message === "string"
      ? error.data.message
      : undefined

  if (dataMessage === "SSE read timed out") return "Model stopped responding"

  switch (error?.name) {
    case "ProviderAuthError":
      return "Provider auth failed"
    case "ContextOverflowError":
      return "Context window exhausted"
    case "StructuredOutputError":
      return "Structured output failed"
    case "APIError":
      return "Model request failed"
    default:
      return "Session error"
  }
}

function completion(input: { subagent: boolean; state: CycleState }) {
  const { subagent, state } = input

  if (subagent) {
    if (state.hadEdit) {
      return {
        message: state.retried ? "Subagent changes ready after retry" : "Subagent changes ready",
        sound: "subagent_done" as const,
      }
    }

    return {
      message: state.retried ? "Subagent done after retry" : "Subagent done",
      sound: "subagent_done" as const,
    }
  }

  if (state.hadEdit) {
    return {
      message: state.retried ? "Code changes ready after retry" : "Code changes ready",
      sound: "done" as const,
    }
  }

  if (state.hadSubtask) {
    return {
      message: state.retried ? "Delegated task done after retry" : "Delegated task done",
      sound: "default" as const,
    }
  }

  if (state.hadTool) {
    return {
      message: state.retried ? "Tool work done after retry" : "Tool work done",
      sound: "default" as const,
    }
  }

  return {
    message: state.retried ? "Answer ready after retry" : "Answer ready",
    sound: "default" as const,
  }
}

const tui: TuiPlugin = async (api) => {
  const cycles = new Map<string, CycleState>()
  const questions = new Map<string, Set<string>>()
  const permissions = new Map<string, Set<string>>()
  const sessions = new Map<string, SessionInfo>()
  const sessionAPI = api.state.session as SessionLike

  const getSession = (sessionID: string | undefined) => {
    if (!sessionID) return undefined

    const remembered = sessions.get(sessionID)
    if (remembered) return remembered

    const live = sessionAPI.get(sessionID)
    if (!live) return undefined

    const next: SessionInfo = {
      title: live.title,
      parentID: live.parentID,
    }

    sessions.set(sessionID, next)
    return next
  }

  const beginCycle = (sessionID: string) => {
    const existing = cycles.get(sessionID)
    if (existing) return existing

    const next: CycleState = {
      baselineDiff: diffFingerprint(api, sessionID),
      hadEdit: false,
      hadTool: false,
      hadSubtask: false,
      hadError: false,
      retried: false,
    }

    cycles.set(sessionID, next)
    return next
  }

  const notify = (sessionID: string | undefined, message: string, sound: TuiAttentionSoundName) => {
    const session = getSession(sessionID)
    const isSubagent = session?.parentID !== undefined
    const soundMuted = sound === "subagent_done" && !SUBAGENT_DONE_SOUND_ENABLED

    void api.attention.notify({
      title: session?.title,
      message,
      notification: isSubagent ? false : { when: "blurred" },
      sound: soundMuted ? false : { name: sound, when: "always" },
    })
  }

  api.event.on("session.created", (event: EventSessionCreated) => {
    sessions.set(event.properties.sessionID, {
      title: event.properties.info.title,
      parentID: event.properties.info.parentID,
    })
  })

  api.event.on("session.updated", (event: EventSessionUpdated) => {
    sessions.set(event.properties.sessionID, {
      title: event.properties.info.title,
      parentID: event.properties.info.parentID,
    })
  })

  api.event.on("question.asked", (event: EventQuestionAsked) => {
    if (!rememberPending(questions, event.properties.sessionID, event.properties.id)) return
    notify(event.properties.sessionID, "Question needs input", "question")
  })

  api.event.on("question.replied", (event: EventQuestionReplied) => {
    clearPending(questions, event.properties.sessionID, event.properties.requestID)
  })

  api.event.on("question.rejected", (event: EventQuestionRejected) => {
    clearPending(questions, event.properties.sessionID, event.properties.requestID)
  })

  api.event.on("permission.asked", (event: EventPermissionAsked) => {
    if (!rememberPending(permissions, event.properties.sessionID, event.properties.id)) return

    if (isDangerousPermission(event.properties)) {
      notify(event.properties.sessionID, "Dangerous command needs input", "error")
      return
    }

    notify(event.properties.sessionID, "Permission needs input", "permission")
  })

  api.event.on("permission.replied", (event: EventPermissionReplied) => {
    clearPending(permissions, event.properties.sessionID, event.properties.requestID)
  })

  api.event.on("message.part.updated", (event: EventMessagePartUpdated) => {
    const state = cycles.get(event.properties.sessionID)
    if (!state) return

    const { part } = event.properties
    if (part.type === "patch") state.hadEdit = true
    if (part.type === "tool") {
      state.hadTool = true
      if (EDITING_TOOLS.has(part.tool)) state.hadEdit = true
    }
    if (part.type === "subtask") state.hadSubtask = true
  })

  api.event.on("session.error", (event: EventSessionError) => {
    const sessionID = event.properties.sessionID
    if (!sessionID) return

    const state = cycles.get(sessionID)
    if (!state) return

    state.hadError = true
    notify(sessionID, sessionErrorMessage(event.properties.error), "error")
  })

  api.event.on("session.status", (event: EventSessionStatus) => {
    const sessionID = event.properties.sessionID
    const { status } = event.properties

    if (status.type === "busy" || status.type === "retry") {
      const state = beginCycle(sessionID)
      if (status.type === "retry") state.retried = true
      return
    }

    if (status.type !== "idle") return
    if (hasPending(questions, permissions, sessionID)) return

    const state = cycles.get(sessionID)
    if (!state) return
    cycles.delete(sessionID)

    if (!state.hadEdit && state.baselineDiff !== diffFingerprint(api, sessionID)) {
      state.hadEdit = true
    }

    if (state.hadError) return

    const result = completion({
      subagent: getSession(sessionID)?.parentID !== undefined,
      state,
    })

    notify(sessionID, result.message, result.sound)
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: pluginID,
  tui,
}

export default plugin
