-- Additive: the previous release never reads these columns. Both stay null
-- until a wallet migrates to its password envelope; migration fills them and
-- empties "secretCipher" in the same write.
ALTER TABLE "user_wallets" ADD COLUMN "keyCiphertext" TEXT;
ALTER TABLE "user_wallets" ADD COLUMN "passwordWrap" TEXT;
