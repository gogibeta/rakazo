import { PrismaPg } from "@prisma/adapter-pg";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createPool } from "./client.js";
import { PrismaClient } from "./generated/prisma/client.js";

/**
 * These run against a real Postgres because the defect is Postgres's own conversion: a
 * `TIMESTAMP` column stores a wall clock, and `CURRENT_TIMESTAMP` is an instant. Nothing in
 * JavaScript reproduces that, and a mocked pool would pin nothing.
 */
const url = process.env.DATABASE_URL;
const describePostgres = url ? describe : describe.skip;

async function withProbeTable<T>(
  pool: Pool,
  run: (prisma: PrismaClient) => Promise<T>,
): Promise<T> {
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  try {
    await prisma.$executeRawUnsafe("DROP TABLE IF EXISTS session_tz_probe");
    await prisma.$executeRawUnsafe(
      "CREATE TABLE session_tz_probe (id int primary key, at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)",
    );
    return await run(prisma);
  } finally {
    await prisma.$executeRawUnsafe("DROP TABLE IF EXISTS session_tz_probe").catch(() => undefined);
    await prisma.$disconnect();
  }
}

describePostgres("createPool session time zone", () => {
  it("pins the session so a database default and an app value agree", async () => {
    // The bug in one assertion. Both rows are written by the same statement batch a few
    // milliseconds apart, so they must land within a second of each other. Before the pin the
    // default came back one UTC offset away — 330 minutes on the host this was measured on.
    const pool = createPool(url as string, { poolMax: 1 });
    try {
      await withProbeTable(pool, async (prisma) => {
        const instant = new Date();
        await prisma.$executeRawUnsafe(
          "INSERT INTO session_tz_probe (id, at) VALUES (1, $1)",
          instant,
        );
        await prisma.$executeRawUnsafe("INSERT INTO session_tz_probe (id) VALUES (2)");
        const rows = await prisma.$queryRawUnsafe<{ id: number; at: Date }[]>(
          "SELECT id, at FROM session_tz_probe ORDER BY id",
        );
        expect(rows).toHaveLength(2);
        const [appWritten, dbDefault] = rows;
        const gapMs = Math.abs((dbDefault?.at.getTime() ?? 0) - (appWritten?.at.getTime() ?? 0));
        expect(gapMs, "database default and app value must be the same instant").toBeLessThan(
          1_000,
        );
        // And that instant is the one the app meant, not one offset away from it.
        expect(Math.abs((appWritten?.at.getTime() ?? 0) - instant.getTime())).toBeLessThan(1_000);
      });
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
});
