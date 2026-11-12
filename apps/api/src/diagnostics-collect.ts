import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PrismaClient } from "@rakazo/db";
import type { DiagnosticsInput } from "./diagnostics.js";

const RECENT_RUNS = 10;
const RECENT_ATTEMPTS = 10;
const RECENT_COMPUTER_RUNS = 10;

/** The env slice the report prints, built from whichever env shape the caller has. */
export function diagnosticsEnvFields(env: {
  gitSha?: string;
  nodeEnv?: string;
  agentRuntime?: string;
  sandboxProvider?: string;
  cloudAgentProvider?: string;
  deploymentModelConfigured?: boolean;
  contentEncryption?: boolean;
  wakeupDriver?: string;
  mcpStdioEnabled?: boolean;
  mcpStdioAllowedCommands?: string[];
  mcpAllowPrivateEndpoint?: boolean;
  ticketBoardEnabled?: boolean;
  userDevicesEnabled?: boolean;
  phoneCallsEnabled?: boolean;
}): DiagnosticsInput["env"] {
  return {
    gitSha: env.gitSha,
    nodeEnv: env.nodeEnv ?? "",
    agentRuntime: env.agentRuntime ?? "",
    sandboxProvider: env.sandboxProvider ?? "",
    cloudAgentProvider: env.cloudAgentProvider ?? "",
    deploymentModelConfigured: env.deploymentModelConfigured ?? false,
    contentEncryption: env.contentEncryption ?? false,
    wakeupDriver: env.wakeupDriver ?? "",
    mcpStdioEnabled: env.mcpStdioEnabled ?? false,
    mcpStdioAllowedCommands: env.mcpStdioAllowedCommands ?? [],
    mcpAllowPrivateEndpoint: env.mcpAllowPrivateEndpoint ?? false,
    ticketBoardEnabled: env.ticketBoardEnabled ?? false,
    userDevicesEnabled: env.userDevicesEnabled ?? false,
    phoneCallsEnabled: env.phoneCallsEnabled ?? false,
    secretStore: process.env.SECRET_STORE?.trim() || "encrypted",
  };
}

const serverFields = {
  id: true,
  spaceId: true,
  userId: true,
  transport: true,
  enabled: true,
  allSpaces: true,
  availableIn: { select: { spaceId: true } },
  healthStatus: true,
  healthMessage: true,
  healthToolCount: true,
  healthCheckedAt: true,
} as const;

/**
 * Gathers the diagnostics report input. Unscoped for the operator CLI; scoped to one
 * user for the in-app report, which only ever includes that user's bots and runs.
 */
export async function collectDiagnostics(
  env: DiagnosticsInput["env"],
  prisma: PrismaClient,
  scope?: { userId: string },
): Promise<DiagnosticsInput> {
  const base: DiagnosticsInput = {
    env,
    nodeVersion: process.version,
    database: { reachable: false },
    bots: [],
    assignments: [],
    unassignedServers: [],
    runs: [],
    attempts: [],
    computerRuns: [],
  };
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    return base;
  }
  const userId = scope?.userId;
  const [bots, assignments, unassigned, runs, attempts, computerRuns, migrations] =
    await Promise.all([
      prisma.bot.findMany({
        where: userId ? { userId } : undefined,
        select: { id: true, spaceId: true, userId: true, archivedAt: true },
      }),
      prisma.botMcpServer.findMany({
        where: userId ? { userId } : undefined,
        select: { botId: true, spaceId: true, userId: true, server: { select: serverFields } },
        orderBy: { createdAt: "asc" },
      }),
      // Servers on no bot are an operator concern; a user-scoped report skips them.
      userId
        ? Promise.resolve([])
        : prisma.mcpServer.findMany({ where: { assignments: { none: {} } }, select: serverFields }),
      prisma.run.findMany({
        where: userId ? { bot: { userId } } : undefined,
        select: {
          id: true,
          botId: true,
          status: true,
          trigger: true,
          createdAt: true,
          error: true,
        },
        orderBy: { createdAt: "desc" },
        take: RECENT_RUNS,
      }),
      prisma.attempt.findMany({
        where: userId ? { run: { bot: { userId } } } : undefined,
        select: { runId: true, status: true, error: true, startedAt: true, finishedAt: true },
        orderBy: { startedAt: "desc" },
        take: RECENT_ATTEMPTS,
      }),
      prisma.computerRun.findMany({
        where: userId ? { userId } : undefined,
        select: { kind: true, endReason: true, startedAt: true, endedAt: true },
        orderBy: { startedAt: "desc" },
        take: RECENT_COMPUTER_RUNS,
      }),
      appliedMigrations(prisma),
    ]);
  const flatten = <T extends { availableIn: { spaceId: string }[] }>(server: T) => ({
    ...server,
    availableIn: server.availableIn.map((space) => space.spaceId),
  });
  return {
    ...base,
    database: {
      reachable: true,
      migrationsInImage: readdirSync(
        fileURLToPath(new URL("../../../packages/db/prisma/migrations", import.meta.url)),
        { withFileTypes: true },
      )
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort(),
      ...migrations,
    },
    bots: bots.map(({ archivedAt, ...bot }) => ({ ...bot, archived: archivedAt !== null })),
    assignments: assignments.map((row) => ({ ...row, server: flatten(row.server) })),
    unassignedServers: unassigned.map(flatten),
    runs,
    attempts,
    computerRuns,
  };
}

/** The runtime login normally has no grant on the migration table; that is reported, not fatal. */
async function appliedMigrations(prisma: PrismaClient) {
  try {
    const rows = await prisma.$queryRaw<Array<{ name: string; failed: boolean }>>`
      SELECT migration_name AS name, finished_at IS NULL AS failed
      FROM _prisma_migrations WHERE rolled_back_at IS NULL`;
    return {
      appliedMigrations: rows.filter((row) => !row.failed).map((row) => row.name),
      failedMigrations: rows.filter((row) => row.failed).length,
    };
  } catch {
    return {};
  }
}
