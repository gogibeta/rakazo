import {
  WalletVaultNotConfiguredError,
  WalletVaultPasswordError,
} from "@rakazo/adapters/wallet-vault";
import type { WalletVaultStore } from "@rakazo/adapters/wallet-vault-service";
import { createWalletVaultService } from "@rakazo/adapters/wallet-vault-service";
import { describe, expect, it, vi } from "vitest";
import { createVaultApp } from "./app.js";

// Dummy values for tests only; they guard nothing.
const TOKEN = "test-vault-service-token-with-32-chars";
const PASSWORD = "test-vault-password-one";
const WRONG = "test-vault-password-wrong";

function stubStore(): WalletVaultStore {
  const state = { configured: true, passwordEpoch: 1 };
  return {
    vaultState: vi.fn(async () => ({
      configured: state.configured,
      passwordEpoch: state.configured ? state.passwordEpoch : null,
    })),
    verifyPassword: vi.fn(async (_userId: string, password: string) => {
      if (!state.configured) throw new WalletVaultNotConfiguredError();
      if (password !== PASSWORD) throw new WalletVaultPasswordError();
      return { passwordEpoch: state.passwordEpoch };
    }),
    walletMigrationStatus: vi.fn(async () => "legacy_server_only"),
    recordUnlock: vi.fn(async () => undefined),
    recordLock: vi.fn(async () => undefined),
  };
}

function vaultApp() {
  return createVaultApp({
    service: createWalletVaultService({ store: stubStore() }),
    serviceToken: TOKEN,
  });
}

/** A response body as loose JSON: the tests assert its exact shape. */
async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function call(
  app: ReturnType<typeof vaultApp>,
  path: string,
  body: unknown,
  token: string | null = TOKEN,
) {
  return app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
}

describe("vault service HTTP surface", () => {
  it("answers health without a credential", async () => {
    const response = await vaultApp().request("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("refuses calls without the service credential, and with the wrong one", async () => {
    const app = vaultApp();
    const missing = await call(app, "/v1/status", { userId: "u1" }, null);
    expect(missing.status).toBe(401);
    expect((await bodyOf(missing)).code).toBe("unauthorized");
    const wrong = await call(app, "/v1/status", { userId: "u1" }, "not-the-vault-token");
    expect(wrong.status).toBe(401);
  });

  it("serves status, unlock, and lock as structured results", async () => {
    const app = vaultApp();
    const status = await call(app, "/v1/status", { userId: "u1" });
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({
      configured: true,
      unlocked: false,
      expiresAt: null,
      passwordEpoch: 1,
    });

    const unlock = await call(app, "/v1/unlock", { userId: "u1", password: PASSWORD });
    expect(unlock.status).toBe(200);
    const granted = await bodyOf(unlock);
    expect(granted.grantId).toBeTypeOf("string");
    expect(granted.passwordEpoch).toBe(1);
    expect(JSON.stringify(granted)).not.toContain(PASSWORD);

    const lock = await call(app, "/v1/lock", { userId: "u1" });
    expect(lock.status).toBe(200);
    expect(await lock.json()).toEqual({ locked: true });
  });

  it("answers a wrong password with the generic rejection and never echoes it", async () => {
    const app = vaultApp();
    const response = await call(app, "/v1/unlock", { userId: "u1", password: WRONG });
    expect(response.status).toBe(401);
    const body = await response.text();
    expect((JSON.parse(body) as { code?: unknown }).code).toBe("password_rejected");
    expect(body).not.toContain(WRONG);
  });

  it("validates grants before wallets: locked first, then the typed refusal", async () => {
    const app = vaultApp();
    const locked = await call(app, "/v1/sign", { userId: "u1", grantId: "g", walletId: "w1" });
    expect(locked.status).toBe(403);
    expect((await bodyOf(locked)).code).toBe("vault_locked");

    const unlock = await call(app, "/v1/unlock", { userId: "u1", password: PASSWORD });
    const { grantId } = await bodyOf(unlock);
    const sign = await call(app, "/v1/sign", { userId: "u1", grantId, walletId: "w1" });
    expect(sign.status).toBe(409);
    expect((await bodyOf(sign)).code).toBe("wallet_not_migrated");
  });

  it("refuses malformed bodies without reading further", async () => {
    const app = vaultApp();
    const response = await call(app, "/v1/unlock", { userId: "u1" });
    expect(response.status).toBe(400);
    expect((await bodyOf(response)).code).toBe("invalid_request");
  });
});
