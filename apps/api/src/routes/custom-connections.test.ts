import { ORPCError } from "@orpc/server";
import {
  CustomConnectionAddInput,
  CustomConnectionRemoveInput,
  CustomConnectionTestInput,
} from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RouterContext } from "./context.js";
import { customConnectionsRoutes } from "./custom-connections.js";

// The input schema each route's contract binds, in packages/contracts/src/rpc.ts.
const INPUT_SCHEMAS = {
  add: CustomConnectionAddInput,
  remove: CustomConnectionRemoveInput,
  test: CustomConnectionTestInput,
};

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

/**
 * The route handlers with an oRPC builder stub that applies the route's
 * contract input schema before handing the call to the handler — the same
 * validation the real oRPC layer performs, so a test that drives a route
 * proves the contract schema actually runs ahead of it.
 */
function routes(prisma: unknown, secrets: unknown) {
  const procedureFor = (name: string) => ({
    handler: (fn: unknown) => {
      const schema = INPUT_SCHEMAS[name as keyof typeof INPUT_SCHEMAS];
      if (!schema) return fn;
      return async (call: { context: unknown; input?: unknown }) => {
        const parsed = schema.safeParse(call.input ?? {});
        if (!parsed.success) {
          throw new ORPCError("BAD_REQUEST", { message: parsed.error.issues[0]?.message });
        }
        return (fn as (next: { context: unknown; input: unknown }) => Promise<unknown>)({
          ...call,
          input: parsed.data,
        });
      };
    },
  });
  const family = new Proxy({}, { get: (_target, name) => procedureFor(String(name)) });
  const authed = new Proxy({}, { get: () => family });
  return customConnectionsRoutes({ deps: { prisma, secrets }, authed } as unknown as RouterContext)
    .customConnections as unknown as Record<
    string,
    (call: { context: unknown; input?: unknown }) => Promise<unknown>
  >;
}

function connectionStore() {
  let rows: Row[] = [];
  let next = 0;
  const puts: Array<{ plaintext: string; recordId?: string }> = [];
  const secrets = {
    put: vi.fn(async (plaintext: string, _context: unknown, options?: { recordId?: string }) => {
      puts.push({ plaintext, recordId: options?.recordId });
      return { ciphertext: "v2:sealed-value" };
    }),
    load: vi.fn(async () => KEY),
  };
  const matches = (row: Row, where: { userId: string; name?: string; id?: string }) =>
    row.userId === where.userId &&
    (where.name === undefined || row.name === where.name) &&
    (where.id === undefined || row.id === where.id);
  const prisma = {
    userCustomConnection: {
      create: vi.fn(async ({ data }: { data: Omit<Row, "id" | "createdAt" | "updatedAt"> }) => {
        const row: Row = {
          ...data,
          id: `c${++next}`,
          createdAt: new Date("2026-09-01T00:00:00.000Z"),
          updatedAt: new Date("2026-09-01T00:00:00.000Z"),
        };
        rows.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const row = rows.find((entry) => entry.id === where.id)!;
        Object.assign(row, data);
        return row;
      }),
      findFirst: vi.fn(
        async ({ where }: { where: { userId: string; name?: string; id?: string } }) =>
          rows.find((row) => matches(row, where)) ?? null,
      ),
      findMany: vi.fn(async ({ where }: { where: { userId: string } }) =>
        rows.filter((row) => row.userId === where.userId),
      ),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        rows = rows.filter((row) => row.id !== where.id);
      }),
      deleteMany: vi.fn(async ({ where }: { where: { id: string; userId: string } }) => {
        const before = rows.length;
        rows = rows.filter((row) => !(row.id === where.id && row.userId === where.userId));
        return { count: before - rows.length };
      }),
    },
  };
  return { prisma, secrets, puts, rows: () => rows };
}

const context = { actor: { userId: "u", spaceId: "s" }, signal: undefined };

describe("custom connection routes", () => {
  it("seals the key on add and never returns it from add or list", async () => {
    const store = connectionStore();
    const api = routes(store.prisma, store.secrets);

    const added = await api.add!({
      context,
      input: {
        name: "GitHub",
        baseUrl: "https://api.github.com/",
        authStyle: "bearer",
        apiKey: KEY,
      },
    });
    expect(added).toMatchObject({
      name: "GitHub",
      baseUrl: "https://api.github.com",
      authStyle: "bearer",
      hasApiKey: true,
    });
    // The key went to the seal, keyed by the row's id — nowhere else.
    expect(store.puts).toEqual([{ plaintext: KEY, recordId: "c1" }]);
    expect(store.rows()[0]).toMatchObject({ secretCipher: "v2:sealed-value" });

    const listed = await api.list!({ context });
    for (const response of [added, listed]) {
      const seen = JSON.stringify(response);
      expect(seen).not.toContain(KEY);
      expect(seen).not.toContain("secretCipher");
      expect(seen).not.toContain("v2:sealed-value");
    }
    expect(listed).toEqual({
      connections: [expect.objectContaining({ id: "c1", name: "GitHub", hasApiKey: true })],
    });
  });

  it("saves a keyless connection and stores the auth name only for header and query styles", async () => {
    const store = connectionStore();
    const api = routes(store.prisma, store.secrets);
    const header = await api.add!({
      context,
      input: {
        name: "Svc",
        baseUrl: "https://api.example.com",
        authStyle: "header",
        authName: "X-Api-Key",
      },
    });
    expect(header).toMatchObject({ authStyle: "header", authName: "X-Api-Key", hasApiKey: false });
    expect(store.puts).toEqual([]);
    const bearer = await api.add!({
      context,
      input: {
        name: "Other",
        baseUrl: "https://api.example.org",
        authStyle: "bearer",
        authName: "Ignored",
      },
    });
    expect(bearer).toMatchObject({ authName: null });
  });

  it("refuses a duplicate name and saves nothing twice", async () => {
    const store = connectionStore();
    const api = routes(store.prisma, store.secrets);
    const input = { name: "GitHub", baseUrl: "https://api.github.com", authStyle: "bearer" };
    await api.add!({ context, input });
    await expect(api.add!({ context, input })).rejects.toThrow(/already exists/);
    expect(store.rows()).toHaveLength(1);
  });

  it("deletes the row when sealing fails, so no connection keeps an unsealed key", async () => {
    const store = connectionStore();
    store.secrets.put.mockRejectedValueOnce(new Error("seal failed"));
    const api = routes(store.prisma, store.secrets);
    await expect(
      api.add!({
        context,
        input: {
          name: "GitHub",
          baseUrl: "https://api.github.com",
          authStyle: "bearer",
          apiKey: KEY,
        },
      }),
    ).rejects.toThrow("seal failed");
    expect(store.rows()).toEqual([]);
  });

  it("removes a connection and reports a missing test target as not found", async () => {
    const store = connectionStore();
    const api = routes(store.prisma, store.secrets);
    await api.add!({
      context,
      input: { name: "GitHub", baseUrl: "https://api.github.com", authStyle: "bearer" },
    });
    await expect(api.test!({ context, input: { connectionId: "missing" } })).rejects.toThrow(
      /not found/i,
    );
    expect(await api.remove!({ context, input: { connectionId: "c1" } })).toEqual({ ok: true });
    expect(store.rows()).toEqual([]);
    await expect(api.remove!({ context, input: { connectionId: "c1" } })).rejects.toThrow(
      /not found/i,
    );
  });

  it("validates the add input against the contract schema", async () => {
    const store = connectionStore();
    const api = routes(store.prisma, store.secrets);
    // Plain HTTP is refused before anything is stored.
    await expect(
      api.add!({
        context,
        input: { name: "Local", baseUrl: "http://api.example.com", authStyle: "bearer" },
      }),
    ).rejects.toThrow(/HTTPS/);
    // A link-local metadata address is refused too.
    await expect(
      api.add!({
        context,
        input: { name: "Metadata", baseUrl: "https://169.254.169.254", authStyle: "bearer" },
      }),
    ).rejects.toThrow(/public host/);
    expect(store.rows()).toEqual([]);
    expect(store.secrets.put).not.toHaveBeenCalled();
  });

  it("loads the sealed key for the owner's test and never returns it", async () => {
    const store = connectionStore();
    const api = routes(store.prisma, store.secrets);
    // A host that fails resolution fast, so the call stops at the transport
    // while still exercising the real load path.
    await api.add!({
      context,
      input: { name: "GitHub", baseUrl: "https://api.invalid", authStyle: "bearer", apiKey: KEY },
    });
    const result = await api.test!({ context, input: { connectionId: "c1" } });
    // The sealed key is read back only here, keyed to this row's record id.
    expect(store.secrets.load).toHaveBeenCalledWith("v2:sealed-value", "c1");
    // Only the outcome leaves the route; the key and its sealed form appear nowhere.
    const seen = JSON.stringify(result);
    expect(seen).not.toContain(KEY);
    expect(seen).not.toContain("v2:sealed-value");
    expect(seen).not.toContain("secretCipher");
    expect(result).toMatchObject({ status: null, error: expect.any(String) });
  });

  it("scopes test and remove to the owning user", async () => {
    const store = connectionStore();
    const api = routes(store.prisma, store.secrets);
    await api.add!({
      context,
      input: {
        name: "GitHub",
        baseUrl: "https://api.github.com",
        authStyle: "bearer",
        apiKey: KEY,
      },
    });
    const other = { actor: { userId: "v", spaceId: "s" }, signal: undefined };
    // Another user can neither reach this connection's key nor delete it.
    await expect(api.test!({ context: other, input: { connectionId: "c1" } })).rejects.toThrow(
      /not found/i,
    );
    await expect(api.remove!({ context: other, input: { connectionId: "c1" } })).rejects.toThrow(
      /not found/i,
    );
    // The row survives the refused remove, and its key was never read.
    expect(store.rows()).toHaveLength(1);
    expect(store.secrets.load).not.toHaveBeenCalled();
  });
});
