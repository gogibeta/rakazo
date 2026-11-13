import { ORPCError } from "@orpc/server";
import { testUserConnection } from "@rakazo/adapters";
import type { CustomConnectionAuthStyle, CustomConnectionSummary } from "@rakazo/contracts";
import type { RouterContext } from "./context.js";

type ConnectionRow = {
  id: string;
  name: string;
  baseUrl: string;
  authStyle: string;
  authName: string | null;
  secretCipher: string | null;
  createdAt: Date;
};

/** What a list may show: the sealed key never leaves the server. */
function summary(row: ConnectionRow): CustomConnectionSummary {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    authStyle: row.authStyle as CustomConnectionAuthStyle,
    authName: row.authName,
    hasApiKey: Boolean(row.secretCipher),
    createdAt: row.createdAt.toISOString(),
  };
}

export function customConnectionsRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    customConnections: {
      list: authed.customConnections.list.handler(async ({ context }) => {
        const rows = await deps.prisma.userCustomConnection.findMany({
          where: { userId: context.actor.userId },
          orderBy: { createdAt: "asc" },
        });
        return { connections: rows.map(summary) };
      }),
      add: authed.customConnections.add.handler(async ({ context, input }) => {
        const existing = await deps.prisma.userCustomConnection.findFirst({
          where: { userId: context.actor.userId, name: input.name },
          select: { id: true },
        });
        if (existing) {
          throw new ORPCError("BAD_REQUEST", {
            message: "A connection with this name already exists.",
          });
        }
        const row = await deps.prisma.userCustomConnection.create({
          data: {
            userId: context.actor.userId,
            name: input.name,
            baseUrl: input.baseUrl.replace(/\/+$/, ""),
            authStyle: input.authStyle,
            // The name of the header or parameter only means anything for those styles.
            authName: input.authStyle === "bearer" ? null : (input.authName ?? null),
            // Placeholder replaced by the sealed value below, in the same
            // request; the row is deleted if sealing fails.
            secretCipher: null,
          },
        });
        if (!input.apiKey) return summary(row);
        try {
          // Sealed with the row's id as the record id, the way bot secrets seal.
          const stored = await deps.secrets.put(
            input.apiKey,
            {
              operationId: "customConnections.add",
              traceId: "customConnections.add",
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              signal: context.signal ?? new AbortController().signal,
            },
            { recordId: row.id },
          );
          const sealed = await deps.prisma.userCustomConnection.update({
            where: { id: row.id },
            data: { secretCipher: stored.ciphertext },
          });
          return summary(sealed);
        } catch (error) {
          // Never leave a connection behind whose key silently did not save.
          await deps.prisma.userCustomConnection
            .delete({ where: { id: row.id } })
            .catch(() => undefined);
          throw error;
        }
      }),
      remove: authed.customConnections.remove.handler(async ({ context, input }) => {
        const removed = await deps.prisma.userCustomConnection.deleteMany({
          where: { id: input.connectionId, userId: context.actor.userId },
        });
        if (removed.count === 0) {
          throw new ORPCError("NOT_FOUND", { message: "Connection not found" });
        }
        return { ok: true as const };
      }),
      test: authed.customConnections.test.handler(async ({ context, input }) => {
        const row = await deps.prisma.userCustomConnection.findFirst({
          where: { id: input.connectionId, userId: context.actor.userId },
        });
        if (!row) throw new ORPCError("NOT_FOUND", { message: "Connection not found" });
        // One GET through the same guarded call path the bots use; only the
        // status comes back, so a service echoing its key cannot leak it here.
        return testUserConnection({
          secretStore: deps.secrets,
          row,
          path: input.path,
          signal: context.signal ?? new AbortController().signal,
        });
      }),
    },
  };
}
