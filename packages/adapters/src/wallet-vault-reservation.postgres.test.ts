import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import { createDb, Prisma, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  changeWalletVaultPassword,
  reserveWalletVaultAttempt,
  settleWalletVaultFailure,
  settleWalletVaultSuccess,
  setupWalletVaultPassword,
  verifyWalletVaultPassword,
  WALLET_VAULT_LOCKOUT_MS,
  WALLET_VAULT_MAX_FAILED_ATTEMPTS,
  WalletVaultPasswordError,
} from "./wallet-vault-impl.js";

// Dummy passwords for tests only; they guard nothing.
const PASSWORD = "test-vault-password-one";
const NEW_PASSWORD = "test-vault-password-two";
const WRONG = "test-vault-password-wrong";

const url = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE === "1" && url ? describe : describe.skip;

/** The throttle columns of one vault row, read straight from the database. */
type VaultThrottle = {
  failedAttempts: number;
  lockedUntil: Date | null;
  throttleGeneration: bigint;
  windowStartedAt: Date | null;
  pendingReservations: Record<string, string>;
  credentialRevision: bigint;
};

describePostgres("wallet vault reservation throttle (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  const userIds: string[] = [];

  beforeAll(() => {
    const db = createDb(url!);
    prisma = db.prisma;
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
  });

  afterAll(async () => {
    await runAsSystem("reservation cleanup", async () => {
      for (const userId of userIds) {
        await prisma.user.deleteMany({ where: { id: userId } });
      }
    });
    await close();
  });

  /** A user with a configured vault; the vault is where the throttle lives. */
  async function person(password: string = PASSWORD): Promise<string> {
    const id = randomUUID();
    const userId = `resv-${id}-user`;
    await runAsSystem("reservation fixture", () =>
      prisma.user.create({
        data: { id: userId, name: "Reservation tester", email: `${id}@rakazo.test` },
      }),
    );
    userIds.push(userId);
    await runAsSystem("reservation fixture", () =>
      setupWalletVaultPassword(prisma, userId, password),
    );
    return userId;
  }

  /** The vault's throttle state as the database actually holds it. */
  async function throttle(userId: string): Promise<VaultThrottle> {
    return runAsSystem("reservation read", async () => {
      const row = await prisma.walletVault.findUniqueOrThrow({
        where: { userId },
        select: {
          failedAttempts: true,
          lockedUntil: true,
          throttleGeneration: true,
          windowStartedAt: true,
          pendingReservations: true,
          credentialRevision: true,
        },
      });
      return {
        failedAttempts: row.failedAttempts,
        lockedUntil: row.lockedUntil,
        throttleGeneration: row.throttleGeneration,
        windowStartedAt: row.windowStartedAt,
        pendingReservations: row.pendingReservations as Record<string, string>,
        credentialRevision: row.credentialRevision,
      };
    });
  }

  /** Age the accounting window past its life on the database's own clock. */
  async function expireWindow(userId: string): Promise<void> {
    await runAsSystem("reservation clock", () =>
      prisma.$executeRaw(
        Prisma.sql`UPDATE "wallet_vaults" SET "windowStartedAt" = "windowStartedAt" - ${WALLET_VAULT_LOCKOUT_MS} * INTERVAL '1 millisecond' WHERE "userId" = ${userId}`,
      ),
    );
  }

  it("charges one attempt on admission and starts the window only then", async () => {
    const userId = await person();
    const before = await throttle(userId);
    expect(before.windowStartedAt).toBeNull();
    expect(before.pendingReservations).toEqual({});

    const reservation = await runAsSystem("reservation", () =>
      reserveWalletVaultAttempt(prisma, userId),
    );
    expect(reservation).not.toBeNull();
    const token = reservation?.token;
    expect(token).toBeDefined();

    const after = await throttle(userId);
    expect(after.windowStartedAt).not.toBeNull();
    expect(after.failedAttempts).toBe(1);
    expect(Object.keys(after.pendingReservations)).toEqual([token]);
    const recorded = token === undefined ? undefined : after.pendingReservations[token];
    expect(recorded).toBeDefined();
    if (recorded !== undefined) {
      expect(BigInt(recorded)).toBe(after.throttleGeneration);
    }
  });

  it("refuses a sixth attempt in the window without ever calling the verifier", async () => {
    const userId = await person();
    for (let i = 0; i < WALLET_VAULT_MAX_FAILED_ATTEMPTS; i += 1) {
      const reservation = await runAsSystem("reservation", () =>
        reserveWalletVaultAttempt(prisma, userId),
      );
      expect(reservation).not.toBeNull();
    }
    // The window is full: a further reservation is refused outright.
    await expect(
      runAsSystem("reservation", () => reserveWalletVaultAttempt(prisma, userId)),
    ).resolves.toBeNull();

    // A refusal is decided before any password is checked, so the verifier is never reached.
    const verify = vi.fn(async () => true);
    const envelope = await import("./wallet-envelope.js");
    const spy = vi.spyOn(envelope, "verifyPassword").mockImplementation(verify);
    try {
      await expect(
        runAsSystem("reservation", () => verifyWalletVaultPassword(prisma, userId, WRONG)),
      ).rejects.toThrow(WalletVaultPasswordError);
      expect(verify).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }

    const state = await throttle(userId);
    expect(Object.keys(state.pendingReservations)).toHaveLength(WALLET_VAULT_MAX_FAILED_ATTEMPTS);
  });

  it("settles failures in any order and each removes only its own token", async () => {
    const userId = await person();
    const first = (await runAsSystem("reservation", () =>
      reserveWalletVaultAttempt(prisma, userId),
    ))!;
    const second = (await runAsSystem("reservation", () =>
      reserveWalletVaultAttempt(prisma, userId),
    ))!;

    // Settle out of order: the second reservation's failure goes first.
    const settledSecond = await runAsSystem("settle", () =>
      settleWalletVaultFailure(prisma, userId, second.token),
    );
    expect(settledSecond.settled).toBe(true);

    let state = await throttle(userId);
    expect(Object.keys(state.pendingReservations)).toEqual([first.token]);
    // A failure keeps its charge: the counter does not go down.
    expect(state.failedAttempts).toBe(2);

    const settledFirst = await runAsSystem("settle", () =>
      settleWalletVaultFailure(prisma, userId, first.token),
    );
    expect(settledFirst.settled).toBe(true);

    state = await throttle(userId);
    expect(state.pendingReservations).toEqual({});
    expect(state.failedAttempts).toBe(2);
  });

  it("refunds a success only for a token admitted in the current window", async () => {
    const userId = await person();
    const current = (await runAsSystem("reservation", () =>
      reserveWalletVaultAttempt(prisma, userId),
    ))!;
    const settled = await runAsSystem("settle", () =>
      settleWalletVaultSuccess(prisma, userId, current.token),
    );
    expect(settled).toMatchObject({ settled: true, credentialsChanged: false });

    const refunded = await throttle(userId);
    expect(refunded.pendingReservations).toEqual({});
    expect(refunded.failedAttempts).toBe(0);
    expect(refunded.lockedUntil).toBeNull();

    // A token from an older window holds no charge in the current one: settling it removes
    // the token but must not refund the new window's counter, and never drives it negative.
    const stale = (await runAsSystem("reservation", () =>
      reserveWalletVaultAttempt(prisma, userId),
    ))!;
    await runAsSystem("reservation clock", () =>
      prisma.$executeRaw(
        Prisma.sql`UPDATE "wallet_vaults" SET "throttleGeneration" = "throttleGeneration" + 1 WHERE "userId" = ${userId}`,
      ),
    );
    const settledStale = await runAsSystem("settle", () =>
      settleWalletVaultSuccess(prisma, userId, stale.token),
    );
    expect(settledStale.settled).toBe(true);

    const afterStale = await throttle(userId);
    expect(afterStale.pendingReservations).toEqual({});
    // The stale token's own charge stays: it was admitted before the generation moved.
    expect(afterStale.failedAttempts).toBe(1);
  });

  it("settling an unknown or already-settled token changes nothing", async () => {
    const userId = await person();
    const reservation = (await runAsSystem("reservation", () =>
      reserveWalletVaultAttempt(prisma, userId),
    ))!;
    await runAsSystem("settle", () => settleWalletVaultFailure(prisma, userId, reservation.token));
    const once = await throttle(userId);

    const again = await runAsSystem("settle", () =>
      settleWalletVaultFailure(prisma, userId, reservation.token),
    );
    expect(again.settled).toBe(false);
    expect(await throttle(userId)).toEqual(once);

    const unknown = await runAsSystem("settle", () =>
      settleWalletVaultSuccess(prisma, userId, "9999999999"),
    );
    expect(unknown.settled).toBe(false);
    expect(await throttle(userId)).toEqual(once);
  });

  it("locks the window at the cap and refuses even the right password until it expires", async () => {
    const userId = await person();
    for (let i = 0; i < WALLET_VAULT_MAX_FAILED_ATTEMPTS; i += 1) {
      await expect(
        runAsSystem("verify", () => verifyWalletVaultPassword(prisma, userId, WRONG)),
      ).rejects.toThrow(WalletVaultPasswordError);
    }
    const locked = await throttle(userId);
    expect(locked.failedAttempts).toBe(WALLET_VAULT_MAX_FAILED_ATTEMPTS);
    expect(locked.lockedUntil).not.toBeNull();

    // The lockout is time-based, not attempt-based: once the window expires the vault
    // recovers without any successful sign-in. The window start is moved back on the
    // database's own clock, which is what the throttle reads.
    await expireWindow(userId);
    const reservation = await runAsSystem("reservation", () =>
      reserveWalletVaultAttempt(prisma, userId),
    );
    expect(reservation).not.toBeNull();
    const recovered = await throttle(userId);
    expect(recovered.throttleGeneration).toBe(locked.throttleGeneration + 1n);
    expect(recovered.failedAttempts).toBe(1);
  });

  it("clears the lockout when a success refunds the counter below the cap", async () => {
    const userId = await person();
    // Two failed attempts leave two charges on the window, but no lock yet.
    for (let i = 0; i < 2; i += 1) {
      const failed = (await runAsSystem("reservation", () =>
        reserveWalletVaultAttempt(prisma, userId),
      ))!;
      await runAsSystem("settle", () => settleWalletVaultFailure(prisma, userId, failed.token));
    }
    expect((await throttle(userId)).failedAttempts).toBe(2);
    expect((await throttle(userId)).lockedUntil).toBeNull();

    // A success refunds exactly its own charge: the attempt adds one and the settlement
    // takes it straight back, so the two failure charges remain and the counter stays
    // put — well below the cap, with no lock and nothing left pending.
    await expect(
      runAsSystem("verify", () => verifyWalletVaultPassword(prisma, userId, PASSWORD)),
    ).resolves.toMatchObject({ passwordEpoch: 1 });
    const recovered = await throttle(userId);
    expect(recovered.failedAttempts).toBe(2);
    expect(recovered.lockedUntil).toBeNull();
    expect(recovered.pendingReservations).toEqual({});
  });

  it("orphans a window's reservations when the window expires", async () => {
    const userId = await person();
    const stale = (await runAsSystem("reservation", () =>
      reserveWalletVaultAttempt(prisma, userId),
    ))!;
    const generation = (await throttle(userId)).throttleGeneration;

    // Age the window past its life; the next reservation must start a new generation.
    await expireWindow(userId);
    const fresh = await runAsSystem("reservation", () => reserveWalletVaultAttempt(prisma, userId));
    expect(fresh).not.toBeNull();
    const state = await throttle(userId);
    expect(state.throttleGeneration).toBe(generation + 1n);
    // The stale token is still in the map so its late settlement finds only itself.
    expect(state.pendingReservations[stale.token]).toBeDefined();
    // But it no longer belongs to the current window, so it cannot charge or refund it.
    const settled = await runAsSystem("settle", () =>
      settleWalletVaultFailure(prisma, userId, stale.token),
    );
    expect(settled.settled).toBe(true);
    const after = await throttle(userId);
    expect(after.pendingReservations[stale.token]).toBeUndefined();
    expect(Object.keys(after.pendingReservations)).toEqual([fresh!.token]);
    expect(after.failedAttempts).toBe(1);
  });

  it("never lets concurrent changes overwrite each other's newer credential", async () => {
    const userId = await person();
    // Both changes reserve against the same credential revision. Whichever commits first
    // moves the revision, so the other's snapshot goes stale and must not overwrite it:
    // the stale change is rejected instead of clobbering the newer credential.
    const results = await Promise.allSettled([
      runAsSystem("change a", () =>
        changeWalletVaultPassword(prisma, userId, {
          currentPassword: PASSWORD,
          newPassword: NEW_PASSWORD,
        }),
      ),
      runAsSystem("change b", () =>
        changeWalletVaultPassword(prisma, userId, {
          currentPassword: PASSWORD,
          newPassword: NEW_PASSWORD,
        }),
      ),
    ]);

    // At least one change lands; any loser is the generic rejection, never a corruption.
    const landed = results.filter((r) => r.status === "fulfilled");
    expect(landed.length).toBeGreaterThanOrEqual(1);
    for (const result of results) {
      if (result.status === "rejected") {
        expect(result.reason).toBeInstanceOf(WalletVaultPasswordError);
      }
    }

    // Each landed change bumps the revision exactly once, so the revision counts the
    // credential swaps that actually happened — no lost update, no double bump.
    const state = await throttle(userId);
    expect(state.credentialRevision).toBe(BigInt(landed.length));
    expect(state.pendingReservations).toEqual({});

    // The surviving verifier opens with the new password and not the old one.
    const verifier = (
      await runAsSystem("reservation read", () =>
        prisma.walletVault.findUniqueOrThrow({
          where: { userId },
          select: { verifier: true },
        }),
      )
    ).verifier;
    const { verifyPassword } = await import("./wallet-envelope.js");
    expect(await verifyPassword(verifier, NEW_PASSWORD)).toBe(true);
    expect(await verifyPassword(verifier, PASSWORD)).toBe(false);
  });

  it("serializes concurrent reservations so the cap holds under contention", async () => {
    const userId = await person();
    const attempts = WALLET_VAULT_MAX_FAILED_ATTEMPTS + 3;
    const results = await Promise.all(
      Array.from({ length: attempts }, () =>
        runAsSystem("reservation", () => reserveWalletVaultAttempt(prisma, userId)),
      ),
    );
    const admitted = results.filter((r) => r !== null);
    expect(admitted).toHaveLength(WALLET_VAULT_MAX_FAILED_ATTEMPTS);

    const state = await throttle(userId);
    expect(Object.keys(state.pendingReservations)).toHaveLength(WALLET_VAULT_MAX_FAILED_ATTEMPTS);
    expect(state.failedAttempts).toBe(WALLET_VAULT_MAX_FAILED_ATTEMPTS);
    expect(new Set(admitted.map((r) => r!.token)).size).toBe(WALLET_VAULT_MAX_FAILED_ATTEMPTS);
  });

  it("keeps a refused attempt from consuming a reservation token", async () => {
    const userId = await person();
    for (let i = 0; i < WALLET_VAULT_MAX_FAILED_ATTEMPTS; i += 1) {
      await expect(
        runAsSystem("verify", () => verifyWalletVaultPassword(prisma, userId, WRONG)),
      ).rejects.toThrow(WalletVaultPasswordError);
    }
    const locked = await throttle(userId);
    expect(locked.failedAttempts).toBe(WALLET_VAULT_MAX_FAILED_ATTEMPTS);
    expect(locked.lockedUntil).not.toBeNull();
    // Every admitted attempt settled its own reservation, so nothing stays pending.
    expect(Object.keys(locked.pendingReservations)).toHaveLength(0);

    // Once the window is locked, a further attempt is refused before a token is minted:
    // the counters do not move again.
    await expect(
      runAsSystem("verify", () => verifyWalletVaultPassword(prisma, userId, WRONG)),
    ).rejects.toThrow(WalletVaultPasswordError);
    const still = await throttle(userId);
    expect(still.failedAttempts).toBe(WALLET_VAULT_MAX_FAILED_ATTEMPTS);
    expect(Object.keys(still.pendingReservations)).toHaveLength(0);
  });
});
