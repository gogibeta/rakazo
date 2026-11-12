-- The service keys an admin saved in Settings, encrypted as one record.
ALTER TABLE "deployment_settings" ADD COLUMN "serviceCredentialsCipher" TEXT;
