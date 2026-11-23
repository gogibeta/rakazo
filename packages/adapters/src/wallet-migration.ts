import type { SecretStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { createWalletKeyEnvelope, openWalletKeyWithPassword } from "./wallet-envelope.js";
import {
  verifyWalletVaultPassword,
  WalletVaultNotConfiguredError,
  WalletVaultPasswordError,
} from "./wallet-vault-impl.js";

/**
 * Migrating one wallet from the legacy server seal to its password
 * envelope: the one-time move after which the server key alone can no
 * longer open the wallet.
 *
 * This runs in the API process, owner-initiated from a signed-in session,
 * because that is the one place that already holds both inputs: the server
 * seal that opens the legacy ciphertext (the same process seals new
 * wallets at save time) and the wallet password the owner just typed into
 * Settings. The architecture's first sketch had the vault service open the
 * legacy cipher, but the vault deliberately holds no server key; giving it
 * one would hand it every sealed secret in the product, permanently, for a
 * one-time operation. Here the plaintext exists only inside this call, in
 * this process, for the seconds the move takes — never in the worker,
 * never in a log, a tool event, or an audit row — and the buffers this
 * module owns are wiped as soon as they are spent. (The secret itself
 * arrives as an immutable string from the secret store; JS strings cannot
 * be wiped, which the envelope helpers already document as a boundary.)
 *
 * The move is verify-before-delete, in this order:
 *
 * 1. The password is verified against the vault state, under the same
 *    throttle as unlock and password change. A wrong password is counted
 *    there and refused with the same generic error; nothing else runs.
 * 2. The legacy ciphertext is opened with the server seal, and the secret
 *    must still derive the wallet's stored address.
 * 3. A password envelope is created, then proven: it is opened back with
 *    the password and the result must derive the same stored address.
 * 4. Only then does one conditional write land: the envelope columns and
 *    the `password_protected` status go in and `secretCipher` is emptied
 *    in the same statement, guarded on the status this call read — so the
 *    database can never say "migrated" while the legacy copy is the only
 *    usable one, and two racing migrations cannot both commit.
 *
 * Any failure before that write leaves the legacy wallet exactly as it
 * was: still sealed, still fillable through the legacy path. A failure
 * after the password check also marks the wallet `migration_failed`
 * (best-effort, and never over a wallet that did migrate), so Settings can
 * show that the move was attempted and can be tried again. Re-running on
 * a migrated wallet is a no-op: the envelope is already the only copy.
 *
 * Hooks hear outcomes only — wallet id and a word — never a password, a
 * secret, or ciphertext, so callers can audit the attempt safely.
 */

/** The wallet to migrate is not the caller's, or does not exist. */
export class WalletMigrationNotFoundError extends Error {
  constructor() {
    super("Wallet not found.");
    this.name = "WalletMigrationNotFoundError";
  }
}

/** The move itself failed; the wallet is left on its legacy seal. */
export class WalletMigrationError extends Error {
  constructor() {
    super("The wallet could not be migrated. It is unchanged; try again.");
    this.name = "WalletMigrationError";
  }
}

export type WalletMigrationEvent = {
  walletId: string;
  outcome: "started" | "succeeded" | "failed";
};

type WalletRow = {
  id: string;
  address: string;
  secretCipher: string;
  keyCiphertext: string | null;
  passwordWrap: string | null;
  migrationStatus: string;
};

export async function migrateUserWalletToPasswordEnvelope(input: {
  prisma: PrismaClient;
  secretStore: Pick<SecretStore, "load">;
  userId: string;
  walletId: string;
  password: string;
  /** Derives the public address for a secret; throws when it cannot be read. */
  deriveAddress: (secret: string) => string;
  hooks?: {
    onEvent?: (event: WalletMigrationEvent) => Promise<void>;
    onPasswordRejected?: (info: {
      failedAttempts: number;
      lockedUntil: Date | null;
    }) => Promise<void>;
  };
}): Promise<{ migrationStatus: "password_protected"; alreadyMigrated: boolean }> {
  const { prisma, userId, walletId } = input;
  const row = (await prisma.userWallet.findFirst({
    where: { id: walletId, userId, removedAt: null },
    select: {
      id: true,
      address: true,
      secretCipher: true,
      keyCiphertext: true,
      passwordWrap: true,
      migrationStatus: true,
    },
  })) as WalletRow | null;
  if (!row) throw new WalletMigrationNotFoundError();

  // Already migrated: the envelope is the only copy and there is nothing
  // to redo. A row that claims the status without an envelope is corrupt;
  // refuse rather than pretend, and leave it for the owner to re-import.
  if (row.migrationStatus === "password_protected") {
    if (row.keyCiphertext && row.passwordWrap) {
      return { migrationStatus: "password_protected", alreadyMigrated: true };
    }
    throw new WalletMigrationError();
  }

  await input.hooks?.onEvent?.({ walletId, outcome: "started" });

  // The password check comes first and stands alone: until it passes, the
  // legacy ciphertext is not even opened. Its failures (not configured,
  // rejected) are the vault state's own typed errors, and a rejection is
  // counted by the shared throttle inside the verification itself.
  try {
    await verifyWalletVaultPassword(prisma, userId, input.password, {
      onRejected: input.hooks?.onPasswordRejected,
    });
  } catch (error) {
    await input.hooks?.onEvent?.({ walletId, outcome: "failed" });
    throw error;
  }

  try {
    if (!row.secretCipher) throw new WalletMigrationError();
    const secret = await input.secretStore.load(row.secretCipher, row.id);
    // The legacy secret must still be the wallet the row claims to be.
    if (input.deriveAddress(secret) !== row.address) throw new WalletMigrationError();

    const envelope = await createWalletKeyEnvelope({
      walletId: row.id,
      privateKey: Buffer.from(secret, "utf8"),
      password: input.password,
    });

    // Prove the envelope before anything is deleted: open it back with
    // the password alone and require the same wallet back out.
    const opened = await openWalletKeyWithPassword({
      walletId: row.id,
      envelope,
      password: input.password,
    });
    try {
      if (input.deriveAddress(opened.toString("utf8")) !== row.address) {
        throw new WalletMigrationError();
      }
    } finally {
      opened.fill(0);
    }

    // The one commit: envelope in, legacy cipher out, status flipped —
    // a single conditional statement, so it lands whole or not at all.
    const committed = await prisma.userWallet.updateMany({
      where: { id: row.id, userId, migrationStatus: row.migrationStatus },
      data: {
        keyCiphertext: envelope.keyCiphertext,
        passwordWrap: envelope.passwordWrap,
        migrationStatus: "password_protected",
        secretCipher: "",
      },
    });
    if (committed.count !== 1) throw new WalletMigrationError();
  } catch (error) {
    // Mark the attempt, best-effort: only over a wallet still on its
    // legacy seal, never over one a racing migration just protected.
    await prisma.userWallet
      .updateMany({
        where: {
          id: row.id,
          userId,
          migrationStatus: { in: ["legacy_server_only", "migration_failed"] },
        },
        data: { migrationStatus: "migration_failed" },
      })
      .catch(() => undefined);
    await input.hooks?.onEvent?.({ walletId, outcome: "failed" });
    if (
      error instanceof WalletMigrationError ||
      error instanceof WalletVaultPasswordError ||
      error instanceof WalletVaultNotConfiguredError
    ) {
      throw error;
    }
    // Anything else — a seal that will not open, an unreadable secret —
    // is the same generic failure to the owner; the detail stays server-side.
    throw new WalletMigrationError();
  }

  await input.hooks?.onEvent?.({ walletId, outcome: "succeeded" });
  return { migrationStatus: "password_protected", alreadyMigrated: false };
}
