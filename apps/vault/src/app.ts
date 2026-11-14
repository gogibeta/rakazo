import type { WalletVaultService } from "@rakazo/adapters/wallet-vault-service";
import { WalletVaultServiceError } from "@rakazo/adapters/wallet-vault-service";
import { hasValidBearerToken } from "@rakazo/core";
import { Hono } from "hono";
import { z } from "zod";

/**
 * The vault's internal HTTP surface. Only the API and worker call it, over
 * the deployment's internal network, with the dedicated vault credential
 * as a bearer token; there is no other authentication and no public route
 * but the health check. Responses are the vault core's structured results
 * verbatim — the core decides what may cross, and nothing here adds to it.
 * Request bodies are never logged, here or anywhere downstream: an unlock
 * body carries the owner's wallet password.
 */

const userId = z.string().min(1).max(128);
const grantId = z.string().min(1).max(128);

const statusBody = z.object({ userId });
const unlockBody = z.object({ userId, password: z.string().min(1).max(1024) });
const lockBody = z.object({ userId });
const signBody = z.object({ userId, grantId, walletId: z.string().min(1).max(128) });
const fillBody = z.object({
  userId,
  grantId,
  walletId: z.string().min(1).max(128),
  site: z.string().min(1).max(2048),
});

/** The HTTP status each vault failure maps to. Bodies carry the code only. */
const ERROR_STATUS: Record<string, number> = {
  not_configured: 409,
  password_rejected: 401,
  vault_locked: 403,
  grant_expired: 403,
  grant_mismatch: 403,
  epoch_mismatch: 403,
  operation_not_allowed: 403,
  wallet_not_found: 404,
  wallet_not_migrated: 409,
  signing_not_enabled: 409,
  fill_not_enabled: 409,
};

export function createVaultApp(deps: {
  service: WalletVaultService;
  serviceToken: string;
  onError?: (error: unknown) => void;
}): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

  app.use("/v1/*", async (c, next) => {
    if (!hasValidBearerToken(c.req.header("authorization"), deps.serviceToken)) {
      return c.json(
        { code: "unauthorized", message: "The vault refused the service credential." },
        401,
      );
    }
    return next();
  });

  async function body<T>(c: { req: { json: () => Promise<unknown> } }, schema: z.ZodType<T>) {
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    return parsed.success ? parsed.data : null;
  }

  const invalid = (c: { json: (body: unknown, status: 400) => Response }) =>
    c.json({ code: "invalid_request", message: "The vault refused the request." }, 400);

  app.post("/v1/status", async (c) => {
    const input = await body(c, statusBody);
    if (!input) return invalid(c);
    return c.json(await deps.service.status(input.userId));
  });

  app.post("/v1/unlock", async (c) => {
    const input = await body(c, unlockBody);
    if (!input) return invalid(c);
    return c.json(await deps.service.unlock(input.userId, input.password));
  });

  app.post("/v1/lock", async (c) => {
    const input = await body(c, lockBody);
    if (!input) return invalid(c);
    return c.json(await deps.service.lock(input.userId));
  });

  app.post("/v1/sign", async (c) => {
    const input = await body(c, signBody);
    if (!input) return invalid(c);
    return c.json(await deps.service.sign(input));
  });

  app.post("/v1/fill", async (c) => {
    const input = await body(c, fillBody);
    if (!input) return invalid(c);
    return c.json(await deps.service.fill(input));
  });

  app.onError((error, c) => {
    if (error instanceof WalletVaultServiceError) {
      return c.json(
        { code: error.code, message: error.message },
        (ERROR_STATUS[error.code] ?? 500) as never,
      );
    }
    deps.onError?.(error);
    return c.json(
      { code: "internal_error", message: "The vault could not complete the request." },
      500,
    );
  });

  return app;
}
