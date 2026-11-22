-- W-2: removing a wallet becomes a soft delete (FINAL PLAN step 1), and the
-- removal needs a single-use owner confirmation. `deleteMany` used to destroy
-- the row and the only server-side copy of the key; the owner may not have
-- written that key down anywhere else, so a removal is now reversible, audited,
-- and named before it happens.

ALTER TABLE "user_wallets"
  ADD COLUMN "removedAt" TIMESTAMP(3),
  ADD COLUMN "removedName" TEXT;

-- Listing live wallets is the hot path: every read filters on "removedAt" being
-- NULL. This index keeps that scan proportional to live rows.
CREATE INDEX "user_wallets_userId_removedAt_idx"
  ON "user_wallets" ("userId", "removedAt");

-- Rollout: every existing row is live, which the default NULL already gives it.
-- No backfill is needed and no row changes. Removal in the old code was a hard
-- delete, so no removed rows can exist to reconcile.

-- A one-shot proof that the owner meant to remove this particular wallet. Only
-- the token's SHA-256 is stored, so a database copy cannot be replayed.
CREATE TABLE "wallet_removal_confirmations" (
  "id"         TEXT NOT NULL,
  "userId"     TEXT NOT NULL,
  "walletId"   TEXT NOT NULL,
  "tokenHash"  TEXT NOT NULL,
  "expiresAt"  TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wallet_removal_confirmations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "wallet_removal_confirmations_tokenHash_key"
  ON "wallet_removal_confirmations" ("tokenHash");
CREATE INDEX "wallet_removal_confirmations_userId_createdAt_idx"
  ON "wallet_removal_confirmations" ("userId", "createdAt");
CREATE INDEX "wallet_removal_confirmations_walletId_idx"
  ON "wallet_removal_confirmations" ("walletId");

-- Both foreign keys cascade: a token for a deleted user or wallet is garbage.
ALTER TABLE "wallet_removal_confirmations"
  ADD CONSTRAINT "wallet_removal_confirmations_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The wallet side is the composite key a proposal also uses, so a token cannot
-- name a wallet belonging to someone else.
ALTER TABLE "wallet_removal_confirmations"
  ADD CONSTRAINT "wallet_removal_confirmations_walletId_userId_fkey"
  FOREIGN KEY ("walletId", "userId") REFERENCES "user_wallets"("id", "userId")
  ON DELETE CASCADE ON UPDATE CASCADE;
