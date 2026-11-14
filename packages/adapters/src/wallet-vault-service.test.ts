import { describe, expect, it, vi } from "vitest";
import { WalletVaultNotConfiguredError, WalletVaultPasswordError } from "./wallet-vault-impl.js";
import type { WalletVaultStore } from "./wallet-vault-service.js";
import {
  createWalletVaultService,
  WALLET_VAULT_GRANT_TTL_MS,
  WalletVaultServiceError,
} from "./wallet-vault-service.js";

// Dummy passwords for tests only; they guard nothing.
const PASSWORD = "test-vault-password-one";
const WRONG = "test-vault-password-wrong";
const START = new Date("2026-09-01T00:00:00.000Z");

type UnlockRow = {
  userId: string;
  grantId: string;
  passwordEpoch: number;
  issuedAt: Date;
  expiresAt: Date;
};
type LockRow = { userId: string; grantId: string; revokedAt: Date };

/** The vault's durable side in memory: password state, wallets, audit rows. */
function stubStore() {
  const state = { configured: true, passwordEpoch: 1 };
  const wallets = new Map<string, string>();
  const unlocks: UnlockRow[] = [];
  const locks: LockRow[] = [];
  const store: WalletVaultStore = {
    vaultState: vi.fn(async () => ({
      configured: state.configured,
      passwordEpoch: state.configured ? state.passwordEpoch : null,
    })),
    verifyPassword: vi.fn(async (_userId: string, password: string) => {
      if (!state.configured) throw new WalletVaultNotConfiguredError();
      if (password !== PASSWORD) throw new WalletVaultPasswordError();
      return { passwordEpoch: state.passwordEpoch };
    }),
    walletMigrationStatus: vi.fn(
      async (_userId: string, walletId: string) => wallets.get(walletId) ?? null,
    ),
    recordUnlock: vi.fn(async (input: UnlockRow) => {
      unlocks.push(input);
    }),
    recordLock: vi.fn(async (input: LockRow) => {
      locks.push(input);
    }),
  };
  return { store, state, wallets, unlocks, locks };
}

function harness() {
  const stub = stubStore();
  let clock = new Date(START);
  let counter = 0;
  const service = createWalletVaultService({
    store: stub.store,
    now: () => clock,
    newGrantId: () => `grant-${++counter}`,
  });
  return {
    ...stub,
    service,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(WalletVaultServiceError);
  return (error as WalletVaultServiceError).code;
}

describe("wallet vault service", () => {
  it("reports unconfigured and refuses unlock before a password is set", async () => {
    const h = harness();
    h.state.configured = false;
    expect(await h.service.status("u1")).toEqual({
      configured: false,
      unlocked: false,
      expiresAt: null,
      passwordEpoch: null,
    });
    expect(await codeOf(h.service.unlock("u1", PASSWORD))).toBe("not_configured");
    expect(h.unlocks).toEqual([]);
  });

  it("unlocks with the right password and audits the grant, exposing no password", async () => {
    const h = harness();
    const result = await h.service.unlock("u1", PASSWORD);
    expect(result).toEqual({
      grantId: "grant-1",
      expiresAt: new Date(START.getTime() + WALLET_VAULT_GRANT_TTL_MS).toISOString(),
      passwordEpoch: 1,
    });
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    expect(h.unlocks).toEqual([
      {
        userId: "u1",
        grantId: "grant-1",
        passwordEpoch: 1,
        issuedAt: START,
        expiresAt: new Date(START.getTime() + WALLET_VAULT_GRANT_TTL_MS),
      },
    ]);
    expect(JSON.stringify(h.unlocks)).not.toContain(PASSWORD);
    expect(await h.service.status("u1")).toEqual({
      configured: true,
      unlocked: true,
      expiresAt: result.expiresAt,
      passwordEpoch: 1,
    });
  });

  it("rejects a wrong password with the generic error and mints no grant", async () => {
    const h = harness();
    const error = await h.service.unlock("u1", WRONG).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WalletVaultServiceError);
    expect((error as WalletVaultServiceError).code).toBe("password_rejected");
    expect((error as Error).message).toBe("The wallet password could not be verified.");
    expect((error as Error).message).not.toContain(WRONG);
    expect(h.unlocks).toEqual([]);
    expect(await codeOf(h.service.sign({ userId: "u1", grantId: "grant-1", walletId: "w1" }))).toBe(
      "vault_locked",
    );
  });

  it("fails closed without a grant, with the wrong grant, and for another person", async () => {
    const h = harness();
    expect(await codeOf(h.service.sign({ userId: "u1", grantId: "grant-1", walletId: "w1" }))).toBe(
      "vault_locked",
    );
    const { grantId } = await h.service.unlock("u1", PASSWORD);
    expect(
      await codeOf(h.service.sign({ userId: "u1", grantId: "grant-999", walletId: "w1" })),
    ).toBe("grant_mismatch");
    // The grant belongs to u1: in u2's hands it is nothing at all.
    expect(await codeOf(h.service.sign({ userId: "u2", grantId, walletId: "w1" }))).toBe(
      "vault_locked",
    );
    expect(
      await codeOf(
        h.service.fill({ userId: "u2", grantId, walletId: "w1", site: "https://example.com" }),
      ),
    ).toBe("vault_locked");
  });

  it("validates the wallet after the grant, then refuses to sign or fill", async () => {
    const h = harness();
    const { grantId } = await h.service.unlock("u1", PASSWORD);
    expect(await codeOf(h.service.sign({ userId: "u1", grantId, walletId: "missing" }))).toBe(
      "wallet_not_found",
    );
    h.wallets.set("legacy", "legacy_server_only");
    expect(await codeOf(h.service.sign({ userId: "u1", grantId, walletId: "legacy" }))).toBe(
      "wallet_not_migrated",
    );
    expect(
      await codeOf(
        h.service.fill({ userId: "u1", grantId, walletId: "legacy", site: "https://example.com" }),
      ),
    ).toBe("wallet_not_migrated");
    // Even a wallet marked protected cannot sign yet: migration alone does
    // not enable signing in this step, and the refusal is typed, not faked.
    h.wallets.set("migrated", "password_protected");
    expect(await codeOf(h.service.sign({ userId: "u1", grantId, walletId: "migrated" }))).toBe(
      "signing_not_enabled",
    );
    expect(
      await codeOf(
        h.service.fill({
          userId: "u1",
          grantId,
          walletId: "migrated",
          site: "https://example.com",
        }),
      ),
    ).toBe("fill_not_enabled");
  });

  it("locks immediately, audits the lock, and stays locked", async () => {
    const h = harness();
    const { grantId } = await h.service.unlock("u1", PASSWORD);
    expect(await h.service.lock("u1")).toEqual({ locked: true });
    expect(h.locks).toEqual([{ userId: "u1", grantId, revokedAt: START }]);
    expect((await h.service.status("u1")).unlocked).toBe(false);
    expect(await codeOf(h.service.sign({ userId: "u1", grantId, walletId: "w1" }))).toBe(
      "vault_locked",
    );
    // Locking an already-locked vault is a no-op, not a second audit row.
    expect(await h.service.lock("u1")).toEqual({ locked: true });
    expect(h.locks).toHaveLength(1);
  });

  it("expires the grant at its fixed time; use does not extend it", async () => {
    const h = harness();
    const { grantId } = await h.service.unlock("u1", PASSWORD);
    h.advance(WALLET_VAULT_GRANT_TTL_MS - 60_000);
    // Still live a minute before expiry, and using it changes nothing.
    expect((await h.service.status("u1")).unlocked).toBe(true);
    h.advance(60_000);
    expect(await codeOf(h.service.sign({ userId: "u1", grantId, walletId: "w1" }))).toBe(
      "grant_expired",
    );
    expect((await h.service.status("u1")).unlocked).toBe(false);
  });

  it("revokes the grant when the password epoch moves under it", async () => {
    const h = harness();
    const { grantId } = await h.service.unlock("u1", PASSWORD);
    h.state.passwordEpoch = 2;
    expect(await codeOf(h.service.sign({ userId: "u1", grantId, walletId: "w1" }))).toBe(
      "epoch_mismatch",
    );
    expect(h.locks).toEqual([{ userId: "u1", grantId, revokedAt: START }]);
    // The grant is gone, not merely flagged: the next attempt is a plain lock.
    expect(await codeOf(h.service.sign({ userId: "u1", grantId, walletId: "w1" }))).toBe(
      "vault_locked",
    );
    expect((await h.service.status("u1")).unlocked).toBe(false);
  });

  it("a fresh vault over the same store starts locked: restart invalidates grants", async () => {
    const stub = stubStore();
    let counter = 0;
    const deps = {
      store: stub.store,
      now: () => new Date(START),
      newGrantId: () => `grant-${++counter}`,
    };
    const before = createWalletVaultService(deps);
    const { grantId } = await before.unlock("u1", PASSWORD);
    const after = createWalletVaultService(deps);
    expect((await after.status("u1")).unlocked).toBe(false);
    expect(await codeOf(after.sign({ userId: "u1", grantId, walletId: "w1" }))).toBe(
      "vault_locked",
    );
    // The audit row alone never authorizes anything.
    expect(stub.unlocks).toHaveLength(1);
  });

  it("a second unlock replaces the first grant and audits both events", async () => {
    const h = harness();
    const first = await h.service.unlock("u1", PASSWORD);
    const second = await h.service.unlock("u1", PASSWORD);
    expect(second.grantId).not.toBe(first.grantId);
    expect(h.unlocks).toHaveLength(2);
    expect(h.locks).toEqual([{ userId: "u1", grantId: first.grantId, revokedAt: START }]);
    expect(
      await codeOf(h.service.sign({ userId: "u1", grantId: first.grantId, walletId: "w1" })),
    ).toBe("grant_mismatch");
  });

  it("keeps an unlock out of the audit trail when the audit write fails", async () => {
    const h = harness();
    h.store.recordUnlock = vi.fn(async () => {
      throw new Error("audit store unavailable");
    });
    await expect(h.service.unlock("u1", PASSWORD)).rejects.toThrow("audit store unavailable");
    expect((await h.service.status("u1")).unlocked).toBe(false);
    expect(await codeOf(h.service.sign({ userId: "u1", grantId: "grant-1", walletId: "w1" }))).toBe(
      "vault_locked",
    );
  });

  it("audits the revocation when a grant expires in use", async () => {
    const h = harness();
    const { grantId } = await h.service.unlock("u1", PASSWORD);
    h.advance(WALLET_VAULT_GRANT_TTL_MS);
    expect(await codeOf(h.service.sign({ userId: "u1", grantId, walletId: "w1" }))).toBe(
      "grant_expired",
    );
    expect(h.locks).toEqual([
      { userId: "u1", grantId, revokedAt: new Date(START.getTime() + WALLET_VAULT_GRANT_TTL_MS) },
    ]);
  });

  it("audits the revocation when a status check finds the grant expired", async () => {
    const h = harness();
    const { grantId } = await h.service.unlock("u1", PASSWORD);
    h.advance(WALLET_VAULT_GRANT_TTL_MS + 1_000);
    expect((await h.service.status("u1")).unlocked).toBe(false);
    expect(h.locks).toEqual([
      {
        userId: "u1",
        grantId,
        revokedAt: new Date(START.getTime() + WALLET_VAULT_GRANT_TTL_MS + 1_000),
      },
    ]);
  });

  it("an audit failure never blocks or undoes a revocation", async () => {
    const h = harness();
    const { grantId } = await h.service.unlock("u1", PASSWORD);
    h.store.recordLock = vi.fn(async () => {
      throw new Error("audit store unavailable");
    });
    // Lock still reports locked, and the grant is gone.
    expect(await h.service.lock("u1")).toEqual({ locked: true });
    expect((await h.service.status("u1")).unlocked).toBe(false);
    // Expiry still refuses with the expiry code, not the audit error.
    const again = await h.service.unlock("u1", PASSWORD);
    h.advance(WALLET_VAULT_GRANT_TTL_MS);
    expect(
      await codeOf(h.service.sign({ userId: "u1", grantId: again.grantId, walletId: "w1" })),
    ).toBe("grant_expired");
    expect(grantId).not.toBe(again.grantId);
  });
});

describe("wallet vault unlock/lock serialization", () => {
  it("a lock issued during an in-flight unlock wins: the vault ends locked", async () => {
    const stub = stubStore();
    let releaseVerify: (() => void) | undefined;
    stub.store.verifyPassword = vi.fn(
      (_userId: string, _password: string) =>
        new Promise<{ passwordEpoch: number }>((resolve) => {
          releaseVerify = () => resolve({ passwordEpoch: 1 });
        }),
    );
    let counter = 0;
    const service = createWalletVaultService({
      store: stub.store,
      now: () => new Date(START),
      newGrantId: () => `grant-${++counter}`,
    });

    const unlocking = service.unlock("u1", PASSWORD);
    const locking = service.lock("u1");
    // Let the unlock reach its password check, then let it finish: the lock
    // was issued first in wall-clock terms but must linearize after it.
    await vi.waitFor(() => expect(releaseVerify).toBeDefined());
    releaseVerify!();
    const granted = await unlocking;
    expect(await locking).toEqual({ locked: true });

    expect((await service.status("u1")).unlocked).toBe(false);
    expect(
      await service
        .sign({ userId: "u1", grantId: granted.grantId, walletId: "w1" })
        .catch((caught: unknown) => (caught as WalletVaultServiceError).code),
    ).toBe("vault_locked");
    // Audit order matches the linearization: the unlock, then its lock.
    expect(stub.unlocks.map((row) => row.grantId)).toEqual([granted.grantId]);
    expect(stub.locks.map((row) => row.grantId)).toEqual([granted.grantId]);
  });

  it("concurrent unlocks linearize: the second replaces the first, in audit order", async () => {
    const h = harness();
    const [first, second] = await Promise.all([
      h.service.unlock("u1", PASSWORD),
      h.service.unlock("u1", PASSWORD),
    ]);
    expect(first.grantId).toBe("grant-1");
    expect(second.grantId).toBe("grant-2");
    expect(h.unlocks.map((row) => row.grantId)).toEqual(["grant-1", "grant-2"]);
    expect(h.locks.map((row) => row.grantId)).toEqual(["grant-1"]);
    expect((await h.service.status("u1")).unlocked).toBe(true);
    expect(await codeOf(h.service.sign({ userId: "u1", grantId: "grant-1", walletId: "w1" }))).toBe(
      "grant_mismatch",
    );
  });

  it("never hands back a grant that was revoked while its audit row was written", async () => {
    const stub = stubStore();
    let counter = 0;
    const service = createWalletVaultService({
      store: stub.store,
      now: () => new Date(START),
      newGrantId: () => `grant-${++counter}`,
    });
    stub.store.recordUnlock = vi.fn(async (input) => {
      stub.unlocks.push(input);
      // A shutdown lands mid-write: every grant ends.
      service.lockAll();
    });
    expect(await codeOf(service.unlock("u1", PASSWORD))).toBe("vault_locked");
    expect((await service.status("u1")).unlocked).toBe(false);
    // The termination the unlock noticed is audited like any other.
    expect(stub.locks.map((row) => row.grantId)).toEqual(["grant-1"]);
  });

  it("one person's lock does not wait on another person's unlock", async () => {
    const stub = stubStore();
    let releaseVerify: (() => void) | undefined;
    const originalVerify = stub.store.verifyPassword;
    stub.store.verifyPassword = vi.fn((userId: string, password: string) => {
      if (userId !== "u1") return originalVerify(userId, password);
      return new Promise<{ passwordEpoch: number }>((resolve) => {
        releaseVerify = () => resolve({ passwordEpoch: 1 });
      });
    });
    let counter = 0;
    const service = createWalletVaultService({
      store: stub.store,
      now: () => new Date(START),
      newGrantId: () => `grant-${++counter}`,
    });
    const unlocking = service.unlock("u1", PASSWORD);
    await vi.waitFor(() => expect(releaseVerify).toBeDefined());
    // u2's lock completes while u1's unlock is still verifying.
    expect(await service.lock("u2")).toEqual({ locked: true });
    releaseVerify!();
    await unlocking;
    expect((await service.status("u1")).unlocked).toBe(true);
  });
});
