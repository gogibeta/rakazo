-- Additive: the previous release never reads this table. Every existing
-- connection's current credential becomes its pool entry #1 below, so a
-- connection keeps working exactly as before until more keys are added.
CREATE TABLE "user_model_credential_keys" (
    "id" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "secretId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "lastFailedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_model_credential_keys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_model_credential_keys_credentialId_secretId_key" ON "user_model_credential_keys"("credentialId", "secretId");
CREATE INDEX "user_model_credential_keys_credentialId_position_idx" ON "user_model_credential_keys"("credentialId", "position");
CREATE INDEX "user_model_credential_keys_userId_idx" ON "user_model_credential_keys"("userId");

ALTER TABLE "user_model_credential_keys" ADD CONSTRAINT "user_model_credential_keys_credentialId_userId_fkey" FOREIGN KEY ("credentialId", "userId") REFERENCES "user_model_credentials"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_model_credential_keys" ADD CONSTRAINT "user_model_credential_keys_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A person's own, in every Space, as user_model_credentials.
ALTER TABLE "user_model_credential_keys" ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_model_credential_keys_tenant ON "user_model_credential_keys"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY user_model_credential_keys_system ON "user_model_credential_keys"
  USING ((SELECT app_rls_bypass()));

-- Pool entry #1 for every existing connection: its current secret, first in
-- order. The id is deterministic so a re-run cannot duplicate it.
INSERT INTO "user_model_credential_keys" ("id", "credentialId", "userId", "label", "secretId", "position", "createdAt", "updatedAt")
SELECT 'key-' || "id", "id", "userId", '', "secretId", 0, "createdAt", "updatedAt"
FROM "user_model_credentials";
