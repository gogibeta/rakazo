import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createWalletVaultService } from "@rakazo/adapters/wallet-vault-service";
import { createDb } from "@rakazo/db";
import { SERVICE_NAMES } from "@rakazo/logging";
import { createRootLogger } from "@rakazo/logging/axiom";
import { createVaultApp } from "./app.js";
import { resolveVaultEnv } from "./env.js";
import { createPrismaVaultStore } from "./store.js";

/**
 * The wallet vault service: the one process that holds owners' wallet
 * password material. It starts locked — grants exist only in its memory,
 * minted by an unlock and ended by lock, expiry, a password change, or
 * this process stopping — and it publishes no port: the API and worker
 * reach it on the internal network with the deployment's vault credential.
 */
async function startVault() {
  const logger = await createRootLogger(SERVICE_NAMES.vault);
  const env = resolveVaultEnv();
  const { prisma, pool } = createDb(env.databaseUrl, { applicationName: SERVICE_NAMES.vault });
  const service = createWalletVaultService({ store: createPrismaVaultStore(prisma) });
  const app = createVaultApp({
    service,
    serviceToken: env.serviceToken,
    onError: (error) => logger.error("vault request failed", error),
  });
  const server = serve({ fetch: app.fetch, hostname: env.host, port: env.port }, () => {
    logger.info("vault listening", { "http.host": env.host, "http.port": env.port });
  });
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    // Grants end with the process either way; wipe them explicitly first.
    service.lockAll();
    await closeListeningServer(server);
    await pool.end().catch(() => undefined);
    await logger.flush({ timeoutMs: 2_000 });
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
  return server;
}

function closeListeningServer(server: {
  close(callback?: (err?: Error) => void): void;
  closeIdleConnections?: () => void;
}): Promise<void> {
  server.closeIdleConnections?.();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  // A rejected startup keeps Node's default: the error is printed and the process exits.
  void startVault();
}
