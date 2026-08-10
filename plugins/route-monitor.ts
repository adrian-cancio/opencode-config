import { appendFile, mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Config, Plugin, PluginModule } from "@opencode-ai/plugin"

const pluginID = "local.route-monitor"

const CONFIG_DIR = process.env.OPENCODE_CONFIG_DIR || path.join(os.homedir(), ".config", "opencode")
const LOG_DIR = path.join(CONFIG_DIR, "logs")
const LOG_FILE = path.join(LOG_DIR, "route.jsonl")

const PROVIDER_ID = "omniroute"

type RouteInfo = {
  time: string
  model: string | null
  provider: string | null
  decision: string | null
  latencyMs: number | null
  cost: number | null
  tokensIn: number | null
  tokensOut: number | null
  cacheHit: string | null
  requestId: string | null
}

let lastModel: string | null = null

function num(value: string | null) {
  if (!value) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function readRoute(headers: Headers): RouteInfo {
  const get = (key: string) => headers.get(key)

  return {
    time: new Date().toISOString(),
    model: get("x-omniroute-model"),
    provider: get("x-omniroute-provider"),
    decision: get("x-omniroute-decision"),
    latencyMs: num(get("x-omniroute-latency-ms")),
    cost: num(get("x-omniroute-response-cost")),
    tokensIn: num(get("x-omniroute-tokens-in")),
    tokensOut: num(get("x-omniroute-tokens-out")),
    cacheHit: get("x-omniroute-cache-hit"),
    requestId: get("x-omniroute-request-id") ?? get("x-request-id") ?? get("x-correlation-id"),
  }
}

async function log(route: RouteInfo) {
  try {
    await mkdir(LOG_DIR, { recursive: true })
    await appendFile(LOG_FILE, `${JSON.stringify(route)}\n`, "utf8")
  } catch {}
}

function applyTrailer(route: RouteInfo, key: string, value: string) {
  switch (key) {
    case "x-omniroute-model":
      route.model = value
      break
    case "x-omniroute-provider":
      route.provider = value
      break
    case "x-omniroute-decision":
      route.decision = value
      break
    case "x-omniroute-latency-ms":
      route.latencyMs = num(value)
      break
    case "x-omniroute-response-cost":
      route.cost = num(value)
      break
    case "x-omniroute-tokens-in":
      route.tokensIn = num(value)
      break
    case "x-omniroute-tokens-out":
      route.tokensOut = num(value)
      break
    case "x-omniroute-cache-hit":
      route.cacheHit = value
      break
    case "x-omniroute-request-id":
      route.requestId = value
      break
  }
}

async function drainTrailers(stream: ReadableStream<Uint8Array>, route: RouteInfo, done: (route: RouteInfo) => void) {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let buffer = ""
  let found = false

  try {
    while (true) {
      const { done: finished, value } = await reader.read()
      if (finished) break

      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""

      for (const line of lines) {
        if (!line.startsWith(":")) continue

        const separator = line.indexOf("=")
        if (separator === -1) continue

        const key = line.slice(1, separator).trim().toLowerCase()
        if (!key.startsWith("x-omniroute-")) continue

        applyTrailer(route, key, line.slice(separator + 1).trim())
        found = true
      }
    }
  } catch {
  } finally {
    reader.releaseLock()
  }

  if (found) done(route)
}

const routeMonitor: Plugin = async ({ client }) => {
  const notify = async (route: RouteInfo) => {
    const from = lastModel
    lastModel = route.model

    if (!route.model || from === route.model) return

    const where = route.provider ? ` via ${route.provider}` : ""
    const first = !from

    try {
      await client.tui.showToast({
        body: {
          title: "OmniRoute",
          message: first ? `${route.model}${where}` : `${from} -> ${route.model}${where}`,
          variant: first ? "info" : "warning",
          duration: first ? 3000 : 4000,
        },
      })
    } catch {}
  }

  const instrumented: typeof fetch = async (input, init) => {
    const response = await fetch(input as any, init as any)

    const route = readRoute(response.headers)

    const complete = (final: RouteInfo) => {
      void log(final)
      void notify(final)
    }

    const isStream = response.headers.get("content-type")?.includes("text/event-stream")

    if (isStream && response.body) {
      const [forOpencode, forMonitor] = response.body.tee()

      void drainTrailers(forMonitor, route, complete)

      return new Response(forOpencode, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    }

    if (route.model || route.provider) complete(route)

    return response
  }

  return {
    config: async (cfg: Config) => {
      const provider = cfg.provider?.[PROVIDER_ID]
      if (!provider) return

      provider.options = { ...provider.options, fetch: instrumented }
    },
  }
}

const plugin: PluginModule & { id: string } = {
  id: pluginID,
  server: routeMonitor,
}

export default plugin
