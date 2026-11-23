// Imported before the route module so the transport stub is registered before the adapter's
// `undici` import is evaluated — otherwise the real transport loads first and the patch is
// too late. See `connector-transport.test-support.ts` for why the stub lives in adapters.

import { ORPCError } from "@orpc/server";
import { appContract } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { connectorTransport } from "../../../../packages/adapters/src/connector-transport.test-support.js";
import type { RouterContext } from "./context.js";
import { customConnectionsRoutes } from "./custom-connections.js";

/**
 * The input schema the SERVED contract binds for each route, read from `appContract` itself
 * rather than re-imported from the schema module.
 *
 * That distinction is the whole point. A hand-copied map keeps working after `rpc.ts` stops
 * binding a schema to a route: the tests would go on applying their own copy while the server
 * accepted any body. Reading through `appContract` means an unwiring comes back `undefined` here
 * and every test that drives that route fails.
 */
type ServedInputSchema = {
  safeParse: (
    value: unknown,
  ) =>
    | { success: true; data: unknown }
    | { success: false; error: { issues: Array<{ message: string }> } };
};

function servedInputSchema(name: "add" | "remove" | "test"): ServedInputSchema | undefined {
  const procedure = appContract.customConnections[name] as unknown as {
    "~orpc"?: { inputSchema?: ServedInputSchema };
  };
  return procedure?.["~orpc"]?.inputSchema;
}

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
      const schema = servedInputSchema(name as "add" | "remove" | "test");
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
  // Prisma filters only on the fields a `where` actually names. The first version of this double
  // compared `row.userId === where.userId` unconditionally, so a route that forgot to scope its
  // lookup passed `undefined`, matched nothing, and the cross-user test passed for exactly the
  // wrong reason. Faithful here means an unscoped lookup FINDS the row — which is what Prisma
  // does — so a missing `userId` fails the test instead of quietly satisfying it.
  const matches = (row: Row, where: { userId?: string; name?: string; id?: string }) =>
    (where.userId === undefined || row.userId === where.userId) &&
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
        async ({ where }: { where: { userId?: string; name?: string; id?: string } }) =>
          rows.find((row) => matches(row, where)) ?? null,
      ),
      findMany: vi.fn(async ({ where }: { where: { userId?: string } }) =>
        rows.filter((row) => matches(row, where)),
      ),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        rows = rows.filter((row) => row.id !== where.id);
      }),
      deleteMany: vi.fn(async ({ where }: { where: { id?: string; userId?: string } }) => {
        const before = rows.length;
        rows = rows.filter((row) => !matches(row, where));
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

  it("lets another user reuse a name, so the duplicate check is scoped too", async () => {
    // Names are unique per user, not globally. A duplicate check that dropped `userId` would
    // refuse this for a name the second user has never used — and against a double that ignored
    // `where` the first user's row would be found either way, so the refusal would look correct.
    const store = connectionStore();
    const api = routes(store.prisma, store.secrets);
    const input = { name: "GitHub", baseUrl: "https://api.github.com", authStyle: "bearer" };
    await api.add!({ context, input });

    store.prisma.userCustomConnection.findFirst.mockClear();
    const other = { actor: { userId: "v", spaceId: "s" }, signal: undefined };
    const added = await api.add!({ context: other, input });
    expect(added).toMatchObject({ name: "GitHub" });
    expect(store.rows()).toHaveLength(2);
    expect(store.rows().filter((row) => row.userId === "v")).toHaveLength(1);

    // The duplicate check carried this caller's id, not just the name.
    expect(store.prisma.userCustomConnection.findFirst).toHaveBeenCalledWith({
      where: { userId: "v", name: "GitHub" },
      select: { id: true },
    });
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

  it("hands the decrypted key to the adapter on a successful test", async () => {
    // The other half of the security claim. "load was called" only proves the sealed value
    // was read; the adapter could load it and then drop it. The adapter's contract is to put
    // the key ON THE WIRE, so that is what this asserts: the outbound request the adapter sent
    // carries the decrypted key, and nothing else does.
    const store = connectionStore();
    const api = routes(store.prisma, store.secrets);
    await api.add!({
      context,
      input: {
        name: "GitHub",
        baseUrl: connectorTransport.successUrl,
        authStyle: "bearer",
        apiKey: KEY,
      },
    });
    connectorTransport.requests.length = 0;

    const result = await api.test!({ context, input: { connectionId: "c1" } });

    // The call succeeded, so the whole path ran: scoped lookup, load, inject, send, respond.
    expect(result).toEqual({ status: 200, error: null });
    // The sealed value was read back for THIS row's record id, once.
    expect(store.secrets.load).toHaveBeenCalledTimes(1);
    expect(store.secrets.load).toHaveBeenCalledWith("v2:sealed-value", "c1");
    // And the decrypted key is what the adapter actually put on the wire — the injection
    // itself, not merely the read that precedes it.
    const sent = connectorTransport.requests[0];
    expect(sent?.url).toBe(`${connectorTransport.successUrl}/`);
    expect(sent?.headers.authorization).toBe(`Bearer ${KEY}`);
    // The key still does not come back out of the route.
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(JSON.stringify(connectorTransport.requests)).not.toContain("v2:sealed-value");
  });

  it("scopes test and remove to the owning user, and says so in the query itself", async () => {
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

    store.prisma.userCustomConnection.findFirst.mockClear();
    store.prisma.userCustomConnection.deleteMany.mockClear();

    // Another user can neither reach this connection's key nor delete it.
    await expect(api.test!({ context: other, input: { connectionId: "c1" } })).rejects.toThrow(
      /not found/i,
    );
    await expect(api.remove!({ context: other, input: { connectionId: "c1" } })).rejects.toThrow(
      /not found/i,
    );

    // The refusal is not enough on its own: a route that looked the row up by id alone would
    // also refuse, because the double now returns the row for an unscoped `where` and the
    // route would then be answering about someone else's connection. So assert the exact
    // arguments the route handed the database — the caller's own id, every time.
    expect(store.prisma.userCustomConnection.findFirst).toHaveBeenCalledWith({
      where: { id: "c1", userId: "v" },
    });
    expect(store.prisma.userCustomConnection.deleteMany).toHaveBeenCalledWith({
      where: { id: "c1", userId: "v" },
    });

    // The row survives the refused remove, and its key was never read.
    expect(store.rows()).toHaveLength(1);
    expect(store.rows()[0]?.userId).toBe("u");
    expect(store.secrets.load).not.toHaveBeenCalled();
  });

  it("does not fall back to an unscoped lookup when the caller owns nothing", async () => {
    // The failure mode this pins: a route that tries the scoped lookup, finds nothing, and then
    // retries without `userId` "to give a better error". Against a double that ignores `where`
    // that fallback would look identical to correct scoping; against a faithful one it returns
    // another user's row and the key gets loaded. One lookup, scoped, and nothing after it.
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
    store.prisma.userCustomConnection.findFirst.mockClear();

    const other = { actor: { userId: "v", spaceId: "s" }, signal: undefined };
    await expect(api.test!({ context: other, input: { connectionId: "c1" } })).rejects.toThrow(
      /not found/i,
    );

    // Exactly one lookup, and the only one it made carried the caller's id.
    expect(store.prisma.userCustomConnection.findFirst).toHaveBeenCalledTimes(1);
    for (const call of store.prisma.userCustomConnection.findFirst.mock.calls) {
      expect(call[0]).toEqual({ where: { id: "c1", userId: "v" } });
    }
    expect(store.secrets.load).not.toHaveBeenCalled();
  });

  it("serves and validates add through the schema the contract actually binds", async () => {
    // F1: the contracts test asserts the schema's SHAPE; this asserts the SERVED route uses it.
    // The two are different failures. If `rpc.ts` stopped binding `CustomConnectionAddInput` to
    // `customConnections.add`, the shape test would keep passing while the endpoint accepted any
    // body — and the SSRF gate, which lives in that schema, would never run. So: the served
    // schema must exist, and the route must refuse through it.
    expect(servedInputSchema("add")).toBeDefined();

    const store = connectionStore();
    const api = routes(store.prisma, store.secrets);
    // A body the schema refuses for a reason only the real schema gives.
    await expect(
      api.add!({
        context,
        input: { name: "Metadata", baseUrl: "https://169.254.169.254", authStyle: "bearer" },
      }),
    ).rejects.toThrow(/public host/);
    // Nothing was created and nothing was sealed.
    expect(store.rows()).toEqual([]);
    expect(store.secrets.put).not.toHaveBeenCalled();
  });
});
