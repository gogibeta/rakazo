-- The Telegram owner allowlist an admin saved in Settings, stored in the clear.
ALTER TABLE "deployment_settings" ADD COLUMN "telegramOwnerUserIds" TEXT NOT NULL DEFAULT '';
