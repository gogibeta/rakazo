import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { EncryptedSecretStore } from "./secrets.js";
import { openWalletKeyWithPassword } from "./wallet-envelope.js";
import {
  migrateUserWalletToPasswordEnvelope,
  WalletMigrationError,
  WalletMigrationNotFoundError,
} from "./wallet-migration.js";
import { createVaultSqlShim } from "./wallet-vault-fake.js";
import {
  setupWalletVaultPassword,
  WalletVaultNotConfiguredError,
  WalletVaultPasswordError,
} from "./wallet-vault-impl.js";

// The well-known public Hardhat test account #0: a published test vector.
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
// A valid cuid-shaped wallet id (the envelope binds it as associated data).
const WALLET_ID = "c000000000000000000000001";
// Dummy passwords for tests only; they guard nothing.
const PASSWORD = "test-migration-password";
const WRONG = "test-migration-password-wrong";

type WalletRow = {
  id: string;
  userId: string;
  name: string;
  chain: string;
  address: string;
  secretCipher: string;
  keyCiphertext: string | null;
  passwordWrap: string | null;
  migrationStatus: string;
  removedAt: Date | null;
  removedName: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type VaultRow = {
  userId: string;
  verifier: string;
  verifierVersion: number;
  passwordEpoch: number;
  configuredAt: Date;
  changedAt: Date;
  failedAttempts: number;
  lockedUntil: Date | null;
};

/** The derivation stand-in: only the fixture secret derives the fixture address. */
function deriveAddress(secret: string): string {
  if (secret === KEY) return ADDRESS;
  throw new Error("unreadable secret");
}

/** The wallet + vault tables in memory, with the where shapes the code uses. */
function store() {
  const wallets = new Map<string, WalletRow>();
  const vaultRows = new Map<string, VaultRow>();
  const apply = (row: Record<string, unknown>, data: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === "object" && "increment" in value) {
        row[key] = (row[key] as number) + (value as { increment: number }).increment;
      } else {
        row[key] = value;
      }
    }
  };
  const matchesWallet = (row: WalletRow, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, condition]) => {
      const value = row[key as keyof WalletRow];
      if (condition && typeof condition === "object" && "in" in condition) {
        return (condition as { in: unknown[] }).in.includes(value);
      }
      // `{ not: null }` asks for removed rows; a bare null asks for live ones.
      if (condition && typeof condition === "object" && "not" in condition) {
        return value !== (condition as { not: unknown }).not;
      }
      return value === condition;
    });
  const matchesVault = (row: VaultRow, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, condition]) => {
      if (key === "OR") {
        return (condition as Array<Record<string, unknown>>).some((sub) => matchesVault(row, sub));
      }
      const value = row[key as keyof VaultRow];
      if (condition instanceof Date) {
        return value instanceof Date && value.getTime() === condition.getTime();
      }
      if (condition && typeof condition === "object") {
        const ops = condition as { lte?: Date };
        if (ops.lte !== undefined) return value instanceof Date && value <= ops.lte;
        return false;
      }
      return value === condition;
    });
  const client = {
    userWallet: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const row = [...wallets.values()].find((entry) => matchesWallet(entry, where));
        return row ? { ...row } : null;
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          let count = 0;
          for (const row of wallets.values()) {
            if (!matchesWallet(row, where)) continue;
            apply(row as unknown as Record<string, unknown>, data);
            count++;
          }
          return { count };
        },
      ),
    },
    walletVault: {
      findUnique: vi.fn(async ({ where }: { where: { userId: string } }) => {
        const row = vaultRows.get(where.userId);
        return row ? { ...row } : null;
      }),
      create: vi.fn(async ({ data }: { data: VaultRow }) => {
        vaultRows.set(data.userId, { ...data });
        return { ...data };
      }),
      update: vi.fn(
        async ({ where, data }: { where: { userId: string }; data: Record<string, unknown> }) => {
          const row = vaultRows.get(where.userId)!;
          apply(row as unknown as Record<string, unknown>, data);
          return { ...row };
        },
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          let count = 0;
          for (const row of vaultRows.values()) {
            if (!matchesVault(row, where)) continue;
            apply(row as unknown as Record<string, unknown>, data);
            count++;
          }
          return { count };
        },
      ),
    },
    ...createVaultSqlShim(vaultRows),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(client)),
  };
  return { prisma: client as unknown as PrismaClient, wallets, vaultRows };
}

const context = {
  operationId: "test",
  traceId: "test",
  spaceId: "space",
  userId: "u1",
  signal: new AbortController().signal,
};

/** A legacy wallet sealed by the server seal, the way the add flow saves it. */
async function legacyWallet(serverKey = "test-only-encryption-key") {
  const secretStore = new EncryptedSecretStore(serverKey);
  const stored = await secretStore.put(KEY, context, { recordId: WALLET_ID });
  const row: WalletRow = {
    id: WALLET_ID,
    userId: "u1",
    name: "burner",
    chain: "evm",
    address: ADDRESS,
    secretCipher: stored.ciphertext,
    keyCiphertext: null,
    passwordWrap: null,
    migrationStatus: "legacy_server_only",
    removedAt: null,
    removedName: null,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
  };
  return { secretStore, row };
}

async function migrate(
  s: ReturnType<typeof store>,
  secretStore: Pick<EncryptedSecretStore, "load">,
  overrides: Record<string, unknown> = {},
) {
  return migrateUserWalletToPasswordEnvelope({
    prisma: s.prisma,
    secretStore,
    userId: "u1",
    walletId: WALLET_ID,
    password: PASSWORD,
    deriveAddress,
    ...overrides,
  } as Parameters<typeof migrateUserWalletToPasswordEnvelope>[0]);
}

describe("wallet migration to the password envelope", () => {
  it("migrates end to end: envelope in, legacy cipher gone, server key alone cannot open it", async () => {
    const s = store();
    const { secretStore, row } = await legacyWallet();
    s.wallets.set(WALLET_ID, row);
    await setupWalletVaultPassword(s.prisma, "u1", PASSWORD);
    const events: unknown[] = [];

    const result = await migrate(s, secretStore, {
      hooks: { onEvent: async (event: unknown) => void events.push(event) },
    });
    expect(result).toEqual({ migrationStatus: "password_protected", alreadyMigrated: false });

    const migrated = s.wallets.get(WALLET_ID)!;
    expect(migrated.migrationStatus).toBe("password_protected");
    expect(migrated.secretCipher).toBe("");
    expect(migrated.keyCiphertext).toMatch(/^pwk-v1:/);
    expect(migrated.passwordWrap).toMatch(/^pw-v1:/);
    // Nothing stored anywhere derives from or contains the secret.
    expect(JSON.stringify(migrated)).not.toContain(KEY);
    expect(JSON.stringify(migrated)).not.toContain(KEY.slice(2));

    // The acceptance property: with the full stored record and every
    // server-held secret (here the seal key that opened it yesterday),
    // but without the password, the wallet cannot be opened.
    const serverOnly = new EncryptedSecretStore("test-only-encryption-key");
    await expect(serverOnly.load(migrated.passwordWrap!, WALLET_ID)).rejects.toThrow();
    await expect(serverOnly.load(migrated.keyCiphertext!, WALLET_ID)).rejects.toThrow();
    await expect(
      openWalletKeyWithPassword({
        walletId: WALLET_ID,
        envelope: { keyCiphertext: migrated.keyCiphertext!, passwordWrap: migrated.passwordWrap! },
        password: WRONG,
      }),
    ).rejects.toThrow();

    // The password path opens it, and what comes out is the same wallet.
    const opened = await openWalletKeyWithPassword({
      walletId: WALLET_ID,
      envelope: { keyCiphertext: migrated.keyCiphertext!, passwordWrap: migrated.passwordWrap! },
      password: PASSWORD,
    });
    try {
      expect(opened.toString("utf8")).toBe(KEY);
      expect(deriveAddress(opened.toString("utf8"))).toBe(ADDRESS);
    } finally {
      opened.fill(0);
    }

    // Audit events are scalars only: outcomes and the wallet id.
    expect(events).toEqual([
      { walletId: WALLET_ID, outcome: "started" },
      { walletId: WALLET_ID, outcome: "succeeded" },
    ]);
    expect(JSON.stringify(events)).not.toContain(PASSWORD);
    expect(JSON.stringify(events)).not.toContain(KEY);
  });

  it("refuses a wrong password generically, counts it, and leaves the wallet untouched", async () => {
    const s = store();
    const { secretStore, row } = await legacyWallet();
    s.wallets.set(WALLET_ID, row);
    await setupWalletVaultPassword(s.prisma, "u1", PASSWORD);
    const events: unknown[] = [];

    await expect(
      migrate(s, secretStore, {
        password: WRONG,
        hooks: { onEvent: async (event: unknown) => void events.push(event) },
      }),
    ).rejects.toBeInstanceOf(WalletVaultPasswordError);

    const after = s.wallets.get(WALLET_ID)!;
    expect(after.migrationStatus).toBe("legacy_server_only");
    expect(after.secretCipher).toBe(row.secretCipher);
    expect(after.keyCiphertext).toBeNull();
    // Still fully usable through the legacy path.
    expect(await secretStore.load(after.secretCipher, WALLET_ID)).toBe(KEY);
    expect(s.vaultRows.get("u1")!.failedAttempts).toBe(1);
    expect(events).toEqual([
      { walletId: WALLET_ID, outcome: "started" },
      { walletId: WALLET_ID, outcome: "failed" },
    ]);
  });

  it("refuses before a password exists and for another person's wallet", async () => {
    const s = store();
    const { secretStore, row } = await legacyWallet();
    s.wallets.set(WALLET_ID, row);

    await expect(migrate(s, secretStore)).rejects.toBeInstanceOf(WalletVaultNotConfiguredError);
    await expect(migrate(s, secretStore, { userId: "someone-else" })).rejects.toBeInstanceOf(
      WalletMigrationNotFoundError,
    );
    expect(s.wallets.get(WALLET_ID)!.migrationStatus).toBe("legacy_server_only");
  });

  it("leaves the legacy wallet intact and retryable when the move fails midway", async () => {
    const s = store();
    const { secretStore, row } = await legacyWallet();
    s.wallets.set(WALLET_ID, row);
    await setupWalletVaultPassword(s.prisma, "u1", PASSWORD);

    const broken = {
      load: vi.fn(async () => {
        throw new Error("seal unavailable");
      }),
    };
    await expect(migrate(s, broken)).rejects.toBeInstanceOf(WalletMigrationError);

    const after = s.wallets.get(WALLET_ID)!;
    expect(after.migrationStatus).toBe("migration_failed");
    expect(after.secretCipher).toBe(row.secretCipher);
    expect(after.keyCiphertext).toBeNull();
    expect(await secretStore.load(after.secretCipher, WALLET_ID)).toBe(KEY);

    // The retry from the failed state completes the move.
    const result = await migrate(s, secretStore);
    expect(result.alreadyMigrated).toBe(false);
    expect(s.wallets.get(WALLET_ID)!.migrationStatus).toBe("password_protected");
    expect(s.wallets.get(WALLET_ID)!.secretCipher).toBe("");
  });

  it("fails without touching the legacy cipher when the stored address does not match", async () => {
    const s = store();
    const { secretStore, row } = await legacyWallet();
    s.wallets.set(WALLET_ID, { ...row, address: "0x0000000000000000000000000000000000000000" });
    await setupWalletVaultPassword(s.prisma, "u1", PASSWORD);

    await expect(migrate(s, secretStore)).rejects.toBeInstanceOf(WalletMigrationError);
    const after = s.wallets.get(WALLET_ID)!;
    expect(after.migrationStatus).toBe("migration_failed");
    expect(after.secretCipher).toBe(row.secretCipher);
    expect(after.keyCiphertext).toBeNull();
  });

  it("is idempotent: re-running on a migrated wallet changes nothing", async () => {
    const s = store();
    const { secretStore, row } = await legacyWallet();
    s.wallets.set(WALLET_ID, row);
    await setupWalletVaultPassword(s.prisma, "u1", PASSWORD);

    await migrate(s, secretStore);
    const envelope = { ...s.wallets.get(WALLET_ID)! };
    const again = await migrate(s, secretStore);
    expect(again).toEqual({ migrationStatus: "password_protected", alreadyMigrated: true });
    expect(s.wallets.get(WALLET_ID)).toEqual(envelope);
  });
});
