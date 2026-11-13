import { CustomConnectionCallInput } from "@rakazo/contracts";
import { addRunSecrets } from "./run-context.js";
import type { ToolHandlers } from "./run-tool-gate.js";
import { callUserConnection } from "./user-connections.js";

/**
 * Custom connection tools: a bot calls an API service the user registered in
 * Settings. The server adds the saved key; the bot never sees it.
 */
export const connectionTools: ToolHandlers = {
  async call_connection(ctx, call) {
    const { deps, run, context } = ctx;
    const parsed = CustomConnectionCallInput.safeParse(call.args);
    if (!parsed.success) {
      return call.finish({
        error: "Invalid call: name the connection, a method, and a path relative to its base URL.",
      });
    }
    try {
      const result = await callUserConnection({
        prisma: deps.prisma,
        secretStore: deps.secretStore,
        userId: run.userId,
        name: parsed.data.connection,
        request: {
          method: parsed.data.method,
          path: parsed.data.path,
          body: parsed.data.body,
          headers: parsed.data.headers,
        },
        signal: context.signal,
        remote: deps.secretHttp,
        registerRedactions: (values) => addRunSecrets(ctx, values),
      });
      return call.finish(result);
    } catch {
      return call.finish({ error: "Invalid connection call." });
    }
  },
};
