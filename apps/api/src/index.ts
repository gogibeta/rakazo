import type { Socket } from "node:net";
import { unwrapEnvFromKeyManager } from "@rakazo/adapters";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import { stopOnShutdownSignals } from "@rakazo/core/node/shutdown-signals";

loadRootEnv();
await unwrapEnvFromKeyManager();

import { serve } from "@hono/node-server";
import { SERVICE_NAMES } from "@rakazo/logging";
import { createRootLogger } from "@rakazo/logging/axiom";
import { watchEventLoopStalls } from "@rakazo/logging/event-loop";
import { createApp } from "./app.js";
import { loadEnv } from "./env.js";
import { drainServer } from "./shutdown-drain.js";

const logger = await createRootLogger(SERVICE_NAMES.api);
const stopStallWatch = watchEventLoopStalls("api.event_loop_stalled");

try {
  const env = loadEnv();
  const { app, stop, handleUpgrade } = await createApp({ ...env, logger });
  const server = serve({ fetch: app.fetch, port: env.port, hostname: env.apiHost }, () => {
    logger.info("api listening", { "http.host": env.apiHost, "http.port": env.port });
  });
  // Desktop apps hold an outbound socket so bots can reach the user's own computer.
  if (handleUpgrade) server.on("upgrade", handleUpgrade);

  // SSE streams never end on their own, so the sockets that keep themselves open are destroyed
  // once in-flight work has drained; see drainServer.
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    stopStallWatch();
    await drainServer({
      closeServer: () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
      // The drain waits for handlers already running. Doing this before destroying sockets is
      // the difference between a deploy that lets a request finish and one that resets it.
      stopAcceptingWork: stop,
      destroySockets: () => {
        for (const socket of sockets) socket.destroy();
      },
    });
    await logger.flush({ timeoutMs: 2_000 });
  };
  stopOnShutdownSignals(shutdown);
} catch (error) {
  logger.error("api startup failed", error);
  await logger.flush({ timeoutMs: 2_000 });
  process.exit(1);
}
