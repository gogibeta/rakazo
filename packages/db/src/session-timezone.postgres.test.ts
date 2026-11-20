import { describe, expect, it } from "vitest";
import { createPool } from "./client.js";

/**
 * These run against a real Postgres because the defect is Postgres's own conversion: a
 * `TIMESTAMP` column stores a wall clock, and `CURRENT_TIMESTAMP` is an instant. Nothing in
 * JavaScript reproduces that, and a mocked pool would pin nothing.
 *
 * They stay read-only on purpose. The integration harness connects as the restricted runtime
 * login, which has USAGE on `public` but not CREATE, so a test that made its own table failed
 * in CI with 42501 "permission denied for schema public" while passing on a developer's
 * superuser connection. Casting an instant into a bare timestamp reproduces the same
 * conversion without touching the schema.
 */
const url = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && url ? describe : describe.skip;

/** The wall clock Postgres stores in a `TIMESTAMP` (no time zone) column for a given instant. */
async function storedWallClock(
  query: (text: string) => Promise<{ rows: Record<string, unknown>[] }>,
): Promise<{ stored: Date; utc: Date }> {
  // `now()` is a timestamptz. Casting it to `timestamp` is exactly what a DEFAULT does on
  // insert: Postgres drops the offset using the *session* time zone.
  const { rows } = await query(
    "SELECT now()::timestamp AS stored, (now() AT TIME ZONE 'UTC') AS utc",
  );
  const row = rows[0] ?? {};
  return { stored: row.stored as Date, utc: row.utc as Date };
}

describePostgres("createPool session time zone", () => {
  it("pins the session so a stored wall clock matches the instant it came from", async () => {
    // The bug in one assertion. A `DEFAULT CURRENT_TIMESTAMP` column stores `now()::timestamp`,
    // while the app writes a `Date` that `pg` reads back as UTC. If the session zone is not
    // UTC the two land one offset apart — 330 minutes on the host this was measured on — which
    // is what skewed the 24 h expiry, the 6 h wallet unlock and retention.
    const pool = createPool(url as string, { poolMax: 1 });
    try {
      const { stored, utc } = await storedWallClock((text) => pool.query(text));
      const gapMs = Math.abs(stored.getTime() - utc.getTime());
      expect(gapMs, "a stored wall clock must be the instant it came from").toBeLessThan(1_000);
    } finally {
      await pool.end();
    }
  });

  it("pins it on every connection the pool opens, not just the first", async () => {
    // A pool that pinned only its first connection would pass the test above and still skew
    // every later one, which is how this kind of bug survives a smoke test.
    const pool = createPool(url as string, { poolMax: 2 });
    try {
      const seen = new Set<string>();
      const clients = [await pool.connect(), await pool.connect()];
      try {
        for (const client of clients) {
          const { rows } = await client.query<{ TimeZone: string }>("SHOW TimeZone");
          seen.add(rows[0]?.TimeZone ?? "");
        }
      } finally {
        for (const client of clients) client.release();
      }
      expect([...seen]).toEqual(["UTC"]);
    } finally {
      await pool.end();
    }
  });

  it("does not depend on the server's own default", async () => {
    // A session pin that only worked because the server happened to default to UTC would be
    // untested here and wrong in production, where the server keeps its own zone.
    const pool = createPool(url as string, { poolMax: 1 });
    try {
      const client = await pool.connect();
      try {
        const { rows } = await client.query<{ TimeZone: string }>("SHOW TimeZone");
        expect(rows[0]?.TimeZone).toBe("UTC");
        // And the pin survives a transaction, which is where most writes happen.
        await client.query("BEGIN");
        await client.query("SET LOCAL statement_timeout = 5000");
        const inside = await client.query<{ TimeZone: string }>("SHOW TimeZone");
        expect(inside.rows[0]?.TimeZone).toBe("UTC");
        await client.query("COMMIT");
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });
});
