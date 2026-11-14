-- Additive: the previous release never reads this table or column.
CREATE TABLE "wallet_vaults" (
    "userId" TEXT NOT NULL,
    "verifier" TEXT NOT NULL,
    "verifierVersion" INTEGER NOT NULL DEFAULT 1,
    "passwordEpoch" INTEGER NOT NULL DEFAULT 1,
    "configuredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changedAt" TIMESTAMP(3) NOT NULL,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),

    CONSTRAINT "wallet_vaults_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "wallet_vaults" ADD CONSTRAINT "wallet_vaults_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A person's own, in every Space, as user_wallets.
ALTER TABLE "wallet_vaults" ENABLE ROW LEVEL SECURITY;
CREATE POLICY wallet_vaults_tenant ON "wallet_vaults"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY wallet_vaults_system ON "wallet_vaults"
  USING ((SELECT app_rls_bypass()));

-- Existing wallets predate the wallet password: all start server-only.
ALTER TABLE "user_wallets" ADD COLUMN "migrationStatus" TEXT NOT NULL DEFAULT 'legacy_server_only';
