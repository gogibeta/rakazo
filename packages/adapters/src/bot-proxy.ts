import type { SecretStore, WebProvider } from "@rakazo/adapter-kit";
import type { ProxyProtocol } from "@rakazo/contracts";
import { composeProxyUrl } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createWebProvider, resolveWebProviderKind } from "./web-provider-factory.js";

/**
 * The web provider for one run. The shared provider serves every bot until a
 * bot's owner picks one of their proxies for it; then the run gets a provider
 * whose traffic leaves through that proxy. The composed URL joins the run's
 * redactions first, so its credentials never reach output or logs.
 */
export async function webProviderForBot(
  deps: { prisma: PrismaClient; secretStore: SecretStore },
  bot: { userId: string; proxyId?: string | null },
  runSecrets: string[],
  fallback: WebProvider,
): Promise<WebProvider> {
  if (!bot.proxyId) return fallback;
  const row = await deps.prisma.userProxy.findFirst({
    where: { id: bot.proxyId, userId: bot.userId },
  });
  if (!row) return fallback;
  const secret = row.passwordCipher
    ? await deps.secretStore.load(row.passwordCipher, row.id)
    : null;
  const proxyUrl = composeProxyUrl({
    protocol: row.protocol as ProxyProtocol,
    host: row.host,
    port: row.port,
    country: row.country,
    username: row.username,
    password: secret,
  });
  runSecrets.push(proxyUrl);
  if (secret) runSecrets.push(secret);
  return createWebProvider(resolveWebProviderKind(), { proxyUrl });
}
