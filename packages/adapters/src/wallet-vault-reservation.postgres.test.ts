import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import { createDb, Prisma, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  applyWalletVaultPasswordChange,
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
  // The contention suites open dozens of real connections and contend on one row, which is
  // slower than the default budget allows.
  vi.setConfig({ testTimeout: 30_000 });
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
    const settled = expectSettled(
      await runAsSystem("settle", () => settleWalletVaultSuccess(prisma, userId, current.token)),
    );
    // The settlement reports the revision live on the row, so a caller can tell whether the
    // snapshot it verified against is still the current one (design §4.3).
    expect(settled.credentialRevision).toBe(0n);

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

    // Exactly one change may land. The row lock serializes the conditional swap, so the
    // second verifier's snapshot is always stale by the time it writes: one write, one
    // refund — never two, and never a lost update.
    const landed = results.filter((r) => r.status === "fulfilled");
    expect(landed).toHaveLength(1);
    for (const result of results) {
      if (result.status === "rejected") {
        expect(result.reason).toBeInstanceOf(WalletVaultPasswordError);
      }
    }

    // The landed change bumped the revision exactly once, so the revision counts the
    // credential swaps that actually happened — no lost update, no double bump.
    const state = await throttle(userId);
    expect(state.credentialRevision).toBe(1n);
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
    // Separate connections, per design §7: contention between real connections, not one
    // client borrowing from a pool.
    const results = await withSeparateDbs(attempts, (clients) =>
      Promise.all(
        clients.map((client) =>
          runAsSystem("reservation", () => reserveWalletVaultAttempt(client, userId)),
        ),
      ),
    );
    const admitted = results.filter((r) => r !== null);
    expect(admitted).toHaveLength(WALLET_VAULT_MAX_FAILED_ATTEMPTS);

    const state = await throttle(userId);
    expect(Object.keys(state.pendingReservations)).toHaveLength(WALLET_VAULT_MAX_FAILED_ATTEMPTS);
    expect(state.failedAttempts).toBe(WALLET_VAULT_MAX_FAILED_ATTEMPTS);
    expect(new Set(admitted.map((r) => r!.token)).size).toBe(WALLET_VAULT_MAX_FAILED_ATTEMPTS);
  });

  it("consumes a duplicate settlement exactly once across separate connections", async () => {
    const userId = await person();
    const reservation = await reserve(userId);
    // The same token, settled at once from independent connections: exactly one of them may
    // consume it. The others find nothing pending and change nothing.
    const results = await withSeparateDbs(4, (clients) =>
      Promise.all(
        clients.map((client) =>
          runAsSystem("settle", () => settleWalletVaultFailure(client, userId, reservation.token)),
        ),
      ),
    );
    expect(results.filter((r) => r.settled)).toHaveLength(1);

    const state = await throttle(userId);
    expect(state.pendingReservations).toEqual({});
    expect(state.failedAttempts).toBe(1);
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

  // ---- §7 helpers -----------------------------------------------------------------

  /** One admitted reservation, as returned by {@link reserve}. */
  type Reservation = Awaited<ReturnType<typeof reserve>>;

  /** Assert a settlement succeeded and narrow it so its fields can be read directly. */
  function expectSettled<T extends { settled: boolean }>(
    outcome: T,
  ): Extract<T, { settled: true }> {
    expect(outcome.settled).toBe(true);
    return outcome as Extract<T, { settled: true }>;
  }

  /** Reserve one slot, asserting the vault admitted the attempt. */
  async function reserve(userId: string) {
    const reservation = await runAsSystem("reservation", () =>
      reserveWalletVaultAttempt(prisma, userId),
    );
    expect(reservation).not.toBeNull();
    return reservation!;
  }

  /**
   * Hold the shared verifier so a reservation can sit mid-verification — design §7's
   * controlled schedules. The first call signals it holds the reservation's snapshot and
   * then waits for `release`; any later call (a concurrent change's own current-password
   * check) passes through to the real verifier.
   */
  async function gateVerifier() {
    const envelope = await import("./wallet-envelope.js");
    const real = envelope.verifyPassword;
    let signalCalled!: () => void;
    const called = new Promise<void>((resolve) => {
      signalCalled = resolve;
    });
    let signalRelease!: () => void;
    const gate = new Promise<void>((resolve) => {
      signalRelease = resolve;
    });
    let first = true;
    const spy = vi
      .spyOn(envelope, "verifyPassword")
      .mockImplementation(async (verifier: string, password: string) => {
        if (!first) return real(verifier, password);
        first = false;
        signalCalled();
        await gate;
        return true;
      });
    return { called, release: signalRelease, restore: () => spy.mockRestore() };
  }

  /** Independent connections, so contention is real rather than one pooled client (§7). */
  async function withSeparateDbs<T>(
    count: number,
    run: (clients: PrismaClient[]) => Promise<T>,
  ): Promise<T> {
    const dbs = Array.from({ length: count }, () => createDb(url!));
    try {
      return await run(dbs.map((db) => db.prisma));
    } finally {
      for (const db of dbs) {
        await db.prisma.$disconnect();
        await db.pool.end();
      }
    }
  }

  /** The stored verifier of one vault, for asserting which credential survived. */
  async function storedVerifier(userId: string): Promise<string> {
    return runAsSystem("reservation read", async () => {
      const row = await prisma.walletVault.findUniqueOrThrow({
        where: { userId },
        select: { verifier: true },
      });
      return row.verifier;
    });
  }

  // ---- §7: success ownership ------------------------------------------------------

  it("five_correct_reverse_mismatch_order_clears_lock", async () => {
    const userId = await person();
    const a = await reserve(userId);
    const b = await reserve(userId);
    const c = await reserve(userId);
    const d = await reserve(userId);
    const e = await reserve(userId);
    // Complete in the review's order A, E, D, C, B: every completion finds its own token.
    for (const reservation of [a, e, d, c, b]) {
      expectSettled(
        await runAsSystem("settle", () =>
          settleWalletVaultSuccess(prisma, userId, reservation.token),
        ),
      );
    }
    const state = await throttle(userId);
    expect(state.failedAttempts).toBe(0);
    expect(state.lockedUntil).toBeNull();
    expect(state.pendingReservations).toEqual({});
    expect(state.credentialRevision).toBe(0n);
  });

  it("abc_success_cannot_erase_later_failure", async () => {
    const userId = await person();
    const a = await reserve(userId);
    const b = await reserve(userId);
    await runAsSystem("settle", () => settleWalletVaultSuccess(prisma, userId, b.token));
    const c = await reserve(userId);
    await runAsSystem("settle", () => settleWalletVaultSuccess(prisma, userId, a.token));
    await runAsSystem("settle", () => settleWalletVaultFailure(prisma, userId, c.token));
    const state = await throttle(userId);
    expect(state.failedAttempts).toBe(1);
    expect(state.lockedUntil).toBeNull();
    expect(state.pendingReservations).toEqual({});
  });

  it("abc_failure_before_old_success_is_preserved", async () => {
    const userId = await person();
    const a = await reserve(userId);
    const b = await reserve(userId);
    await runAsSystem("settle", () => settleWalletVaultSuccess(prisma, userId, b.token));
    const c = await reserve(userId);
    await runAsSystem("settle", () => settleWalletVaultFailure(prisma, userId, c.token));
    await runAsSystem("settle", () => settleWalletVaultSuccess(prisma, userId, a.token));
    const state = await throttle(userId);
    expect(state.failedAttempts).toBe(1);
    expect(state.pendingReservations).toEqual({});
  });

  it("duplicate_success_cannot_refund_new_reservation", async () => {
    const userId = await person();
    const a = await reserve(userId);
    await runAsSystem("settle", () => settleWalletVaultSuccess(prisma, userId, a.token));
    const b = await reserve(userId);
    // Repeating A's settlement finds no pending token: it must not touch B's charge.
    const replay = await runAsSystem("settle", () =>
      settleWalletVaultSuccess(prisma, userId, a.token),
    );
    expect(replay.settled).toBe(false);
    await runAsSystem("settle", () => settleWalletVaultFailure(prisma, userId, b.token));
    const state = await throttle(userId);
    expect(state.failedAttempts).toBe(1);
    expect(state.pendingReservations).toEqual({});
  });

  it("mixed_completions_preserve_four_failures", async () => {
    const userId = await person();
    const slots: Reservation[] = [];
    for (let i = 0; i < WALLET_VAULT_MAX_FAILED_ATTEMPTS; i += 1) slots.push(await reserve(userId));
    for (const reservation of slots.slice(1)) {
      await runAsSystem("settle", () =>
        settleWalletVaultFailure(prisma, userId, reservation.token),
      );
    }
    expectSettled(
      await runAsSystem("settle", () => settleWalletVaultSuccess(prisma, userId, slots[0]!.token)),
    );
    const state = await throttle(userId);
    expect(state.failedAttempts).toBe(4);
    expect(state.lockedUntil).toBeNull();
    expect(state.pendingReservations).toEqual({});
  });

  it("refund_at_threshold_reopens_exactly_one_slot", async () => {
    const userId = await person();
    const a = await reserve(userId);
    const b = await reserve(userId);
    const c = await reserve(userId);
    const d = await reserve(userId);
    const e = await reserve(userId);
    // Succeed A: the counter drops below the cap and the lock reopens at once.
    expectSettled(
      await runAsSystem("settle", () => settleWalletVaultSuccess(prisma, userId, a.token)),
    );
    const reopened = await throttle(userId);
    expect(reopened.failedAttempts).toBe(WALLET_VAULT_MAX_FAILED_ATTEMPTS - 1);
    expect(reopened.lockedUntil).toBeNull();
    // Exactly one slot reopened: one more admission fits and a further one is refused.
    const f = await reserve(userId);
    await expect(
      runAsSystem("reservation", () => reserveWalletVaultAttempt(prisma, userId)),
    ).resolves.toBeNull();
    // Fail B through F: the counter returns to the cap and the lock with it.
    for (const reservation of [b, c, d, e, f]) {
      await runAsSystem("settle", () =>
        settleWalletVaultFailure(prisma, userId, reservation.token),
      );
    }
    const state = await throttle(userId);
    expect(state.failedAttempts).toBe(WALLET_VAULT_MAX_FAILED_ATTEMPTS);
    expect(state.lockedUntil).not.toBeNull();
    expect(state.pendingReservations).toEqual({});
  });

  it("admits_only_five_overlapping_wrong_attempts", async () => {
    const userId = await person();
    const admitted = await withSeparateDbs(32, (clients) =>
      Promise.all(
        clients.map((client) =>
          runAsSystem("reservation", () => reserveWalletVaultAttempt(client, userId)),
        ),
      ),
    );
    const slots = admitted.filter((r) => r !== null);
    expect(slots).toHaveLength(WALLET_VAULT_MAX_FAILED_ATTEMPTS);
    expect(new Set(slots.map((r) => r!.token)).size).toBe(WALLET_VAULT_MAX_FAILED_ATTEMPTS);
    // Complete all five as wrong, in reverse admission order.
    for (const reservation of [...slots].reverse()) {
      const settled = await runAsSystem("settle", () =>
        settleWalletVaultFailure(prisma, userId, reservation!.token),
      );
      expect(settled.settled).toBe(true);
    }
    const state = await throttle(userId);
    expect(state.failedAttempts).toBe(WALLET_VAULT_MAX_FAILED_ATTEMPTS);
    expect(state.lockedUntil).not.toBeNull();
    expect(state.pendingReservations).toEqual({});
    expect(state.credentialRevision).toBe(0n);
  });

  // ---- §7: a success on a still-capped row keeps its lock -------------------------

  it("a success on a row still at the cap keeps its lock until the counter drops", async () => {
    const userId = await person();
    const stale = await reserve(userId);
    await expireWindow(userId);
    // Refill the next window to the cap: five charges, locked.
    for (let i = 0; i < WALLET_VAULT_MAX_FAILED_ATTEMPTS; i += 1) await reserve(userId);
    const locked = await throttle(userId);
    expect(locked.failedAttempts).toBe(WALLET_VAULT_MAX_FAILED_ATTEMPTS);
    expect(locked.lockedUntil).not.toBeNull();

    // The stale token settles as a success. It belongs to the retired window, so it refunds
    // nothing: the counter stays at the cap and the lock must survive this settlement.
    const settled = expectSettled(
      await runAsSystem("settle", () => settleWalletVaultSuccess(prisma, userId, stale.token)),
    );
    expect(settled.failedAttempts).toBe(WALLET_VAULT_MAX_FAILED_ATTEMPTS);
    expect(settled.lockedUntil).not.toBeNull();

    const state = await throttle(userId);
    expect(state.failedAttempts).toBe(WALLET_VAULT_MAX_FAILED_ATTEMPTS);
    expect(state.lockedUntil).not.toBeNull();
    expect(state.pendingReservations[stale.token]).toBeUndefined();
  });

  // ---- §7: password change --------------------------------------------------------

  it("incorrect_password_change_is_one_failure", async () => {
    const userId = await person();
    await expect(
      runAsSystem("change", () =>
        changeWalletVaultPassword(prisma, userId, {
          currentPassword: WRONG,
          newPassword: NEW_PASSWORD,
        }),
      ),
    ).rejects.toThrow(WalletVaultPasswordError);
    const state = await throttle(userId);
    expect(state.failedAttempts).toBe(1);
    expect(state.pendingReservations).toEqual({});
    expect(state.credentialRevision).toBe(0n);
  });

  it("password_change_returns_own_slot_after_concurrent_failure", async () => {
    const userId = await person();
    const first = await reserve(userId);
    await runAsSystem("settle", () => settleWalletVaultFailure(prisma, userId, first.token));

    // The change reserves X and verifies, but its settlement waits on the gate.
    const gate = await gateVerifier();
    try {
      const change = runAsSystem("change", () =>
        changeWalletVaultPassword(prisma, userId, {
          currentPassword: PASSWORD,
          newPassword: NEW_PASSWORD,
        }),
      );
      await gate.called;
      // A wrong guess reserves and fails while the change is still in flight.
      const wrong = await reserve(userId);
      await runAsSystem("settle", () => settleWalletVaultFailure(prisma, userId, wrong.token));
      gate.release();
      await change;

      // One completed failure plus the change's own returned charge: two, with K1 live.
      const state = await throttle(userId);
      expect(state.failedAttempts).toBe(2);
      expect(state.lockedUntil).toBeNull();
      expect(state.pendingReservations).toEqual({});
      expect(state.credentialRevision).toBe(1n);
      const verifier = await storedVerifier(userId);
      const { verifyPassword } = await import("./wallet-envelope.js");
      expect(await verifyPassword(verifier, NEW_PASSWORD)).toBe(true);
      expect(await verifyPassword(verifier, PASSWORD)).toBe(false);
    } finally {
      gate.restore();
    }
  });

  it("password_change_returns_own_slot_before_concurrent_failure", async () => {
    const userId = await person();
    const first = await reserve(userId);
    await runAsSystem("settle", () => settleWalletVaultFailure(prisma, userId, first.token));

    const gate = await gateVerifier();
    try {
      const change = runAsSystem("change", () =>
        changeWalletVaultPassword(prisma, userId, {
          currentPassword: PASSWORD,
          newPassword: NEW_PASSWORD,
        }),
      );
      await gate.called;
      gate.release();
      await change;
      // The change committed first; the wrong guess charges after it and stays.
      const wrong = await reserve(userId);
      await runAsSystem("settle", () => settleWalletVaultFailure(prisma, userId, wrong.token));

      const state = await throttle(userId);
      expect(state.failedAttempts).toBe(2);
      expect(state.pendingReservations).toEqual({});
      expect(state.credentialRevision).toBe(1n);
    } finally {
      gate.restore();
    }
  });

  it("verification_of_old_credentials_cannot_authorize_after_change", async () => {
    const userId = await person();
    const gate = await gateVerifier();
    try {
      // A verification reserves against the setup revision and checks the old password.
      const pending = runAsSystem("verify", () =>
        verifyWalletVaultPassword(prisma, userId, PASSWORD),
      );
      await gate.called;
      // A concurrent change re-keys the vault before that verification settles.
      await runAsSystem("change", () =>
        changeWalletVaultPassword(prisma, userId, {
          currentPassword: PASSWORD,
          newPassword: NEW_PASSWORD,
        }),
      );
      expect((await throttle(userId)).credentialRevision).toBe(1n);

      gate.release();
      // The old-password check succeeds against its own snapshot, but the snapshot is no
      // longer the row's: the refund lands and the attempt must NOT authorize.
      await expect(pending).rejects.toThrow(WalletVaultPasswordError);

      const state = await throttle(userId);
      expect(state.credentialRevision).toBe(1n);
      expect(state.pendingReservations).toEqual({});
      expect(state.failedAttempts).toBe(0);
      const verifier = await storedVerifier(userId);
      const { verifyPassword } = await import("./wallet-envelope.js");
      expect(await verifyPassword(verifier, NEW_PASSWORD)).toBe(true);
      expect(await verifyPassword(verifier, PASSWORD)).toBe(false);
    } finally {
      gate.restore();
    }
  });

  it("duplicate_password_change_cannot_write_twice", async () => {
    // A change token is single-use: applying the same prepared change twice must write the
    // credential exactly once. The public change path mints a fresh token per call, so a
    // same-token replay is driven through applyWalletVaultPasswordChange — the atomic unit
    // the change path itself uses — with the SAME token both times.
    const { createPasswordVerifier } = await import("./wallet-envelope.js");
    const readRow = (id: string) =>
      runAsSystem("change read", () =>
        prisma.walletVault.findUniqueOrThrow({
          where: { userId: id },
          select: { credentialRevision: true, passwordEpoch: true, verifier: true },
        }),
      );

    // --- sequential replay ---------------------------------------------------------
    const userId = await person();
    const reservation = await reserve(userId);
    const before = await readRow(userId);
    const verifier = await createPasswordVerifier(NEW_PASSWORD);
    const prepared = { verifier, credentialRevision: reservation.credentialRevision };

    const first = await runAsSystem("change", () =>
      applyWalletVaultPasswordChange(prisma, userId, reservation.token, prepared),
    );
    expect(first.settled).toBe(true);
    const afterFirst = await readRow(userId);
    expect(afterFirst.credentialRevision).toBe(before.credentialRevision + 1n);
    expect(afterFirst.passwordEpoch).toBe(before.passwordEpoch + 1);
    expect(afterFirst.verifier).not.toBe(before.verifier);

    // Replaying the SAME token is a duplicated settlement of one change. It must not write
    // the credential a second time: the token is already consumed and the revision has moved
    // on, so neither the token guard nor the revision guard admits a second swap.
    const replay = await runAsSystem("replay", () =>
      applyWalletVaultPasswordChange(prisma, userId, reservation.token, prepared),
    );
    expect(replay.settled).toBe(false);
    const afterReplay = await readRow(userId);
    expect(afterReplay.credentialRevision).toBe(afterFirst.credentialRevision);
    expect(afterReplay.passwordEpoch).toBe(afterFirst.passwordEpoch);
    expect(afterReplay.verifier).toBe(afterFirst.verifier);
    expect((await throttle(userId)).pendingReservations).toEqual({});

    // --- concurrent replay ---------------------------------------------------------
    // The same token applied twice at once: the row lock serializes the two transactions, so
    // exactly one of them writes and the other finds its token already consumed.
    const userId2 = await person();
    const second = await reserve(userId2);
    const before2 = await readRow(userId2);
    const verifier2 = await createPasswordVerifier(NEW_PASSWORD);
    const prepared2 = { verifier: verifier2, credentialRevision: second.credentialRevision };
    const both = await Promise.all([
      runAsSystem("change A", () =>
        applyWalletVaultPasswordChange(prisma, userId2, second.token, prepared2),
      ),
      runAsSystem("change B", () =>
        applyWalletVaultPasswordChange(prisma, userId2, second.token, prepared2),
      ),
    ]);
    expect(both.filter((outcome) => outcome.settled)).toHaveLength(1);
    const afterBoth = await readRow(userId2);
    expect(afterBoth.credentialRevision).toBe(before2.credentialRevision + 1n);
    expect(afterBoth.passwordEpoch).toBe(before2.passwordEpoch + 1);
    expect((await throttle(userId2)).pendingReservations).toEqual({});

    // The surviving credential is the new one, on both rows.
    const { verifyPassword } = await import("./wallet-envelope.js");
    for (const id of [userId, userId2]) {
      const stored = await storedVerifier(id);
      expect(await verifyPassword(stored, NEW_PASSWORD)).toBe(true);
      expect(await verifyPassword(stored, PASSWORD)).toBe(false);
    }
  });

  it("unknown_token_cannot_change_credentials_or_budget", async () => {
    const userId = await person();
    const b = await reserve(userId);

    // Credential path: a change whose token disappears before it settles must not write
    // credentials and must not report success (design §4.5).
    const gate = await gateVerifier();
    try {
      const change = runAsSystem("change", () =>
        changeWalletVaultPassword(prisma, userId, {
          currentPassword: PASSWORD,
          newPassword: NEW_PASSWORD,
        }),
      );
      await gate.called;
      const mid = await throttle(userId);
      const outstanding = Object.keys(mid.pendingReservations);
      expect(outstanding).toHaveLength(2);
      // Retire the change's own token before its settlement runs, as a maintenance sweep
      // retiring an old window would (design §9). The change must now fail closed.
      const retired = outstanding.find((token) => token !== b.token)!;
      await runAsSystem("retire", () =>
        prisma.$executeRaw(Prisma.sql`UPDATE "wallet_vaults"
          SET "pendingReservations" = "pendingReservations" - ${retired}::text
          WHERE "userId" = ${userId}`),
      );
      gate.release();
      await expect(change).rejects.toThrow(WalletVaultPasswordError);
    } finally {
      gate.restore();
    }

    // Neither the verifier nor the revision moved. The retired slot stays charged, and B's
    // reservation is untouched.
    const state = await throttle(userId);
    expect(state.credentialRevision).toBe(0n);
    expect(Object.keys(state.pendingReservations)).toEqual([b.token]);
    expect(state.failedAttempts).toBe(2);
    const verifier = await storedVerifier(userId);
    const { verifyPassword } = await import("./wallet-envelope.js");
    expect(await verifyPassword(verifier, PASSWORD)).toBe(true);
    expect(await verifyPassword(verifier, NEW_PASSWORD)).toBe(false);

    // The settle paths with an unallocated token change neither budget nor credentials.
    const before = await throttle(userId);
    const settledSuccess = await runAsSystem("settle", () =>
      settleWalletVaultSuccess(prisma, userId, "9999999999"),
    );
    expect(settledSuccess.settled).toBe(false);
    const settledFailure = await runAsSystem("settle", () =>
      settleWalletVaultFailure(prisma, userId, "9999999999"),
    );
    expect(settledFailure.settled).toBe(false);
    expect(await throttle(userId)).toEqual(before);
  });

  // ---- §7: expiry -----------------------------------------------------------------

  it("first_wrong_attempt_after_expiry_is_count_one", async () => {
    const userId = await person();
    for (let i = 0; i < WALLET_VAULT_MAX_FAILED_ATTEMPTS; i += 1) {
      const reservation = await reserve(userId);
      await runAsSystem("settle", () =>
        settleWalletVaultFailure(prisma, userId, reservation.token),
      );
    }
    const before = await throttle(userId);
    expect(before.failedAttempts).toBe(WALLET_VAULT_MAX_FAILED_ATTEMPTS);
    await expireWindow(userId);
    // The first attempt after expiry is admitted and charged once, with no successful
    // attempt in between to clear the window first.
    const a = await reserve(userId);
    await runAsSystem("settle", () => settleWalletVaultFailure(prisma, userId, a.token));
    const state = await throttle(userId);
    expect(state.throttleGeneration).toBe(before.throttleGeneration + 1n);
    expect(state.failedAttempts).toBe(1);
    expect(state.pendingReservations).toEqual({});
  });

  it("expired_failure_does_not_charge_new_generation", async () => {
    const userId = await person();
    const a = await reserve(userId);
    await expireWindow(userId);
    const b = await reserve(userId);
    await runAsSystem("settle", () => settleWalletVaultFailure(prisma, userId, a.token));
    await runAsSystem("settle", () => settleWalletVaultSuccess(prisma, userId, b.token));
    const state = await throttle(userId);
    expect(state.failedAttempts).toBe(0);
    expect(state.pendingReservations).toEqual({});
  });

  it("settlement_after_expiry_does_not_start_window", async () => {
    const userId = await person();
    const a = await reserve(userId);
    await expireWindow(userId);
    const settled = await runAsSystem("settle", () =>
      settleWalletVaultSuccess(prisma, userId, a.token),
    );
    expect(settled.settled).toBe(true);
    const state = await throttle(userId);
    // A settlement alone never starts a window: the anchor stays NULL until an admission.
    expect(state.windowStartedAt).toBeNull();
    expect(state.failedAttempts).toBe(0);
    expect(state.pendingReservations).toEqual({});
  });

  // ---- §7: missing rows -----------------------------------------------------------

  it("missing_vault_refuses_before_verification", async () => {
    const missing = `resv-${randomUUID()}-nobody`;
    const reservation = await runAsSystem("reservation", () =>
      reserveWalletVaultAttempt(prisma, missing),
    );
    expect(reservation).toBeNull();
    // No row was created for the missing vault.
    const created = await runAsSystem("reservation read", () =>
      prisma.walletVault.findUnique({ where: { userId: missing } }),
    );
    expect(created).toBeNull();
  });

  it("deleted_vault_cannot_settle_or_authorize", async () => {
    const userId = await person();
    const reservation = await reserve(userId);
    await runAsSystem("reservation cleanup", () =>
      prisma.user.deleteMany({ where: { id: userId } }),
    );
    // The vault row is gone with the user, so the late completion settles nothing.
    const settled = await runAsSystem("settle", () =>
      settleWalletVaultSuccess(prisma, userId, reservation.token),
    );
    expect(settled.settled).toBe(false);
    const gone = await runAsSystem("reservation read", () =>
      prisma.walletVault.findUnique({ where: { userId } }),
    );
    expect(gone).toBeNull();
  });

  // ---- §8: the rollout repairs a charged legacy row instead of locking it forever -

  it("a legacy charged row without a window anchor is repaired by the rollout", async () => {
    const userId = await person();
    // Revert the row to the shape the previous scheme left behind: a charged counter and a
    // lock, but no window anchor at all (the anchor column did not exist before rollout).
    const lockedUntil = new Date(Date.now() + WALLET_VAULT_LOCKOUT_MS);
    await runAsSystem("legacy fixture", () =>
      prisma.$executeRaw(Prisma.sql`UPDATE "wallet_vaults"
        SET "failedAttempts" = 5, "lockedUntil" = ${lockedUntil}::timestamp,
            "windowStartedAt" = NULL, "pendingReservations" = '{}'::jsonb,
            "throttleGeneration" = 0
        WHERE "userId" = ${userId}`),
    );

    // The rollout backfill + canonicalization from migration 20261224140000. Before this, the
    // canonicalization's "windowStartedAt IS NOT NULL" filter matched nothing, so a charged
    // legacy row could never be normalized and was locked out permanently.
    await runAsSystem("rollout backfill", () =>
      prisma.$executeRaw(Prisma.sql`UPDATE "wallet_vaults"
        SET "windowStartedAt" =
          CASE
            WHEN "failedAttempts" = 0 THEN NULL
            WHEN "lockedUntil" IS NOT NULL THEN "lockedUntil" - INTERVAL '15 minutes'
            ELSE (now() AT TIME ZONE 'UTC')
          END
        WHERE "userId" = ${userId} AND "windowStartedAt" IS NULL`),
    );
    await runAsSystem("rollout canonicalize", () =>
      prisma.$executeRaw(Prisma.sql`UPDATE "wallet_vaults"
        SET "lockedUntil" = CASE WHEN "failedAttempts" >= 5
          THEN "windowStartedAt" + INTERVAL '15 minutes' ELSE NULL END
        WHERE "userId" = ${userId} AND "windowStartedAt" IS NOT NULL`),
    );

    const repaired = await throttle(userId);
    expect(repaired.failedAttempts).toBe(5);
    expect(repaired.windowStartedAt).not.toBeNull();
    expect(repaired.lockedUntil).not.toBeNull();

    // The decisive assertion: the row is recoverable. Once the window expires, the next
    // attempt is admitted — under the pre-fix migration it never would be.
    await expireWindow(userId);
    const reservation = await runAsSystem("reservation", () =>
      reserveWalletVaultAttempt(prisma, userId),
    );
    expect(reservation).not.toBeNull();
    const recovered = await throttle(userId);
    expect(recovered.failedAttempts).toBe(1);
    expect(recovered.throttleGeneration).toBe(repaired.throttleGeneration + 1n);
  });
});
