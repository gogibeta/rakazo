-- Additive: the previous release never reads this table.
CREATE TABLE "vault_unlocks" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "passwordEpoch" INTEGER NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "vault_unlocks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "vault_unlocks_userId_issuedAt_idx" ON "vault_unlocks"("userId", "issuedAt");

ALTER TABLE "vault_unlocks" ADD CONSTRAINT "vault_unlocks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A person's own, in every Space, as wallet_vaults. Audit rows only: the
-- policies scope reads and writes to the owner, and nothing in this table
-- authorizes a vault operation.
ALTER TABLE "vault_unlocks" ENABLE ROW LEVEL SECURITY;
CREATE POLICY vault_unlocks_tenant ON "vault_unlocks"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY vault_unlocks_system ON "vault_unlocks"
  USING ((SELECT app_rls_bypass()));
