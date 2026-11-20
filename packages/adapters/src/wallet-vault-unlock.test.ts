import { describe, expect, it, vi } from "vitest";
import { WalletVaultClientError } from "./wallet-vault-client.js";
import { WALLET_VAULT_GRANT_TTL_MS } from "./wallet-vault-service.js";
import {
  authorizeWalletRunOperation,
  WalletRunAuthorizationError,
  walletVaultUnlockStatus,
} from "./wallet-vault-unlock.js";

// Dummy values for tests only; they guard nothing.
const PASSWORD = "test-vault-password-one";

function liveExpiry(): string {
  return new Date(Date.now() + WALLET_VAULT_GRANT_TTL_MS).toISOString();
}

/** The durable password row the settings surface reads: configured or not. */
function fakePrisma(configured: boolean) {
  return {
    walletVault: {
      findUnique: vi.fn(async () => {
        if (!configured) return null;
        return { changedAt: new Date("2026-11-14T21:01:32.000Z") };
      }),
    },
  } as unknown as Parameters<typeof walletVaultUnlockStatus>[0]["prisma"];
}

type FakeClient = Parameters<typeof walletVaultUnlockStatus>[0]["vaultClient"];

function fakeClient(status: {
  configured: boolean;
  unlocked: boolean;
  expiresAt: string | null;
  passwordEpoch: number | null;
}): FakeClient {
  return {
    status: vi.fn(async () => status),
    unlock: vi.fn(async () => ({
      grantId: "grant-test",
      expiresAt: liveExpiry(),
      passwordEpoch: 1,
    })),
    lock: vi.fn(async () => ({ locked: true as const })),
    sign: vi.fn(async () => ({
      signedTransaction: "0x02signed",
      transactionHash: "0xhash",
      from: "0x0000000000000000000000000000000000000000",
    })),
    fill: vi.fn(async () => ({ ok: true as const })),
  };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(WalletRunAuthorizationError);
  return (error as WalletRunAuthorizationError).code;
}

describe("walletVaultUnlockStatus", () => {
  it("reports the live grant when the vault answers", async () => {
    const expiresAt = liveExpiry();
    const status = await walletVaultUnlockStatus({
      prisma: fakePrisma(true),
      vaultClient: fakeClient({ configured: true, unlocked: true, expiresAt, passwordEpoch: 2 }),
      userId: "u1",
    });
    expect(status).toEqual({
      configured: true,
      changedAt: "2026-11-14T21:01:32.000Z",
      unlocked: true,
      expiresAt,
      passwordEpoch: 2,
      vaultAvailable: true,
    });
  });

  it("reads locked when the vault has no live grant", async () => {
    const status = await walletVaultUnlockStatus({
      prisma: fakePrisma(true),
      vaultClient: fakeClient({
        configured: true,
        unlocked: false,
        expiresAt: null,
        passwordEpoch: 2,
      }),
      userId: "u1",
    });
    expect(status).toMatchObject({ configured: true, unlocked: false, vaultAvailable: true });
  });

  it("fails closed as locked and unavailable when there is no vault client", async () => {
    const status = await walletVaultUnlockStatus({
      prisma: fakePrisma(true),
      vaultClient: null,
      userId: "u1",
    });
    expect(status).toEqual({
      configured: true,
      changedAt: "2026-11-14T21:01:32.000Z",
      unlocked: false,
      expiresAt: null,
      passwordEpoch: null,
      vaultAvailable: false,
    });
  });

  it("fails closed as locked and unavailable when the vault does not answer", async () => {
    const client = fakeClient({
      configured: true,
      unlocked: true,
      expiresAt: liveExpiry(),
      passwordEpoch: 2,
    });
    vi.mocked(client!.status).mockRejectedValueOnce(
      new WalletVaultClientError("vault_unavailable"),
    );
    const status = await walletVaultUnlockStatus({
      prisma: fakePrisma(true),
      vaultClient: client,
      userId: "u1",
    });
    expect(status).toMatchObject({ unlocked: false, vaultAvailable: false });
  });

  it("never carries the password in any status it returns", async () => {
    const status = await walletVaultUnlockStatus({
      prisma: fakePrisma(true),
      vaultClient: fakeClient({
        configured: true,
        unlocked: true,
        expiresAt: liveExpiry(),
        passwordEpoch: 1,
      }),
      userId: "u1",
    });
    expect(JSON.stringify(status)).not.toContain(PASSWORD);
  });
});

describe("authorizeWalletRunOperation", () => {
  const unlocked = () =>
    fakeClient({ configured: true, unlocked: true, expiresAt: liveExpiry(), passwordEpoch: 1 });

  it("allows an owner-started run while the vault is unlocked, with the grant expiry", async () => {
    const expiresAt = liveExpiry();
    const client = fakeClient({ configured: true, unlocked: true, expiresAt, passwordEpoch: 1 });
    const allowed = await authorizeWalletRunOperation({
      userId: "u1",
      run: { trigger: "user", followUpFromUser: false },
      operation: "sign",
      vaultClient: client,
    });
    expect(allowed).toEqual({ expiresAt });
  });

  it("allows an owner follow-up, which is how the owner keeps a run going", async () => {
    const allowed = await authorizeWalletRunOperation({
      userId: "u1",
      run: { trigger: "follow_up", followUpFromUser: true },
      operation: "fill",
      vaultClient: unlocked(),
    });
    expect(allowed.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("refuses a routine run even while the vault is unlocked", async () => {
    await expect(
      codeOf(
        authorizeWalletRunOperation({
          userId: "u1",
          run: { trigger: "routine", followUpFromUser: false },
          operation: "sign",
          vaultClient: unlocked(),
        }),
      ),
    ).resolves.toBe("run_not_owner_started");
  });

  it("refuses webhook, bot, and bot-follow-up runs even while unlocked", async () => {
    for (const run of [
      { trigger: "webhook", followUpFromUser: false },
      { trigger: "spawn", followUpFromUser: false },
      { trigger: "follow_up", followUpFromUser: false },
    ]) {
      await expect(
        codeOf(
          authorizeWalletRunOperation({
            userId: "u1",
            run,
            operation: "sign",
            vaultClient: unlocked(),
          }),
        ),
      ).resolves.toBe("run_not_owner_started");
    }
  });

  it("refuses an owner-started run while the vault is locked", async () => {
    await expect(
      codeOf(
        authorizeWalletRunOperation({
          userId: "u1",
          run: { trigger: "user", followUpFromUser: false },
          operation: "sign",
          vaultClient: fakeClient({
            configured: true,
            unlocked: false,
            expiresAt: null,
            passwordEpoch: 1,
          }),
        }),
      ),
    ).resolves.toBe("vault_locked");
  });

  it("refuses an owner-started run before any wallet password is set", async () => {
    await expect(
      codeOf(
        authorizeWalletRunOperation({
          userId: "u1",
          run: { trigger: "user", followUpFromUser: false },
          operation: "sign",
          vaultClient: fakeClient({
            configured: false,
            unlocked: false,
            expiresAt: null,
            passwordEpoch: null,
          }),
        }),
      ),
    ).resolves.toBe("vault_not_configured");
  });

  it("fails closed when there is no vault client, or the vault does not answer", async () => {
    await expect(
      codeOf(
        authorizeWalletRunOperation({
          userId: "u1",
          run: { trigger: "user", followUpFromUser: false },
          operation: "sign",
          vaultClient: null,
        }),
      ),
    ).resolves.toBe("vault_unavailable");
    const client = unlocked();
    vi.mocked(client!.status).mockRejectedValueOnce(
      new WalletVaultClientError("vault_unavailable"),
    );
    await expect(
      codeOf(
        authorizeWalletRunOperation({
          userId: "u1",
          run: { trigger: "user", followUpFromUser: false },
          operation: "sign",
          vaultClient: client,
        }),
      ),
    ).resolves.toBe("vault_unavailable");
  });

  it("refuses an operation class the grant does not cover", async () => {
    await expect(
      codeOf(
        authorizeWalletRunOperation({
          userId: "u1",
          run: { trigger: "user", followUpFromUser: false },
          // No such operation: the type keeps callers honest, the runtime keeps them safe.
          operation: "mint" as never,
          vaultClient: unlocked(),
        }),
      ),
    ).resolves.toBe("operation_not_allowed");
  });
});
