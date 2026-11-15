-- Additive: the previous release never reads this table.
CREATE TABLE "wallet_proposals" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "to" TEXT,
    "asset" TEXT NOT NULL,
    "amountWei" TEXT NOT NULL,
    "data" TEXT,
    "nonce" INTEGER NOT NULL,
    "gasLimit" TEXT NOT NULL,
    "maxFeePerGas" TEXT NOT NULL,
    "maxPriorityFeePerGas" TEXT NOT NULL,
    "rpcProfile" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "canonicalHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "runId" TEXT,

    CONSTRAINT "wallet_proposals_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "wallet_proposals_userId_createdAt_idx" ON "wallet_proposals"("userId", "createdAt");
CREATE INDEX "wallet_proposals_walletId_createdAt_idx" ON "wallet_proposals"("walletId", "createdAt");
CREATE INDEX "wallet_proposals_status_expiresAt_idx" ON "wallet_proposals"("status", "expiresAt");

ALTER TABLE "wallet_proposals" ADD CONSTRAINT "wallet_proposals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "wallet_proposals" ADD CONSTRAINT "wallet_proposals_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "user_wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A person's own, in every Space, as user_wallets.
ALTER TABLE "wallet_proposals" ENABLE ROW LEVEL SECURITY;
CREATE POLICY wallet_proposals_tenant ON "wallet_proposals"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY wallet_proposals_system ON "wallet_proposals"
  USING ((SELECT app_rls_bypass()));
