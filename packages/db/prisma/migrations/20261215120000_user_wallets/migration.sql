-- Additive: the previous release never reads these tables.
CREATE TABLE "user_wallets" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "chain" TEXT NOT NULL DEFAULT 'evm',
    "address" TEXT NOT NULL,
    "secretCipher" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_wallets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_wallets_userId_name_key" ON "user_wallets"("userId", "name");
CREATE INDEX "user_wallets_userId_createdAt_idx" ON "user_wallets"("userId", "createdAt");

ALTER TABLE "user_wallets" ADD CONSTRAINT "user_wallets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A person's own, in every Space, as user_proxies.
ALTER TABLE "user_wallets" ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_wallets_tenant ON "user_wallets"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY user_wallets_system ON "user_wallets"
  USING ((SELECT app_rls_bypass()));

CREATE TABLE "user_wallet_uses" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "botName" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "site" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_wallet_uses_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "user_wallet_uses_walletId_createdAt_idx" ON "user_wallet_uses"("walletId", "createdAt");
CREATE INDEX "user_wallet_uses_userId_createdAt_idx" ON "user_wallet_uses"("userId", "createdAt");

ALTER TABLE "user_wallet_uses" ADD CONSTRAINT "user_wallet_uses_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "user_wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_wallet_uses" ADD CONSTRAINT "user_wallet_uses_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A person's own, in every Space, as user_proxies.
ALTER TABLE "user_wallet_uses" ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_wallet_uses_tenant ON "user_wallet_uses"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY user_wallet_uses_system ON "user_wallet_uses"
  USING ((SELECT app_rls_bypass()));
