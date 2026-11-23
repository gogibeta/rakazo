import { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The success path of the `test` route, which the main route tests cannot reach:
 * `testUserConnection` performs a real request, so their only reachable outcome is
 * the transport's error. Mocking it here is what lets the route's own behaviour be
 * asserted — that it loads the row the caller owns, hands that exact row down, and
 * returns only the outcome.
 *
 * The mock is deliberately the narrowest possible: it echoes its input back, so the
 * assertions below can prove the route passed the stored record rather than a stub
 * of its own making.
 */
const seen: Array<{ row: unknown; path: string | undefined }> = [];

vi.mock("@rakazo/adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rakazo/adapters")>();
  return {
    ...actual,
    testUserConnection: vi.fn(async (input: { row: unknown; path?: string }) => {
      seen.push({ row: input.row, path: input.path });
      return { status: 200, error: null };
    }),
  };
});

const { customConnectionsRoutes } = await import("./custom-connections.js");

const KEY = "test-only-api-key-12345";

type Row = {
  id: string;
  userId: string;
  name: string;
  baseUrl: string;
  authStyle: string;
  authName: string | null;
  secretCipher: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function store(rows: Row[]) {
  return {
    userCustomConnection: {
      findFirst: vi.fn(
        async ({ where }: { where: { userId: string; id?: string; name?: string } }) =>
          rows.find(
            (row) =>
              row.userId === where.userId &&
              (where.id === undefined || row.id === where.id) &&
              (where.name === undefined || row.name === where.name),
          ) ?? null,
      ),
    },
  };
}

/** The route handlers with the oRPC builder reduced to a passthrough. */
function routes(prisma: unknown) {
  const procedure = { handler: (fn: unknown) => fn };
  const family = new Proxy({}, { get: () => procedure });
  const authed = new Proxy({}, { get: () => family });
  const ctx = {
    deps: { prisma, secrets: { load: vi.fn(async () => KEY), put: vi.fn() } },
    authed,
  };
  return (
    customConnectionsRoutes(ctx as never) as unknown as {
      customConnections: Record<string, (call: unknown) => Promise<unknown>>;
    }
  ).customConnections;
}

const context = { actor: { userId: "u", spaceId: "s" }, signal: undefined };

const row = (over: Partial<Row> = {}): Row => ({
  id: "c1",
  userId: "u",
  name: "GitHub",
  baseUrl: "https://api.github.com",
  authStyle: "bearer",
  authName: null,
  secretCipher: "v2:sealed-value",
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  updatedAt: new Date("2026-09-01T00:00:00.000Z"),
  ...over,
});

beforeEach(() => {
  seen.length = 0;
});

describe("custom connection test route, success path", () => {
  it("loads the owner's stored record and returns only the outcome", async () => {
    const api = routes(store([row()]));
    const result = await api.test!({ context, input: { connectionId: "c1", path: "/user" } });

    // The route handed down the row it read, not one it built: the id and the
    // sealed ciphertext are the stored values.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.row).toMatchObject({ id: "c1", secretCipher: "v2:sealed-value" });
    expect(seen[0]?.path).toBe("/user");
    expect(result).toEqual({ status: 200, error: null });
  });

  it("keeps the key out of the result on the success path too", async () => {
    const api = routes(store([row()]));
    const result = await api.test!({ context, input: { connectionId: "c1" } });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(KEY);
    expect(serialized).not.toContain("v2:sealed-value");
    expect(serialized).not.toContain("secretCipher");
  });

  it("reports another user's connection as not found and never loads it", async () => {
    // The row exists and belongs to `u`; `v` asking for the same id must be told it
    // does not exist, and the load must not happen at all.
    const api = routes(store([row()]));
    const other = { actor: { userId: "v", spaceId: "s" }, signal: undefined };
    await expect(api.test!({ context: other, input: { connectionId: "c1" } })).rejects.toThrow(
      ORPCError,
    );
    await expect(api.test!({ context: other, input: { connectionId: "c1" } })).rejects.toThrow(
      /not found/i,
    );
    expect(seen).toEqual([]);
  });
});
