// `pnpm db:migrate`: schema migrations, the job queue schema, then the runtime
// login. Everything here runs as the migration (owner) role; the API and worker
// then connect with DATABASE_URL and only get the runtime grants.
import { execFileSync } from "node:child_process";
import { migrateJobQueue, unwrapEnvFromKeyManager } from "@rakazo/adapters";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import {
  databaseUrls,
  deployMigrations,
  provisionRuntimeRole,
  RUNTIME_ROLE,
  SINGLE_DATABASE_URL_WARNING,
  unenforcedRowSecurityAllowed,
} from "@rakazo/db";

loadRootEnv();
await unwrapEnvFromKeyManager();
const urls = databaseUrls(process.env);
await deployMigrations({
  migrationUrl: urls.migrationUrl,
  previousMigrations: process.env.RAKAZO_DEPLOYED_MIGRATIONS?.split(","),
  dbPackageDir: execFileSync("pnpm", ["--filter", "@rakazo/db", "exec", "pwd"], {
    encoding: "utf8",
  }).trim(),
});
await migrateJobQueue(urls.migrationUrl);

if (!urls.separate) {
  process.stderr.write(`WARNING: ${SINGLE_DATABASE_URL_WARNING}\n`);
  // One URL means one login, and that login is the owner: the policies do not bind
  // it, so the deployment has no database-level tenant isolation. Migrating is how a
  // deployment gets set up, so this is the moment to stop rather than let it run and
  // find out later.
  if (!unenforcedRowSecurityAllowed()) {
    process.stderr.write(
      "Refusing to migrate a deployment without tenant isolation. Point DATABASE_URL at the runtime login and DATABASE_MIGRATION_URL at the owner, or set RAKAZO_ALLOW_UNENFORCED_RLS=true to accept that the database enforces no isolation between Spaces.\n",
    );
    process.exitCode = 1;
    throw new Error("un-enforced row-level security");
  }
} else {
  const { warning } = await provisionRuntimeRole(urls.migrationUrl, urls.url);
  if (warning) process.stderr.write(`WARNING: ${warning}\n`);
  else process.stdout.write(`Runtime login is ready (member of ${RUNTIME_ROLE}).\n`);
}
