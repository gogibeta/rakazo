-- Additive: the previous release never reads this table or column.
CREATE TABLE "user_proxies" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "protocol" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "country" TEXT,
    "username" TEXT,
    "passwordCipher" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_proxies_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "user_proxies_userId_createdAt_idx" ON "user_proxies"("userId", "createdAt");

ALTER TABLE "user_proxies" ADD CONSTRAINT "user_proxies_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A person's own, in every Space, as user_model_credentials.
ALTER TABLE "user_proxies" ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_proxies_tenant ON "user_proxies"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY user_proxies_system ON "user_proxies"
  USING ((SELECT app_rls_bypass()));

ALTER TABLE "bots" ADD COLUMN "proxyId" TEXT;

CREATE INDEX "bots_proxyId_idx" ON "bots"("proxyId");

ALTER TABLE "bots" ADD CONSTRAINT "bots_proxyId_fkey" FOREIGN KEY ("proxyId") REFERENCES "user_proxies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
