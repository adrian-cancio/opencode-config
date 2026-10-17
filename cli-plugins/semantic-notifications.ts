import { Plugin } from "@opencode/plugin/tui"

const SUBAGENT_DONE_SOUND_ENABLED = process.env["OPENCODE_SUBAGENT_DONE_SOUND"] === "1"

type SoundName = "default" | "question" | "permission" | "error" | "done" | "subagent_done"

const DANGEROUS_SHELL_PATTERNS = [
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

const SUBAGENT_TOOLS = new Set<string>(["task", "subagent"])

type CycleState = {
  startedAt: number
  hadError: boolean
  retried: boolean
}

type Summary = {
  hadEdit: boolean
  hadTool: boolean
  hadSubtask: boolean
}

function isDangerousPermission(action: string, resources: readonly string[]) {
  if (action !== "shell") return false
  const text = resources.join("\n")
  return DANGEROUS_SHELL_PATTERNS.some((pattern) => pattern.test(text))
}

function failureMessage(error: { type?: string; message?: string; status?: number }) {
  if (error.message === "SSE read timed out") return "Model stopped responding"
  if (error.status !== undefined) return "Model request failed"
  return "Session error"
}

function completion(input: { subagent: boolean; retried: boolean; summary: Summary }) {
  const { subagent, retried, summary } = input

  if (subagent) {
    if (summary.hadEdit) {
      return {
        message: retried ? "Subagent changes ready after retry" : "Subagent changes ready",
        sound: "subagent_done" as const,
      }
    }

    return {
      message: retried ? "Subagent done after retry" : "Subagent done",
      sound: "subagent_done" as const,
    }
  }

  if (summary.hadEdit) {
    return {
      message: retried ? "Code changes ready after retry" : "Code changes ready",
      sound: "done" as const,
    }
  }

  if (summary.hadSubtask) {
    return {
      message: retried ? "Delegated task done after retry" : "Delegated task done",
      sound: "default" as const,
    }
  }

  if (summary.hadTool) {
    return {
      message: retried ? "Tool work done after retry" : "Tool work done",
      sound: "default" as const,
    }
  }

  return {
    message: retried ? "Answer ready after retry" : "Answer ready",
    sound: "default" as const,
  }
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
  forms: Map<string, Set<string>>,
  permissions: Map<string, Set<string>>,
  sessionID: string,
) {
  return (forms.get(sessionID)?.size ?? 0) > 0 || (permissions.get(sessionID)?.size ?? 0) > 0
}

export default Plugin.define({
  id: "local.semantic-notifications",
  setup(context) {
    const cycles = new Map<string, CycleState>()
    const forms = new Map<string, Set<string>>()
    const permissions = new Map<string, Set<string>>()

    const sessionInfo = (sessionID: string | undefined) =>
      sessionID ? context.data.session.get(sessionID) : undefined

    const notify = (sessionID: string | undefined, message: string, sound: SoundName) => {
      const session = sessionInfo(sessionID)
      const isSubagent = session?.parentID !== undefined
      const soundMuted = sound === "subagent_done" && !SUBAGENT_DONE_SOUND_ENABLED

      void context.attention.notify({
        title: session?.title,
        message,
        notification: isSubagent ? false : { when: "blurred" },
        sound: soundMuted ? false : { name: sound, when: "always" },
      })
    }

    // V2 has no per-part events, so the cycle summary is read from the
    // assistant messages created since the cycle started.
    const summarize = async (sessionID: string, startedAt: number): Promise<Summary> => {
      const summary: Summary = { hadEdit: false, hadTool: false, hadSubtask: false }

      try {
        await context.data.session.message.sync(sessionID)
      } catch {
        return summary
      }

      for (const message of context.data.session.message.list(sessionID)) {
        if (message.type !== "assistant" || message.time.created < startedAt) continue

        for (const part of message.content) {
          if (part.type !== "tool") continue
          summary.hadTool = true
          if (EDITING_TOOLS.has(part.name)) summary.hadEdit = true
          if (SUBAGENT_TOOLS.has(part.name)) summary.hadSubtask = true
        }
      }

      return summary
    }

    const beginCycle = (sessionID: string) => {
      const existing = cycles.get(sessionID)
      if (existing) return existing

      const next: CycleState = { startedAt: Date.now(), hadError: false, retried: false }
      cycles.set(sessionID, next)
      return next
    }

    const stops = [
      context.data.on("form.created", (event) => {
        const { form } = event.data
        if (!rememberPending(forms, form.sessionID, form.id)) return
        notify(form.sessionID, "Question needs input", "question")
      }),

      context.data.on("form.replied", (event) => {
        clearPending(forms, event.data.sessionID, event.data.id)
      }),

      context.data.on("form.cancelled", (event) => {
        clearPending(forms, event.data.sessionID, event.data.id)
      }),

      context.data.on("permission.asked", (event) => {
        const { id, sessionID, action, resources } = event.data
        if (!rememberPending(permissions, sessionID, id)) return

        if (isDangerousPermission(action, [...resources, ...(event.data.save ?? [])])) {
          notify(sessionID, "Dangerous command needs input", "error")
          return
        }

        notify(sessionID, "Permission needs input", "permission")
      }),

      context.data.on("permission.replied", (event) => {
        clearPending(permissions, event.data.sessionID, event.data.requestID)
      }),

      context.data.on("session.execution.started", (event) => {
        beginCycle(event.data.sessionID)
      }),

      context.data.on("session.retry.scheduled", (event) => {
        beginCycle(event.data.sessionID).retried = true
      }),

      context.data.on("session.execution.failed", (event) => {
        const { sessionID, error } = event.data
        const state = cycles.get(sessionID)
        if (!state) return

        cycles.delete(sessionID)
        notify(sessionID, failureMessage(error), "error")
      }),

      context.data.on("session.execution.interrupted", (event) => {
        const { sessionID, reason } = event.data
        const state = cycles.get(sessionID)
        if (!state) return

        cycles.delete(sessionID)
        if (reason === "user") notify(sessionID, "Session aborted", "error")
      }),

      context.data.on("session.execution.succeeded", (event) => {
        const { sessionID } = event.data
        if (hasPending(forms, permissions, sessionID)) return

        const state = cycles.get(sessionID)
        if (!state) return
        cycles.delete(sessionID)

        void summarize(sessionID, state.startedAt).then((summary) => {
          const result = completion({
            subagent: sessionInfo(sessionID)?.parentID !== undefined,
            retried: state.retried,
            summary,
          })

          notify(sessionID, result.message, result.sound)
        })
      }),
    ]

    return () => {
      for (const stop of stops) stop()
    }
  },
})
