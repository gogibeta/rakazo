import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it, vi } from "vitest";
import { createWalletKeyEnvelope } from "./wallet-envelope.js";
import { walletProposalCanonicalHash } from "./wallet-proposals.js";
import { WalletVaultNotConfiguredError, WalletVaultPasswordError } from "./wallet-vault-impl.js";
import type { WalletProposalForSigning, WalletVaultStore } from "./wallet-vault-service.js";
import {
  createWalletVaultService,
  WALLET_VAULT_GRANT_TTL_MS,
  WalletVaultServiceError,
} from "./wallet-vault-service.js";

// Dummy passwords and keys for tests only; they guard nothing.
const PASSWORD = "test-vault-password-one";
const WRONG = "test-vault-password-wrong";
const START = new Date("2026-09-01T00:00:00.000Z");
const PROPOSAL_TTL_MS = 15 * 60 * 1_000;

/** A fixed test private key, and the address it controls. */
const KEY = hexToBytes("22".repeat(32));
const KEY_OTHER = hexToBytes("33".repeat(32));
function addressOf(key: Uint8Array): string {
  const pub = secp256k1.getPublicKey(key, false);
  return `0x${Buffer.from(keccak_256(pub.slice(1)).slice(-20)).toString("hex")}`;
}
const FROM = addressOf(KEY);

/** Wallet ids must look like the cuids the schema mints (envelope AAD binds them). */
const WALLET_ID = "ca1a1a1a1a1a1a1a1a1a1a1a1";
const WALLET_ID_LEGACY = "cb2b2b2b2b2b2b2b2b2b2b2b2";
const WALLET_ID_U2 = "cc3c3c3c3c3c3c3c3c3c3c3c3";

/** The transaction fields a test proposal carries. */
const PROPOSAL_FIELDS = {
  chainId: 11155111,
  nonce: 3,
  to: "0x1111111111111111111111111111111111111111",
  amountWei: "1000000000000000000",
  data: null as string | null,
  gasLimit: "21000",
  maxFeePerGas: "2000000000",
  maxPriorityFeePerGas: "1000000000",
};

type UnlockRow = {
  userId: string;
  grantId: string;
  passwordEpoch: number;
  issuedAt: Date;
  expiresAt: Date;
};
type LockRow = { userId: string; grantId: string; revokedAt: Date };
type Envelope = { keyCiphertext: string; passwordWrap: string };

/** The vault's durable side in memory: password state, wallets, proposals, audit rows. */
function stubStore() {
  const state = { configured: true, passwordEpoch: 1 };
  const wallets = new Map<string, string>();
  const unlocks: UnlockRow[] = [];
  const locks: LockRow[] = [];
  // Keyed by `${userId}:${proposalId}`, like the real store's tenant scope.
  const proposals = new Map<string, WalletProposalForSigning>();
  const envelopes = new Map<string, Envelope>();
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
    readProposal: vi.fn(
      async (input: { proposalId: string; userId: string }) =>
        proposals.get(`${input.userId}:${input.proposalId}`) ?? null,
    ),
    readWalletKeyEnvelope: vi.fn(
      async (input: { walletId: string; userId: string }) => envelopes.get(input.walletId) ?? null,
    ),
  };
  return { store, state, wallets, unlocks, locks, proposals, envelopes };
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

/**
 * Seed one proposal and its wallet's key envelope. The canonical hash is
 * recomputed from the fields exactly as creation would, so the proposal is
 * internally consistent and signable unless a test deliberately corrupts it.
 */
async function seedProposal(
  h: ReturnType<typeof harness>,
  input: {
    userId: string;
    proposalId: string;
    walletId: string;
    /** The key sealed into the wallet's envelope. */
    key?: Uint8Array;
    /** The sender the proposal records; defaults to the envelope key's address. */
    senderKey?: Uint8Array;
    migrationStatus?: string | null;
    fields?: Partial<typeof PROPOSAL_FIELDS>;
    status?: string;
    expiresAt?: Date;
  },
): Promise<WalletProposalForSigning> {
  const fields = { ...PROPOSAL_FIELDS, ...input.fields };
  const key = input.key ?? KEY;
  const fromAddress = addressOf(input.senderKey ?? key);
  const envelope = await createWalletKeyEnvelope({
    walletId: input.walletId,
    privateKey: Buffer.from(key),
    password: PASSWORD,
  });
  h.envelopes.set(input.walletId, envelope);
  if (input.migrationStatus !== null) {
    h.wallets.set(input.walletId, input.migrationStatus ?? "password_protected");
  }
  const record: WalletProposalForSigning = {
    proposalId: input.proposalId,
    walletId: input.walletId,
    fromAddress,
    chainId: fields.chainId,
    to: fields.to,
    amountWei: fields.amountWei,
    data: fields.data,
    nonce: fields.nonce,
    gasLimit: fields.gasLimit,
    maxFeePerGas: fields.maxFeePerGas,
    maxPriorityFeePerGas: fields.maxPriorityFeePerGas,
    status: input.status ?? "proposed",
    canonicalHash: walletProposalCanonicalHash({
      from: fromAddress,
      chainId: fields.chainId,
      to: fields.to,
      value: fields.amountWei,
      data: fields.data,
      nonce: fields.nonce,
      gasLimit: fields.gasLimit,
      maxFeePerGas: fields.maxFeePerGas,
      maxPriorityFeePerGas: fields.maxPriorityFeePerGas,
    }),
    expiresAt: input.expiresAt ?? new Date(START.getTime() + PROPOSAL_TTL_MS),
  };
  h.proposals.set(`${input.userId}:${input.proposalId}`, record);
  return record;
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
    expect(
      await codeOf(h.service.sign({ userId: "u1", grantId: "grant-1", proposalId: "p1" })),
    ).toBe("vault_locked");
  });

  it("fails closed without a grant, with the wrong grant, and for another person", async () => {
    const h = harness();
    expect(
      await codeOf(h.service.sign({ userId: "u1", grantId: "grant-1", proposalId: "p1" })),
    ).toBe("vault_locked");
    const { grantId } = await h.service.unlock("u1", PASSWORD);
    expect(
      await codeOf(h.service.sign({ userId: "u1", grantId: "grant-999", proposalId: "p1" })),
    ).toBe("grant_mismatch");
    // The grant belongs to u1: in u2's hands it is nothing at all.
    expect(await codeOf(h.service.sign({ userId: "u2", grantId, proposalId: "p1" }))).toBe(
      "vault_locked",
    );
    expect(
      await codeOf(
        h.service.fill({ userId: "u2", grantId, walletId: "w1", site: "https://example.com" }),
      ),
    ).toBe("vault_locked");
  });

  it("validates the proposal after the grant, then the wallet, before signing", async () => {
    const h = harness();
    const { grantId } = await h.service.unlock("u1", PASSWORD);
    // An unknown proposal is refused before any wallet is consulted.
    expect(await codeOf(h.service.sign({ userId: "u1", grantId, proposalId: "missing" }))).toBe(
      "proposal_not_found",
    );
    // Another person's proposal is simply not found in this person's scope.
    await seedProposal(h, { userId: "u2", proposalId: "p-u2", walletId: WALLET_ID_U2 });
    expect(await codeOf(h.service.sign({ userId: "u1", grantId, proposalId: "p-u2" }))).toBe(
      "proposal_not_found",
    );
    // A proposal whose wallet never migrated to a password envelope cannot be signed.
    await seedProposal(h, {
      userId: "u1",
      proposalId: "p-legacy",
      walletId: WALLET_ID_LEGACY,
      migrationStatus: "legacy_server_only",
    });
    expect(await codeOf(h.service.sign({ userId: "u1", grantId, proposalId: "p-legacy" }))).toBe(
      "wallet_not_migrated",
    );
    expect(
      await codeOf(
        h.service.fill({
          userId: "u1",
          grantId,
          walletId: WALLET_ID_LEGACY,
          site: "https://example.com",
        }),
      ),
    ).toBe("wallet_not_migrated");
    // A migrated wallet passes the migration check, but filling is still not
    // wired in this step: the refusal is typed, not faked.
    await seedProposal(h, { userId: "u1", proposalId: "p-migrated", walletId: WALLET_ID });
    expect(
      await codeOf(
        h.service.fill({
          userId: "u1",
          grantId,
          walletId: WALLET_ID,
          site: "https://example.com",
        }),
      ),
    ).toBe("fill_not_enabled");
  });

  it("refuses a proposal that is no longer proposed or has expired", async () => {
    const h = harness();
    const { grantId } = await h.service.unlock("u1", PASSWORD);
    await seedProposal(h, {
      userId: "u1",
      proposalId: "p-cancelled",
      walletId: WALLET_ID,
      status: "cancelled",
    });
    expect(await codeOf(h.service.sign({ userId: "u1", grantId, proposalId: "p-cancelled" }))).toBe(
      "proposal_not_signable",
    );
    await seedProposal(h, {
      userId: "u1",
      proposalId: "p-expired",
      walletId: WALLET_ID,
      expiresAt: new Date(START.getTime() - 1),
    });
    expect(await codeOf(h.service.sign({ userId: "u1", grantId, proposalId: "p-expired" }))).toBe(
      "proposal_not_signable",
    );
    // Exactly at expiry it is already too late.
    await seedProposal(h, {
      userId: "u1",
      proposalId: "p-boundary",
      walletId: WALLET_ID,
      expiresAt: START,
    });
    expect(await codeOf(h.service.sign({ userId: "u1", grantId, proposalId: "p-boundary" }))).toBe(
      "proposal_not_signable",
    );
  });

  it("refuses to sign a proposal whose stored fields no longer match its fingerprint", async () => {
    const h = harness();
    const { grantId } = await h.service.unlock("u1", PASSWORD);
    const record = await seedProposal(h, { userId: "u1", proposalId: "p1", walletId: WALLET_ID });
    // Alter one approved field after the fact; the recorded hash no longer matches.
    record.amountWei = "2000000000000000000";
    expect(await codeOf(h.service.sign({ userId: "u1", grantId, proposalId: "p1" }))).toBe(
      "proposal_tampered",
    );
    // A swapped recipient is equally a different transaction than the one approved.
    const swapped = await seedProposal(h, {
      userId: "u1",
      proposalId: "p2",
      walletId: WALLET_ID,
    });
    swapped.to = "0x2222222222222222222222222222222222222222";
    expect(await codeOf(h.service.sign({ userId: "u1", grantId, proposalId: "p2" }))).toBe(
      "proposal_tampered",
    );
  });

  it("refuses to sign when the wallet key does not match the proposal's recorded sender", async () => {
    const h = harness();
    const { grantId } = await h.service.unlock("u1", PASSWORD);
    // The proposal records FROM, but the wallet's envelope holds a different key.
    // The proposal records KEY's sender, but the wallet's envelope holds KEY_OTHER.
    await seedProposal(h, {
      userId: "u1",
      proposalId: "p1",
      walletId: WALLET_ID,
      key: KEY_OTHER,
      senderKey: KEY,
    });
    expect(await codeOf(h.service.sign({ userId: "u1", grantId, proposalId: "p1" }))).toBe(
      "wallet_key_mismatch",
    );
  });

  it("signs the stored proposal it re-read, bound to the approved fields", async () => {
    const h = harness();
    const { grantId } = await h.service.unlock("u1", PASSWORD);
    await seedProposal(h, { userId: "u1", proposalId: "p1", walletId: WALLET_ID });
    const signed = await h.service.sign({ userId: "u1", grantId, proposalId: "p1" });
    expect(signed.signedTransaction.startsWith("0x02")).toBe(true);
    expect(signed.transactionHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(signed.from).toBe(FROM);
    // Deterministic for the same proposal, and distinct when a field differs.
    const again = await h.service.sign({ userId: "u1", grantId, proposalId: "p1" });
    expect(again.signedTransaction).toBe(signed.signedTransaction);
    const other = await seedProposal(h, {
      userId: "u1",
      proposalId: "p2",
      walletId: WALLET_ID,
      fields: { nonce: 4 },
    });
    const signedOther = await h.service.sign({ userId: "u1", grantId, proposalId: "p2" });
    expect(signedOther.signedTransaction).not.toBe(signed.signedTransaction);
    expect(other.canonicalHash).not.toBe(h.proposals.get("u1:p1")?.canonicalHash);
  });

  it("locks immediately, audits the lock, and stays locked", async () => {
    const h = harness();
    const { grantId } = await h.service.unlock("u1", PASSWORD);
    expect(await h.service.lock("u1")).toEqual({ locked: true });
    expect(h.locks).toEqual([{ userId: "u1", grantId, revokedAt: START }]);
    expect((await h.service.status("u1")).unlocked).toBe(false);
    expect(await codeOf(h.service.sign({ userId: "u1", grantId, proposalId: "p1" }))).toBe(
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
    expect(await codeOf(h.service.sign({ userId: "u1", grantId, proposalId: "p1" }))).toBe(
      "grant_expired",
    );
    expect((await h.service.status("u1")).unlocked).toBe(false);
  });

  it("revokes the grant when the password epoch moves under it", async () => {
    const h = harness();
    const { grantId } = await h.service.unlock("u1", PASSWORD);
    h.state.passwordEpoch = 2;
    expect(await codeOf(h.service.sign({ userId: "u1", grantId, proposalId: "p1" }))).toBe(
      "epoch_mismatch",
    );
    expect(h.locks).toEqual([{ userId: "u1", grantId, revokedAt: START }]);
    // The grant is gone, not merely flagged: the next attempt is a plain lock.
    expect(await codeOf(h.service.sign({ userId: "u1", grantId, proposalId: "p1" }))).toBe(
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
    expect(await codeOf(after.sign({ userId: "u1", grantId, proposalId: "p1" }))).toBe(
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
      await codeOf(h.service.sign({ userId: "u1", grantId: first.grantId, proposalId: "p1" })),
    ).toBe("grant_mismatch");
  });

  it("keeps an unlock out of the audit trail when the audit write fails", async () => {
    const h = harness();
    h.store.recordUnlock = vi.fn(async () => {
      throw new Error("audit store unavailable");
    });
    await expect(h.service.unlock("u1", PASSWORD)).rejects.toThrow("audit store unavailable");
    expect((await h.service.status("u1")).unlocked).toBe(false);
    expect(
      await codeOf(h.service.sign({ userId: "u1", grantId: "grant-1", proposalId: "p1" })),
    ).toBe("vault_locked");
  });

  it("audits the revocation when a grant expires in use", async () => {
    const h = harness();
    const { grantId } = await h.service.unlock("u1", PASSWORD);
    h.advance(WALLET_VAULT_GRANT_TTL_MS);
    expect(await codeOf(h.service.sign({ userId: "u1", grantId, proposalId: "p1" }))).toBe(
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
      await codeOf(h.service.sign({ userId: "u1", grantId: again.grantId, proposalId: "p1" })),
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
        .sign({ userId: "u1", grantId: granted.grantId, proposalId: "p1" })
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
    expect(
      await codeOf(h.service.sign({ userId: "u1", grantId: "grant-1", proposalId: "p1" })),
    ).toBe("grant_mismatch");
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
