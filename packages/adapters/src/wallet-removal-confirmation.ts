import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";

/**
 * Wallet removal is the one action in Settings that looks irreversible, and the
 * warning the owner was given says so. A request carrying only a wallet id is
 * therefore not enough: the owner asks for a token first, is shown the wallet's
 * name and address, and sends the token back with the removal.
 *
 * This is defence in depth, not the only guard — `wallets.remove` already
 * requires a signed-in session and filters by owner. What it adds is that a
 * request replayed from somewhere the owner is not looking cannot remove a
 * wallet without them having seen which wallet it is. Bots cannot reach any of
 * this: their wallet tools are `list_wallets` and `wallet_propose`.
 */

/** Five minutes: long enough to read the name and address, short enough to forget. */
export const REMOVAL_TOKEN_TTL_MS = 5 * 60 * 1000;

export class WalletRemovalConfirmationError extends Error {
  constructor(readonly code: "token_required" | "token_invalid" | "token_expired") {
    super(
      code === "token_required"
        ? "Removing a wallet needs a confirmation token. Request one, check it names the wallet you mean, then send it with the removal."
        : code === "token_expired"
          ? "That confirmation has expired. Request a new one and check it names the wallet you mean."
          : "That confirmation is not valid for this wallet. Request a new one.",
    );
    this.name = "WalletRemovalConfirmationError";
  }
}

/** Only the digest is stored, so a database copy cannot be replayed. */
function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface IssueRemovalConfirmationInput {
  prisma: PrismaClient;
  userId: string;
  walletId: string;
  /** Defaults to `randomBytes(32)`; injectable so a test can name the token. */
  createToken?: () => string;
  now?: Date;
}

/**
 * Issue a single-use token for removing one live wallet. Any earlier unused
 * token for the same wallet is left alone rather than revoked: two open
 * confirmations both work, and each is consumed on its own use.
 */
export async function issueWalletRemovalConfirmation(
  input: IssueRemovalConfirmationInput,
): Promise<{ token: string; expiresAt: string; wallet: { name: string; address: string } }> {
  const { prisma, userId, walletId } = input;
  const now = input.now ?? new Date();
  const wallet = await prisma.userWallet.findFirst({
    where: { id: walletId, userId, removedAt: null },
    select: { name: true, address: true },
  });
  if (!wallet) throw new WalletRemovalConfirmationError("token_invalid");

  const token = (input.createToken ?? (() => randomBytes(32).toString("base64url")))();
  const expiresAt = new Date(now.getTime() + REMOVAL_TOKEN_TTL_MS);
  await prisma.walletRemovalConfirmation.create({
    data: { userId, walletId, tokenHash: tokenHash(token), expiresAt },
  });
  // The name and address go back with the token so the caller can show what is
  // about to be removed before the owner confirms it.
  return { token, expiresAt: expiresAt.toISOString(), wallet };
}

export interface ConsumeRemovalConfirmationInput {
  prisma: PrismaClient;
  userId: string;
  walletId: string;
  token: string;
  now?: Date;
}

/**
 * Consume a token for this wallet, or throw. Consumption is a conditional write
 * on `consumedAt: null`, so two callers racing on the same token cannot both
 * succeed: the loser sees zero rows and is refused.
 */
export async function consumeWalletRemovalConfirmation(
  input: ConsumeRemovalConfirmationInput,
): Promise<void> {
  const { prisma, userId, walletId, token } = input;
  const now = input.now ?? new Date();
  const row = await prisma.walletRemovalConfirmation.findFirst({
    where: { tokenHash: tokenHash(token), userId, walletId },
    select: { id: true, expiresAt: true, consumedAt: true },
  });
  // A token for another wallet or another user is reported the same way as a
  // bad token, so this cannot be used to probe which wallet ids exist.
  if (!row || row.consumedAt !== null) {
    throw new WalletRemovalConfirmationError("token_invalid");
  }
  if (row.expiresAt.getTime() <= now.getTime()) {
    throw new WalletRemovalConfirmationError("token_expired");
  }
  const consumed = await prisma.walletRemovalConfirmation.updateMany({
    where: { id: row.id, consumedAt: null },
    data: { consumedAt: now },
  });
  if (consumed.count === 0) throw new WalletRemovalConfirmationError("token_invalid");
}
