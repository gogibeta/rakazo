import { describe, expect, it, vi } from "vitest";
import {
  createWalletVaultClient,
  vaultClientFromEnv,
  WalletVaultClientError,
} from "./wallet-vault-client.js";

// Dummy values for tests only; they guard nothing.
const TOKEN = "test-vault-service-token-with-32-chars";
const PASSWORD = "test-vault-password-one";

type FetchCall = { url: string; init: RequestInit };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeFetch(handler: (url: string, init: RequestInit) => Promise<Response>) {
  const calls: FetchCall[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return handler(call.url, call.init);
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function client(
  handler: (url: string, init: RequestInit) => Promise<Response>,
  timeoutMs = 10_000,
) {
  const fake = fakeFetch(handler);
  return {
    ...fake,
    vault: createWalletVaultClient({
      baseUrl: "http://vault:7092/",
      token: TOKEN,
      fetch: fake.impl,
      timeoutMs,
    }),
  };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(WalletVaultClientError);
  return (error as WalletVaultClientError).code;
}

describe("wallet vault client", () => {
  it("sends the service token and rebuilds the status from the vault's fields", async () => {
    const { vault, calls } = client(async () =>
      jsonResponse(200, {
        configured: true,
        unlocked: true,
        expiresAt: "2026-09-01T06:00:00.000Z",
        passwordEpoch: 3,
        // Extra fields the vault did not mean for callers never cross.
        passwordMaterial: "must-not-cross",
      }),
    );
    expect(await vault.status("u1")).toEqual({
      configured: true,
      unlocked: true,
      expiresAt: "2026-09-01T06:00:00.000Z",
      passwordEpoch: 3,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://vault:7092/v1/status");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ userId: "u1" });
  });

  it("passes an unlock through and returns only the grant handle and expiry", async () => {
    const { vault, calls } = client(async () =>
      jsonResponse(200, {
        grantId: "grant-1",
        expiresAt: "2026-09-01T06:00:00.000Z",
        passwordEpoch: 1,
      }),
    );
    expect(await vault.unlock("u1", PASSWORD)).toEqual({
      grantId: "grant-1",
      expiresAt: "2026-09-01T06:00:00.000Z",
      passwordEpoch: 1,
    });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ userId: "u1", password: PASSWORD });
  });

  it("maps the vault's typed errors and never echoes the password", async () => {
    const { vault } = client(async () =>
      jsonResponse(401, {
        code: "password_rejected",
        message: "The wallet password could not be verified.",
      }),
    );
    const error = await vault.unlock("u1", PASSWORD).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WalletVaultClientError);
    expect((error as WalletVaultClientError).code).toBe("password_rejected");
    expect((error as Error).message).not.toContain(PASSWORD);
  });

  it("maps a refused operation's code through", async () => {
    const { vault } = client(async () => jsonResponse(409, { code: "wallet_not_migrated" }));
    expect(await codeOf(vault.sign({ userId: "u1", grantId: "g", walletId: "w1" }))).toBe(
      "wallet_not_migrated",
    );
  });

  it("treats unknown codes, off-shape successes, and non-JSON answers as unavailable", async () => {
    const unknown = client(async () => jsonResponse(500, { code: "something_new" }));
    expect(await codeOf(unknown.vault.status("u1"))).toBe("vault_unavailable");

    const offShape = client(async () => jsonResponse(200, { configured: "yes" }));
    expect(await codeOf(offShape.vault.status("u1"))).toBe("vault_unavailable");

    const notJson = client(async () => new Response("not json", { status: 200 }));
    expect(await codeOf(notJson.vault.status("u1"))).toBe("vault_unavailable");
  });

  it("fails closed when the vault cannot be reached, in a single attempt", async () => {
    const { vault, calls } = client(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    expect(await codeOf(vault.status("u1"))).toBe("vault_unavailable");
    expect(calls).toHaveLength(1);
  });

  it("fails closed when the vault does not answer in time", async () => {
    const { vault } = client(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
      20,
    );
    expect(await codeOf(vault.lock("u1"))).toBe("vault_unavailable");
  });
});

describe("vaultClientFromEnv", () => {
  it("is null without a vault address", () => {
    expect(vaultClientFromEnv({ NODE_ENV: "production" })).toBeNull();
  });

  it("is null when the vault credential cannot be resolved", () => {
    expect(
      vaultClientFromEnv({ NODE_ENV: "production", VAULT_URL: "http://vault:7092" }),
    ).toBeNull();
    expect(
      vaultClientFromEnv({
        NODE_ENV: "production",
        VAULT_URL: "http://vault:7092",
        VAULT_SERVICE_TOKEN: "shared-with-auth",
        BETTER_AUTH_SECRET: "shared-with-auth",
      }),
    ).toBeNull();
  });

  it("builds a client from the address and the dedicated credential", () => {
    expect(
      vaultClientFromEnv({
        NODE_ENV: "production",
        VAULT_URL: "http://vault:7092",
        VAULT_SERVICE_TOKEN: TOKEN,
      }),
    ).not.toBeNull();
  });
});
