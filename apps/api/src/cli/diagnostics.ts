// `docker compose exec api node dist/cli/diagnostics.js`: a redacted report for a support issue.
import { contentKeyProviderFromEnv, unwrapEnvFromKeyManager } from "@rakazo/adapters";
import { createDb, runAsSystem } from "@rakazo/db";
import { renderDiagnostics } from "../diagnostics.js";
import { collectDiagnostics, diagnosticsEnvFields } from "../diagnostics-collect.js";
import { loadEnv } from "../env.js";

// Raw errors can carry connection strings or paths, so only the error's class is printed.
try {
  process.stdout.write(await report());
} catch (error) {
  const kind = error instanceof Error && /^\w+$/.test(error.name) ? error.name : "Error";
  process.stderr.write(`Diagnostics failed (${kind}). Run it in the api service.\n`);
  process.exitCode = 1;
}

async function report(): Promise<string> {
  await unwrapEnvFromKeyManager();
  const env = loadEnv();
  const { prisma, pool } = createDb(env.databaseUrl, { keyProvider: contentKeyProviderFromEnv() });
  try {
    return renderDiagnostics(
      await runAsSystem("diagnostics report", () =>
        collectDiagnostics(diagnosticsEnvFields(env), prisma),
      ),
    );
  } finally {
    await prisma.$disconnect().catch(() => undefined);
    await pool.end().catch(() => undefined);
  }
}
