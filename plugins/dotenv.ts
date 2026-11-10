import { readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Plugin } from "@opencode/plugin"
import { Provider } from "@opencode/schema/provider"

const CONFIG_DIR = process.env.OPENCODE_CONFIG_DIR || path.join(os.homedir(), ".config", "opencode")
const ENV_FILE = path.join(CONFIG_DIR, ".env")

function stripWrappingQuotes(value: string) {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1)
    }
  }

  return value
}

function loadDotEnv(filePath: string) {
  const result: Record<string, string> = {}

  let content: string
  try {
    content = readFileSync(filePath, "utf8")
  } catch {
    return result
  }

  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue

    const separatorIndex = line.indexOf("=")
    if (separatorIndex === -1) continue

    const key = line.slice(0, separatorIndex).trim()
    const value = stripWrappingQuotes(line.slice(separatorIndex + 1).trim())
    if (key) result[key] = value
  }

  return result
}

// V2 resolves `{env:VAR}` placeholders before plugins run, so the values from
// `.env` are applied through domain transforms instead of a config hook.
export default Plugin.define({
  id: "local.dotenv",
  async setup(ctx) {
    const env = loadDotEnv(ENV_FILE)

    for (const [key, value] of Object.entries(env)) {
      if (value && process.env[key] === undefined) {
        process.env[key] = value
      }
    }

    const baseURL = process.env.OMNIROUTE_BASE_URL || env.OMNIROUTE_BASE_URL
    const apiKey = process.env.OMNIROUTE_API_KEY || env.OMNIROUTE_API_KEY

    if (baseURL || apiKey) {
      const settings = {
        ...(baseURL ? { baseURL } : {}),
        ...(apiKey ? { apiKey } : {}),
      }

      await ctx.provider.transform((editor) => {
        if (editor.get("omniroute")) {
          editor.update("omniroute", (provider) => {
            provider.settings = { ...provider.settings, ...settings }
          })
          return
        }

        // Config-defined providers are not yet visible in this editor.
        editor.add({
          info: { ...Provider.Info.empty(Provider.ID.make("omniroute")), settings },
          models: [],
        })
      })
    }

    const cliproxyBaseURL = process.env.CLIPROXY_BASE_URL || env.CLIPROXY_BASE_URL
    const cliproxyApiKey = process.env.CLIPROXY_API_KEY || env.CLIPROXY_API_KEY

    if (cliproxyBaseURL || cliproxyApiKey) {
      const cliproxySettings = {
        ...(cliproxyBaseURL ? { baseURL: cliproxyBaseURL } : {}),
        ...(cliproxyApiKey ? { apiKey: cliproxyApiKey } : {}),
      }

      await ctx.provider.transform((editor) => {
        if (editor.get("cliproxy")) {
          editor.update("cliproxy", (provider) => {
            provider.settings = { ...provider.settings, ...cliproxySettings }
          })
          return
        }

        editor.add({
          info: { ...Provider.Info.empty(Provider.ID.make("cliproxy")), settings: cliproxySettings },
          models: [],
        })
      })
    }

    await ctx.mcp.transform((editor) => {
      if (!editor.get("omnicode")) return
      if (!env.OMNIROUTE_MCP_URL) return

      editor.update("omnicode", (server) => {
        if (server.type !== "remote") return
        server.url = env.OMNIROUTE_MCP_URL
        if (env.OMNIROUTE_MCP_TOKEN) {
          server.headers = { ...server.headers, Authorization: `Bearer ${env.OMNIROUTE_MCP_TOKEN}` }
        }
      })
    })
  },
})
