import { resolveVaultServiceToken } from "@rakazo/core";

/**
 * The vault service's own settings, resolved at startup so a misconfigured
 * deployment fails before the port opens rather than on the first unlock.
 * The vault reads nothing else from the environment: no server seal, no
 * content keys — the password layer it serves needs only the database and
 * its dedicated service credential.
 */
export type VaultEnv = {
  host: string;
  port: number;
  serviceToken: string;
  databaseUrl: string;
};

export function resolveVaultEnv(env: NodeJS.ProcessEnv = process.env): VaultEnv {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("Set DATABASE_URL for the vault service.");
  const port = Number(env.VAULT_PORT ?? 7092);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("VAULT_PORT must be a valid port number.");
  }
  return {
    host: env.VAULT_HOST ?? "127.0.0.1",
    port,
    serviceToken: resolveVaultServiceToken(env),
    databaseUrl,
  };
}
