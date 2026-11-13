import type { SecretStore } from "@rakazo/adapter-kit";
import { OneTimeCodeTarget } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";

/**
 * The run-side half of the wallet store: what bots may see (names, chains,
 * addresses) and the one fill they may request. The secret is loaded only
 * here, only for a fill the person approved, and its forms are returned for
 * the run to hide everywhere else.
 */

export type UserWalletSummary = { name: string; chain: string; address: string };

type WalletRow = {
  id: string;
  name: string;
  chain: string;
  address: string;
  secretCipher: string;
  updatedAt: Date;
};

/** The wallets a bot may plan with: name, chain and public address, never the secret. */
export async function listUserWallets(
  prisma: PrismaClient,
  userId: string,
): Promise<UserWalletSummary[]> {
  const rows = await prisma.userWallet.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: { name: true, chain: true, address: true },
  });
  // Mapped field by field, so nothing else on the row can reach a bot.
  return rows.map((row) => ({ name: row.name, chain: row.chain, address: row.address }));
}

export async function findUserWallet(
  prisma: PrismaClient,
  userId: string,
  name: string,
): Promise<WalletRow | null> {
  return prisma.userWallet.findFirst({ where: { userId, name } });
}

/** The forms of a wallet secret a run must hide: a key with and without its 0x prefix. */
export function walletSecretRedactions(secret: string): string[] {
  if (/^0x[0-9a-fA-F]{64}$/.test(secret)) return [secret, secret.slice(2)];
  if (/^[0-9a-fA-F]{64}$/.test(secret)) return [secret, `0x${secret}`];
  return [secret];
}

/**
 * One fill of a saved wallet for browser_act fill_wallet, only on `site`: the
 * page the person approved typing this wallet's secret into. The caller passes
 * the returned origin to the page browser, which refuses to fill unless the
 * page is still on it. The secret's forms are returned for the run to hide.
 */
export async function resolveUserWalletFill(input: {
  prisma: PrismaClient;
  secretStore: Pick<SecretStore, "load">;
  userId: string;
  name: string;
  site: string;
  /** When the approved wallet was last saved; a secret replaced since then is not typed. */
  savedAt: string;
}): Promise<
  { text: string; origin: string; redactions: string[]; walletId: string } | { error: string }
> {
  const target = OneTimeCodeTarget.safeParse({ origin: input.site });
  if (!target.success) return { error: "site must be the page's HTTPS origin." };
  const row = await findUserWallet(input.prisma, input.userId, input.name);
  if (!row) return { error: "No wallet is saved under this name. Check list_wallets." };
  if (row.updatedAt.toISOString() !== input.savedAt) {
    return {
      error:
        "This wallet changed after the user approved it, so nothing was typed. Call browser_act again to ask them.",
    };
  }
  const secret = await input.secretStore.load(row.secretCipher, row.id);
  return {
    text: secret,
    origin: new URL(target.data.origin).origin,
    redactions: walletSecretRedactions(secret),
    walletId: row.id,
  };
}

/** The usage record for one approved fill that went into the page. No secret material. */
export async function recordUserWalletUse(input: {
  prisma: PrismaClient;
  walletId: string;
  userId: string;
  botId: string;
  botName: string;
  purpose: string;
  site: string;
}): Promise<void> {
  await input.prisma.userWalletUse.create({
    data: {
      walletId: input.walletId,
      userId: input.userId,
      botId: input.botId,
      botName: input.botName,
      purpose: input.purpose,
      site: input.site,
    },
  });
}
