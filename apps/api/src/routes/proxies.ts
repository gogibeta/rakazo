import { ORPCError } from "@orpc/server";
import type { ProxyProtocol, ProxySummary } from "@rakazo/contracts";
import { proxyPartsFromInput } from "@rakazo/contracts";
import type { RouterContext } from "./context.js";

type ProxyRow = {
  id: string;
  name: string;
  protocol: string;
  host: string;
  port: number;
  country: string | null;
  username: string | null;
  passwordCipher: string | null;
  createdAt: Date;
};

/** What a list may show: the password and the composed URL never leave the server. */
function summary(row: ProxyRow): ProxySummary {
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol as ProxyProtocol,
    host: row.host,
    port: row.port,
    country: row.country,
    username: row.username,
    hasPassword: Boolean(row.passwordCipher),
    createdAt: row.createdAt.toISOString(),
  };
}

export function proxiesRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    proxies: {
      list: authed.proxies.list.handler(async ({ context }) => {
        const rows = await deps.prisma.userProxy.findMany({
          where: { userId: context.actor.userId },
          orderBy: { createdAt: "asc" },
        });
        return { proxies: rows.map(summary) };
      }),
      add: authed.proxies.add.handler(async ({ context, input }) => {
        const parts = proxyPartsFromInput(input);
        const row = await deps.prisma.userProxy.create({
          data: {
            userId: context.actor.userId,
            name: input.name,
            protocol: parts.protocol,
            host: parts.host,
            port: parts.port,
            country: parts.country ?? null,
            username: parts.username ?? null,
          },
        });
        if (!parts.password) return summary(row);
        try {
          // Sealed with the row's id as the record id, the way bot secrets seal.
          const stored = await deps.secrets.put(
            parts.password,
            {
              operationId: "proxies.add",
              traceId: "proxies.add",
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              signal: context.signal ?? new AbortController().signal,
            },
            { recordId: row.id },
          );
          const sealed = await deps.prisma.userProxy.update({
            where: { id: row.id },
            data: { passwordCipher: stored.ciphertext },
          });
          return summary(sealed);
        } catch (error) {
          // Never leave a proxy behind whose password silently did not save.
          await deps.prisma.userProxy.delete({ where: { id: row.id } }).catch(() => undefined);
          throw error;
        }
      }),
      remove: authed.proxies.remove.handler(async ({ context, input }) => {
        const removed = await deps.prisma.userProxy.deleteMany({
          where: { id: input.proxyId, userId: context.actor.userId },
        });
        if (removed.count === 0) throw new ORPCError("NOT_FOUND", { message: "Proxy not found" });
        return { ok: true as const };
      }),
    },
  };
}
