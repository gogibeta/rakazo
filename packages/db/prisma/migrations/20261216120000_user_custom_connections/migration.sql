-- Additive: the previous release never reads this table.
CREATE TABLE "user_custom_connections" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "authStyle" TEXT NOT NULL,
    "authName" TEXT,
    "secretCipher" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_custom_connections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_custom_connections_userId_name_key" ON "user_custom_connections"("userId", "name");
CREATE INDEX "user_custom_connections_userId_createdAt_idx" ON "user_custom_connections"("userId", "createdAt");

ALTER TABLE "user_custom_connections" ADD CONSTRAINT "user_custom_connections_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A person's own, in every Space, as user_proxies.
ALTER TABLE "user_custom_connections" ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_custom_connections_tenant ON "user_custom_connections"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY user_custom_connections_system ON "user_custom_connections"
  USING ((SELECT app_rls_bypass()));
