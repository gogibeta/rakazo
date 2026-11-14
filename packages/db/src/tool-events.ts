import { getLogger } from "@rakazo/logging";
import type { Prisma, PrismaClient } from "./client.js";
import { parsePositiveInteger } from "./client.js";
import { isUniqueViolation } from "./prisma-errors.js";
import { runAsSystem } from "./row-security.js";
import { securityEventMetadata } from "./security-events.js";

type ToolEventDb = Pick<PrismaClient, "toolEvent">;
type ToolEventRow = Prisma.ToolEventGetPayload<object>;

export type ToolEventStatus = "succeeded" | "failed" | "refused" | "paused" | "denied";
export type ToolEventKind = "normal" | "recall";

export interface ToolEventInput {
  spaceId: string;
  threadId: string;
  runId: string;
  botId: string;
  /** The resolved tool name, as the gate saw it. */
  toolName: string;
  connectorKind?: string | null;
  /** sha256 hex of the canonical arguments; never the arguments themselves. */
  argsHash: string;
  /**
   * The call's arguments, projected by the caller to scalar values with the run's
   * secrets already redacted. The audit metadata rules are applied here, so
   * content-like keys and overlong values never reach the row.
   */
  argsSummary?: Record<string, string | number | boolean | null | undefined>;
  kind?: ToolEventKind;
  status: ToolEventStatus;
  /** The ExternalEffect this call claimed, when it was gated. */
  effectId?: string | null;
  resultBytes?: number | null;
  durationMs?: number | null;
}

let store: ToolEventDb | undefined;

/** Composition roots install the database once; until then events only reach the log on failure. */
export function installToolEventStore(db: ToolEventDb | undefined): void {
  store = db;
}

/**
 * Append one tool event. Never throws: the call it records already happened, and a
 * failed write logs the event instead. The per-run sequence is allocated here —
 * the highest sequence the run already has, plus one — because the dispatcher
 * runs calls in parallel and a run can be attempted more than once, so no
 * in-memory counter stays correct; a clash on the unique index retries.
 */
export async function recordToolEvent(input: ToolEventInput): Promise<void> {
  const db = store;
  if (!db) return;
  try {
    await runAsSystem("append a tool event", async () => {
      const data = {
        spaceId: input.spaceId,
        threadId: input.threadId,
        runId: input.runId,
        botId: input.botId,
        toolName: input.toolName.slice(0, 200),
        connectorKind: input.connectorKind ?? null,
        argsHash: input.argsHash,
        argsSummary: input.argsSummary ? securityEventMetadata(input.argsSummary) : undefined,
        kind: input.kind ?? "normal",
        status: input.status,
        effectId: input.effectId ?? null,
        resultBytes: input.resultBytes ?? null,
        durationMs: input.durationMs ?? null,
      };
      for (let attempt = 0; ; attempt += 1) {
        const last = await db.toolEvent.findFirst({
          where: { runId: input.runId },
          orderBy: { seq: "desc" },
          select: { seq: true },
        });
        try {
          await db.toolEvent.create({ data: { ...data, seq: (last?.seq ?? 0) + 1 } });
          return;
        } catch (error) {
          if (attempt >= 2 || !isUniqueViolation(error)) throw error;
        }
      }
    });
  } catch (error) {
    getLogger().error("tool.event.write_failed", error, {
      "tool.event.tool": input.toolName,
      "tool.event.status": input.status,
      "tool.event.run_id": input.runId,
      "tool.event.space_id": input.spaceId,
    });
  }
}

/** A run's tool events in dispatch order. The caller has already authorized the space. */
export async function listToolEventsForRun(
  db: ToolEventDb,
  runId: string,
): Promise<ToolEventRow[]> {
  return db.toolEvent.findMany({ where: { runId }, orderBy: { seq: "asc" } });
}

export const DEFAULT_TOOL_EVENT_RETENTION_DAYS = 180;

export function toolEventRetentionDays(source: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveInteger(source.TOOL_EVENT_RETENTION_DAYS, DEFAULT_TOOL_EVENT_RETENTION_DAYS);
}

export async function pruneToolEvents(
  db: ToolEventDb,
  retentionDays: number,
  now = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const { count } = await db.toolEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return count;
}
