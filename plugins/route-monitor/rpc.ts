import { Rpc } from "@opencode/plugin/rpc"

// The V2 server cannot show toasts itself, so the server plugin publishes this
// event and the CLI plugin in cli-plugins/route-toast.ts renders it.
export const RouteMonitorRpc = Rpc.define({
  id: "route-monitor",
  methods: {},
  events: {
    toast: {
      schema: {
        type: "object",
        properties: {
          message: { type: "string" },
          variant: { type: "string", enum: ["info", "warning"] },
        },
        required: ["message", "variant"],
        additionalProperties: false,
      },
    },
  },
})
