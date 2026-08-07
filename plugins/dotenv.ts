import { readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Config, Plugin, PluginModule } from "@opencode-ai/plugin"

const pluginID = "local.dotenv"

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

const dotenv: Plugin = async () => {
  const env = loadDotEnv(ENV_FILE)

  return {
    config: async (cfg: Config) => {
      for (const [key, value] of Object.entries(env)) {
        if (value && process.env[key] === undefined) {
          process.env[key] = value
        }
      }

      const omniroute = cfg.provider?.["omniroute"]
      if (omniroute) {
        if (env.OMNIROUTE_API_KEY) {
          omniroute.options = { ...omniroute.options, apiKey: env.OMNIROUTE_API_KEY }
        }
        if (env.OMNIROUTE_BASE_URL) {
          omniroute.options = { ...omniroute.options, baseURL: env.OMNIROUTE_BASE_URL }
        }
      }

      const omnicode = cfg.mcp?.["omnicode"]
      if (omnicode && "url" in omnicode && env.OMNIROUTE_MCP_URL) {
        omnicode.url = env.OMNIROUTE_MCP_URL
      }
    },
  }
}

const plugin: PluginModule & { id: string } = {
  id: pluginID,
  server: dotenv,
}

export default plugin
