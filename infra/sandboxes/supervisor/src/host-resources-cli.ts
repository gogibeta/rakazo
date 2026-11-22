import {
  collectHostResources,
  defaultHostResourceDeps,
  formatDirectories,
  formatDisk,
  formatMemory,
  formatProcesses,
  largestDirectories,
} from "./host-resources.js";

/**
 * CLI for the 54a host resource collector. Prints a read-only snapshot of the
 * host's disk / RAM / CPU / per-process usage, and — when roots are given —
 * which directories are eating the space. It never writes, deletes or kills
 * anything.
 *
 *   tsx src/host-resources-cli.ts
 *   tsx src/host-resources-cli.ts --disk / --walk /var/lib/docker,/root --json
 */

interface CliArgs {
  diskPaths: string[];
  walkRoots: string[];
  cpuSampleMs: number;
  processLimit: number;
  maxDepth: number;
  deadlineMs: number;
  asJson: boolean;
}

function splitPaths(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function readNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv: string[]): CliArgs {
  let diskPaths: string[] = [];
  let walkRoots: string[] = [];
  let cpuSampleMs = 250;
  let processLimit = 15;
  let maxDepth = 3;
  let deadlineMs = 8_000;
  let asJson = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];
    if (flag === "--disk") {
      diskPaths = splitPaths(next);
      index += 1;
    } else if (flag === "--walk") {
      walkRoots = splitPaths(next);
      index += 1;
    } else if (flag === "--cpu-ms") {
      cpuSampleMs = readNumber(next, cpuSampleMs);
      index += 1;
    } else if (flag === "--processes") {
      processLimit = readNumber(next, processLimit);
      index += 1;
    } else if (flag === "--depth") {
      maxDepth = readNumber(next, maxDepth);
      index += 1;
    } else if (flag === "--deadline") {
      deadlineMs = readNumber(next, deadlineMs);
      index += 1;
    } else if (flag === "--json") {
      asJson = true;
    }
  }
  return {
    diskPaths: diskPaths.length > 0 ? diskPaths : ["/"],
    walkRoots,
    cpuSampleMs,
    processLimit,
    maxDepth,
    deadlineMs,
    asJson,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const deps = defaultHostResourceDeps();
  const snapshot = await collectHostResources(deps, {
    diskPaths: args.diskPaths,
    cpuSampleMs: args.cpuSampleMs,
    processLimit: args.processLimit,
  });

  if (args.asJson) {
    const directories =
      args.walkRoots.length > 0
        ? await largestDirectories(args.walkRoots, deps, {
            maxDepth: args.maxDepth,
            deadlineMs: args.deadlineMs,
            limit: 25,
          })
        : [];
    process.stdout.write(
      `${JSON.stringify({ snapshot, largestDirectories: directories }, null, 2)}\n`,
    );
    return;
  }

  const lines = [
    `Host resource report — ${snapshot.collectedAt} (${snapshot.host})`,
    "",
    "DISK",
    formatDisk(snapshot.disk),
    "",
    "MEMORY / CPU",
    formatMemory(snapshot),
    "",
    "PROCESSES",
    formatProcesses(snapshot.processes),
  ];
  if (args.walkRoots.length > 0) {
    const directories = await largestDirectories(args.walkRoots, deps, {
      maxDepth: args.maxDepth,
      deadlineMs: args.deadlineMs,
      limit: 25,
    });
    lines.push("", "SPACE", formatDirectories(directories, args.walkRoots.join(", ")));
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

main().catch((error: Error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
