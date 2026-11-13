import type { ToolHandlers } from "./run-tool-gate.js";

/**
 * Host tools: what a bot may do to the machine the deployment runs on. The
 * gate asks the owner every time before this runs (see action-approval), so a
 * call here has already been approved by a person.
 */
export const hostTools: ToolHandlers = {
  async restart_host(ctx, call) {
    const restarter = ctx.providers.hostRestart;
    if (!restarter) return call.finish({ error: "Host restart is unavailable." });
    await restarter.restart();
    return call.finish({
      restarted: true,
      note: "The restart is initiated. This deployment's host is going down and will be unreachable until it boots again.",
    });
  },
};
