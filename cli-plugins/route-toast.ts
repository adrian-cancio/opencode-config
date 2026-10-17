import { Plugin } from "@opencode/plugin/tui"
import { RouteMonitorRpc } from "../plugins/route-monitor/rpc.js"

const TOAST_DURATION_MS = { info: 3000, warning: 4000 } as const

// Renders the toast events published by plugins/route-monitor, because the V2
// server plugin has no way to show UI by itself.
export default Plugin.define({
  id: "local.route-toast",
  setup(context) {
    const monitor = context.client.rpc(RouteMonitorRpc)

    return monitor.events.on("toast", (event) => {
      const data = event.data as { message?: unknown; variant?: unknown }
      if (typeof data.message !== "string") return

      const variant = data.variant === "warning" ? "warning" : "info"

      context.ui.toast.show({
        title: "OmniRoute",
        message: data.message,
        variant,
        duration: TOAST_DURATION_MS[variant],
      })
    })
  },
})
