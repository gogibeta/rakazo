import {
  lstat as fsLstat,
  readdir as fsReaddir,
  readFile as fsReadFile,
  statfs as fsStatfs,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * 54a-collector: a host-only, strictly READ-ONLY resource monitor.
 *
 * It answers "what is this host's live disk / RAM / CPU / per-process usage,
 * and what is eating the space and the RAM?" Nothing here writes, deletes,
 * restarts or kills anything — every function only reads. The acting side of
 * the monitor (54b) is a separate, later, owner-gated step.
 *
 * All filesystem access goes through {@link HostResourceDeps}, so the parsers
 * and the aggregation logic can be unit-tested against fixtures without a
 * real `/proc` or `/sys`.
 */

export interface StatfsLike {
  blocks: number;
  bsize: number;
  bfree: number;
  bavail: number;
}

export interface LstatLike {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  size: number;
}

/** Everything the collector needs from the outside world. Injectable for tests. */
export interface HostResourceDeps {
  readText(path: string): Promise<string>;
  statfs(path: string): Promise<StatfsLike>;
  listDir(path: string): Promise<string[]>;
  lstat(path: string): Promise<LstatLike>;
  hostname(): string;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export function defaultHostResourceDeps(): HostResourceDeps {
  return {
    readText: (path) => fsReadFile(path, "utf8"),
    statfs: (path) => fsStatfs(path),
    listDir: (path) => fsReaddir(path),
    lstat: (path) => fsLstat(path),
    hostname: () => os.hostname(),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

export interface DiskUsage {
  path: string;
  totalBytes: number;
  freeBytes: number;
  /** Free for unprivileged users (statfs bavail) — usually a little less than freeBytes. */
  availableBytes: number;
  usedBytes: number;
  usedPct: number;
}

export interface MemoryUsage {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPct: number;
}

/** Cumulative CPU tick counters, so a usage percentage is a delta between two samples. */
export interface CpuTimes {
  user: number;
  nice: number;
  system: number;
  idle: number;
  iowait: number;
  irq: number;
  softirq: number;
  steal: number;
}

export interface CpuSample {
  cores: number;
  loadAvg: [number, number, number];
  times: CpuTimes;
  /** Which counter the ticks came from; deltas are only valid within one source. */
  source: "proc" | "os";
}

export interface CpuUsage {
  cores: number;
  loadAvg: [number, number, number];
  /** Percent of non-idle CPU between the two samples; null when only one sample was taken. */
  busyPct: number | null;
  sampleMs: number | null;
  source: "proc" | "os";
}

export interface CgroupMemory {
  version: "v2" | "v1" | "unavailable";
  /** null = no limit configured ("max"). */
  limitBytes: number | null;
  currentBytes: number | null;
}

export interface ProcessUsage {
  pid: number;
  command: string;
  state: string;
  rssBytes: number;
  /** utime + stime, in the kernel's tick units (cumulative since process start). */
  cpuTicks: number;
}

export interface DirectoryUsage {
  path: string;
  /** Recursive total of the regular files directly or indirectly under this directory. */
  bytes: number;
  files: number;
  depth: number;
}

export interface HostResourceSnapshot {
  collectedAt: string;
  host: string;
  disk: DiskUsage[];
  memory: MemoryUsage;
  cgroupMemory: CgroupMemory;
  cpu: CpuUsage;
  /** The busiest processes by resident memory, ranked descending and capped. */
  processes: ProcessUsage[];
  processCount: number;
}

function cpuTotal(t: CpuTimes): number {
  return t.user + t.nice + t.system + t.idle + t.iowait + t.irq + t.softirq + t.steal;
}

function cpuBusy(t: CpuTimes): number {
  // iowait is idle-ish: the CPU had nothing ready and waited on I/O.
  return cpuTotal(t) - t.idle - t.iowait;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/**
 * Parse the aggregate `cpu` line of `/proc/stat`. Tick units are the kernel's
 * `USER_HZ` (typically 100/s); only deltas between samples are meaningful.
 * Returns null when the file has no aggregate line (unexpected but possible).
 */
export function parseProcStat(text: string): CpuTimes | null {
  const line = text.split("\n").find((candidate) => candidate.startsWith("cpu "));
  if (!line) return null;
  const parts = line
    .trim()
    .split(/\s+/)
    .slice(1)
    .map((value) => Number.parseInt(value, 10));
  const at = (index: number): number => {
    const value = parts[index];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };
  return {
    user: at(0),
    nice: at(1),
    system: at(2),
    idle: at(3),
    iowait: at(4),
    irq: at(5),
    softirq: at(6),
    steal: at(7),
  };
}

/** Percent of CPU that was busy between two cumulative samples. */
export function cpuBusyPct(before: CpuTimes, after: CpuTimes): number {
  const dTotal = cpuTotal(after) - cpuTotal(before);
  const dBusy = cpuBusy(after) - cpuBusy(before);
  if (dTotal <= 0) return 0;
  return clampPercent((dBusy / dTotal) * 100);
}

export interface ParsedPidStat {
  pid: number;
  command: string;
  state: string;
  cpuTicks: number;
  vsizeBytes: number;
  rssPages: number;
}

/**
 * Parse one `/proc/<pid>/stat` line. The second field (`comm`) may contain
 * spaces and parentheses, so everything after the LAST `)` is the fixed-width
 * tail: tail[i] is field i+3, which puts utime at tail[11], stime at tail[12],
 * vsize at tail[20] and rss (in pages) at tail[21]. Returns null for a line
 * that does not look like a stat line (or a kernel thread with no comm).
 */
export function parseProcPidStat(text: string): ParsedPidStat | null {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close <= open) return null;
  const pid = Number.parseInt(text.slice(0, open).trim(), 10);
  if (!Number.isFinite(pid)) return null;
  const command = text.slice(open + 1, close);
  const tail = text
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const num = (index: number): number => {
    const value = Number.parseInt(tail[index] ?? "", 10);
    return Number.isFinite(value) ? value : 0;
  };
  return {
    pid,
    command,
    state: tail[0] ?? "?",
    cpuTicks: num(11) + num(12),
    vsizeBytes: num(20),
    rssPages: num(21),
  };
}

/**
 * cgroup v2 `memory.max`: a byte count, or the literal "max" for no limit.
 * Returns null for "no limit" and for anything unparseable.
 */
export function parseCgroupLimitV2(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed === "max") return null;
  const value = Number.parseInt(trimmed, 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * cgroup v1 `memory.limit_in_bytes`: a byte count, or a sentinel close to
 * LONG_MAX when the cgroup is unlimited. Anything above 1e15 is treated as
 * "no limit" rather than as a real number.
 */
export function parseCgroupLimitV1(text: string): number | null {
  const value = Number.parseInt(text.trim(), 10);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value > 1e15 ? null : value;
}

export function parseCgroupCurrent(text: string): number | null {
  const value = Number.parseInt(text.trim(), 10);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** Rank by resident memory, descending, then by pid for a stable order. */
/**
 * Read `VmRSS` from a `/proc/<pid>/status` file, in kibibytes. This is the
 * resident set size without needing the kernel's page size, so it is correct
 * on every architecture. Returns null when the line is absent or unreadable.
 */
export function parseProcStatusVmRssKb(text: string): number | null {
  const line = text.split("\n").find((candidate) => candidate.startsWith("VmRSS:"));
  if (!line) return null;
  const value = Number.parseInt(line.replace(/^VmRSS:\s*/, "").trim(), 10);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function rankProcesses(processes: ProcessUsage[], limit: number): ProcessUsage[] {
  return [...processes]
    .sort((a, b) => b.rssBytes - a.rssBytes || a.pid - b.pid)
    .slice(0, Math.max(0, limit));
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? String(Math.round(value)) : value.toFixed(1);
  return `${rounded} ${units[unit]}`;
}

export function formatPct(percent: number): string {
  return `${percent.toFixed(1)}%`;
}

export async function diskUsage(path: string, deps: HostResourceDeps): Promise<DiskUsage> {
  const stats = await deps.statfs(path);
  const blockSize = stats.bsize > 0 ? stats.bsize : 4096;
  const totalBytes = stats.blocks * blockSize;
  const freeBytes = stats.bfree * blockSize;
  const availableBytes = stats.bavail * blockSize;
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  const usedPct = totalBytes > 0 ? clampPercent((usedBytes / totalBytes) * 100) : 0;
  return { path, totalBytes, freeBytes, availableBytes, usedBytes, usedPct };
}

export function memoryUsage(): MemoryUsage {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  return {
    totalBytes,
    freeBytes,
    usedBytes,
    usedPct: totalBytes > 0 ? clampPercent((usedBytes / totalBytes) * 100) : 0,
  };
}

/**
 * One cumulative CPU sample. Prefers `/proc/stat`; falls back to `os.cpus()`
 * (whose times are milliseconds, so deltas are only compared within one source).
 */
export async function cpuSample(deps: HostResourceDeps): Promise<CpuSample> {
  try {
    const text = await deps.readText("/proc/stat");
    const times = parseProcStat(text);
    if (times) {
      return { cores: os.cpus().length, loadAvg: loadAverage(), times, source: "proc" };
    }
  } catch {
    // Fall through to os.cpus().
  }
  const times = os.cpus().reduce<CpuTimes>(
    (accumulator, cpu) => ({
      user: accumulator.user + cpu.times.user,
      nice: accumulator.nice + cpu.times.nice,
      system: accumulator.system + cpu.times.sys,
      idle: accumulator.idle + cpu.times.idle,
      iowait: accumulator.iowait + cpu.times.irq, // os.cpus() has no iowait; irq is the closest idle-adjacent field
      irq: 0,
      softirq: 0,
      steal: 0,
    }),
    { user: 0, nice: 0, system: 0, idle: 0, iowait: 0, irq: 0, softirq: 0, steal: 0 },
  );
  return { cores: os.cpus().length, loadAvg: loadAverage(), times, source: "os" };
}

function loadAverage(): [number, number, number] {
  const [one, five, fifteen] = os.loadavg();
  return [one ?? 0, five ?? 0, fifteen ?? 0];
}

export function cpuUsage(before: CpuSample, after: CpuSample, sampleMs: number): CpuUsage {
  const sameSource = before.source === after.source;
  const busyPct = sameSource && sampleMs > 0 ? cpuBusyPct(before.times, after.times) : null;
  return {
    cores: after.cores,
    loadAvg: after.loadAvg,
    busyPct,
    sampleMs: sampleMs > 0 ? sampleMs : null,
    source: after.source,
  };
}

/** Read the host cgroup's memory limit and current usage, v2 first, then v1. */
export async function cgroupMemory(deps: HostResourceDeps): Promise<CgroupMemory> {
  try {
    const [limitText, currentText] = await Promise.all([
      deps.readText("/sys/fs/cgroup/memory.max"),
      deps.readText("/sys/fs/cgroup/memory.current"),
    ]);
    return {
      version: "v2",
      limitBytes: parseCgroupLimitV2(limitText),
      currentBytes: parseCgroupCurrent(currentText),
    };
  } catch {
    // Fall through to v1.
  }
  try {
    const [limitText, currentText] = await Promise.all([
      deps.readText("/sys/fs/cgroup/memory/memory.limit_in_bytes"),
      deps.readText("/sys/fs/cgroup/memory/memory.usage_in_bytes"),
    ]);
    return {
      version: "v1",
      limitBytes: parseCgroupLimitV1(limitText),
      currentBytes: parseCgroupCurrent(currentText),
    };
  } catch {
    return { version: "unavailable", limitBytes: null, currentBytes: null };
  }
}

const PROC_SKIP = new Set(["self", "thread-self"]);

/** Every readable process's resident memory and cumulative CPU ticks. */
/** Fallback page size for a kernel that hides VmRSS; x86_64 and most arm64 use 4 KiB. */
const FALLBACK_PAGE_SIZE = 4096;

export async function processUsage(deps: HostResourceDeps): Promise<ProcessUsage[]> {
  let pids: string[];
  try {
    pids = await deps.listDir("/proc");
  } catch {
    return [];
  }
  const processes: ProcessUsage[] = [];
  for (const entry of pids) {
    if (PROC_SKIP.has(entry)) continue;
    if (!/^\d+$/.test(entry)) continue;
    try {
      const parsed = parseProcPidStat(await deps.readText(`/proc/${entry}/stat`));
      if (!parsed) continue;
      // VmRSS from status is in KiB and needs no page size; the stat page count
      // is only a fallback for a kernel that hides it.
      let rssBytes = parsed.rssPages * FALLBACK_PAGE_SIZE;
      try {
        const vmRssKb = parseProcStatusVmRssKb(await deps.readText(`/proc/${entry}/status`));
        if (vmRssKb !== null) rssBytes = vmRssKb * 1024;
      } catch {
        // status unreadable; keep the page-count estimate
      }
      processes.push({
        pid: parsed.pid,
        command: parsed.command,
        state: parsed.state,
        rssBytes,
        cpuTicks: parsed.cpuTicks,
      });
    } catch {
      // The process exited between listing and reading; skip it.
    }
  }
  return processes;
}

export interface LargestDirectoriesOptions {
  /** How deep to descend below each root. Default 3. */
  maxDepth?: number;
  /** Hard cap on directories visited, so a huge tree cannot run away. Default 20,000. */
  maxDirs?: number;
  /** Wall-clock budget for the whole walk. Default 5,000 ms. */
  deadlineMs?: number;
  /** Only return directories at least this large. Default 0. */
  minBytes?: number;
  /** How many directories to return. Default 25. */
  limit?: number;
}

/**
 * Rank directories under each root by recursive regular-file size, so the
 * report can say what is eating the space. Strictly read-only: it only ever
 * calls readdir + lstat, and it NEVER follows symlinks, so a symlinked tree
 * cannot make it wander off the host or double-count. Bounded by depth, by a
 * directory budget and by a deadline, then the walk simply reports less.
 */
export async function largestDirectories(
  roots: string[],
  deps: HostResourceDeps,
  options: LargestDirectoriesOptions = {},
): Promise<DirectoryUsage[]> {
  const maxDepth = options.maxDepth ?? 3;
  const maxDirs = options.maxDirs ?? 20_000;
  const deadline = deps.now() + (options.deadlineMs ?? 5_000);
  const minBytes = options.minBytes ?? 0;
  const limit = options.limit ?? 25;
  const found: DirectoryUsage[] = [];
  let visited = 0;

  async function walk(dir: string, depth: number): Promise<{ bytes: number; files: number }> {
    if (depth > maxDepth || visited >= maxDirs || deps.now() > deadline) {
      return { bytes: 0, files: 0 };
    }
    visited += 1;
    let entries: string[];
    try {
      entries = await deps.listDir(dir);
    } catch {
      return { bytes: 0, files: 0 };
    }
    let bytes = 0;
    let files = 0;
    for (const name of entries) {
      const full = path.join(dir, name);
      let stats: LstatLike;
      try {
        stats = await deps.lstat(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        const subtree = await walk(full, depth + 1);
        bytes += subtree.bytes;
        files += subtree.files;
      } else if (stats.isFile()) {
        bytes += stats.size;
        files += 1;
      }
    }
    if (depth >= 1) found.push({ path: dir, bytes, files, depth });
    return { bytes, files };
  }

  for (const root of roots) {
    await walk(root, 0);
  }
  return found
    .filter((entry) => entry.bytes >= minBytes)
    .sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path))
    .slice(0, limit);
}

export interface CollectOptions {
  /** Filesystems to report. Default ["/"]. */
  diskPaths?: string[];
  /** Interval between the two CPU samples. 0 skips the busy-percentage. Default 200. */
  cpuSampleMs?: number;
  /** How many top processes to keep. Default 15. */
  processLimit?: number;
}

/** Take one full read-only snapshot of the host. Never mutates anything. */
export async function collectHostResources(
  deps: HostResourceDeps,
  options: CollectOptions = {},
): Promise<HostResourceSnapshot> {
  const diskPaths = options.diskPaths ?? ["/"];
  const cpuSampleMs = options.cpuSampleMs ?? 200;
  const processLimit = options.processLimit ?? 15;

  const disk: DiskUsage[] = [];
  for (const diskPath of diskPaths) {
    try {
      disk.push(await diskUsage(diskPath, deps));
    } catch {
      // An unreadable filesystem is skipped, not fatal.
    }
  }

  const memory = memoryUsage();
  const cgroup = await cgroupMemory(deps);

  const firstSample = await cpuSample(deps);
  if (cpuSampleMs > 0) await deps.sleep(cpuSampleMs);
  const secondSample = cpuSampleMs > 0 ? await cpuSample(deps) : firstSample;
  const cpu = cpuUsage(firstSample, secondSample, cpuSampleMs);

  const allProcesses = await processUsage(deps);

  return {
    collectedAt: new Date(deps.now()).toISOString(),
    host: deps.hostname(),
    disk,
    memory,
    cgroupMemory: cgroup,
    cpu,
    processes: rankProcesses(allProcesses, processLimit),
    processCount: allProcesses.length,
  };
}

/** One line per disk, e.g. `/: 787.0 GiB total, 184.9 GiB free (23.5% free)`. */
export function formatDisk(disk: DiskUsage[]): string {
  return disk
    .map(
      (entry) =>
        `${entry.path}: ${formatBytes(entry.totalBytes)} total, ${formatBytes(entry.freeBytes)} free (${formatPct(
          100 - entry.usedPct,
        )} free, ${formatPct(entry.usedPct)} used)`,
    )
    .join("\n");
}

export function formatMemory(snapshot: HostResourceSnapshot): string {
  const memory = snapshot.memory;
  const cgroup = snapshot.cgroupMemory;
  const limitText = cgroup.limitBytes === null ? "max" : formatBytes(cgroup.limitBytes);
  const cgroupText =
    cgroup.version === "unavailable"
      ? "cgroup: unavailable"
      : `cgroup ${cgroup.version}: limit ${limitText}, current ${formatBytes(cgroup.currentBytes ?? 0)}`;
  return [
    `memory: ${formatBytes(memory.totalBytes)} total, ${formatBytes(memory.freeBytes)} free (${formatPct(
      memory.usedPct,
    )} used)`,
    cgroupText,
    `cpu: ${snapshot.cpu.cores} cores, loadavg ${snapshot.cpu.loadAvg.map((value) => value.toFixed(2)).join(" ")}`,
    `cpu busy: ${snapshot.cpu.busyPct === null ? "n/a" : formatPct(snapshot.cpu.busyPct)} (source ${snapshot.cpu.source})`,
  ].join("\n");
}

export function formatProcesses(processes: ProcessUsage[]): string {
  if (processes.length === 0) return "processes: none readable";
  return [
    `top ${processes.length} processes by RSS (of the host):`,
    ...processes.map(
      (process, index) =>
        `${index + 1}. [${process.pid}] ${process.command} — RSS ${formatBytes(process.rssBytes)}, cpu ${process.cpuTicks} ticks, state ${process.state}`,
    ),
  ].join("\n");
}

export function formatDirectories(directories: DirectoryUsage[], root: string): string {
  if (directories.length === 0) return `largest directories under ${root}: none readable`;
  return [
    `largest directories under ${root}:`,
    ...directories.map(
      (entry) =>
        `${entry.path} — ${formatBytes(entry.bytes)} in ${entry.files} files (depth ${entry.depth})`,
    ),
  ].join("\n");
}
