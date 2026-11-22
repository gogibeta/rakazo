import { describe, expect, it } from "vitest";
import type { CpuTimes, HostResourceDeps } from "./host-resources.js";
import {
  cgroupMemory,
  collectHostResources,
  cpuBusyPct,
  diskUsage,
  formatBytes,
  formatDirectories,
  formatDisk,
  formatMemory,
  formatPct,
  formatProcesses,
  largestDirectories,
  parseCgroupCurrent,
  parseCgroupLimitV1,
  parseCgroupLimitV2,
  parseProcPidStat,
  parseProcStat,
  parseProcStatusVmRssKb,
  processUsage,
  rankProcesses,
} from "./host-resources.js";

interface FakeFs {
  dirs?: Record<string, string[]>;
  files?: Record<string, number>;
  links?: string[];
  texts?: Record<string, string>;
  statfs?: Record<string, { blocks: number; bsize: number; bfree: number; bavail: number }>;
  hostname?: string;
  now?: number;
}

/** A hermetic stand-in for /proc, /sys and the filesystem the collector reads. */
function makeDeps(options: FakeFs = {}): HostResourceDeps {
  const dirs = options.dirs ?? {};
  const files = options.files ?? {};
  const links = new Set(options.links ?? []);
  const texts = options.texts ?? {};
  const statfsMap = options.statfs ?? {};
  const missing = (p: string): Error => new Error(`ENOENT: ${p}`);
  return {
    readText: async (p) => {
      const value = texts[p];
      if (value !== undefined) return value;
      throw missing(p);
    },
    statfs: async (p) => {
      const value = statfsMap[p];
      if (value !== undefined) return value;
      throw missing(p);
    },
    listDir: async (p) => {
      const value = dirs[p];
      if (value !== undefined) return value;
      throw missing(p);
    },
    lstat: async (p) => {
      if (links.has(p)) {
        return {
          isDirectory: () => false,
          isFile: () => false,
          isSymbolicLink: () => true,
          size: 0,
        };
      }
      if (dirs[p] !== undefined) {
        return {
          isDirectory: () => true,
          isFile: () => false,
          isSymbolicLink: () => false,
          size: 0,
        };
      }
      const size = files[p];
      if (size !== undefined) {
        return { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, size };
      }
      throw missing(p);
    },
    hostname: () => options.hostname ?? "test-host",
    now: () => options.now ?? 1_700_000_000_000,
    sleep: async () => {},
  };
}

const IDLE: CpuTimes = {
  user: 0,
  nice: 0,
  system: 0,
  idle: 100,
  iowait: 0,
  irq: 0,
  softirq: 0,
  steal: 0,
};

describe("parseProcStat", () => {
  it("parses the aggregate cpu line", () => {
    const text = "cpu  100 10 200 1000 50 3 4 5 0 0\ncpu0 1 0 2 3 4 0 0 0 0 0\n";
    expect(parseProcStat(text)).toEqual({
      user: 100,
      nice: 10,
      system: 200,
      idle: 1000,
      iowait: 50,
      irq: 3,
      softirq: 4,
      steal: 5,
    });
  });

  it("tolerates a truncated aggregate line", () => {
    expect(parseProcStat("cpu  5 0 0 9\n")).toEqual({
      user: 5,
      nice: 0,
      system: 0,
      idle: 9,
      iowait: 0,
      irq: 0,
      softirq: 0,
      steal: 0,
    });
  });

  it("returns null when there is no aggregate cpu line", () => {
    expect(parseProcStat("cpu0 1 2 3 4 5 6 7 8 9\nintr 1\n")).toBeNull();
  });
});

describe("cpuBusyPct", () => {
  it("computes the busy share of the delta, excluding idle and iowait", () => {
    const after: CpuTimes = {
      user: 60,
      nice: 0,
      system: 20,
      idle: 120,
      iowait: 0,
      irq: 0,
      softirq: 0,
      steal: 0,
    };
    // delta total 100, delta busy 80 → 80%.
    expect(cpuBusyPct(IDLE, after)).toBeCloseTo(80, 5);
  });

  it("counts iowait as idle, not busy", () => {
    const after: CpuTimes = {
      user: 0,
      nice: 0,
      system: 0,
      idle: 100,
      iowait: 100,
      irq: 0,
      softirq: 0,
      steal: 0,
    };
    expect(cpuBusyPct(IDLE, after)).toBe(0);
  });

  it("returns 0 when the counters did not advance", () => {
    expect(cpuBusyPct(IDLE, IDLE)).toBe(0);
  });

  it("never leaves the 0..100 range", () => {
    const after: CpuTimes = {
      user: 0,
      nice: 0,
      system: 0,
      idle: 0,
      iowait: 0,
      irq: 0,
      softirq: 0,
      steal: 0,
    };
    expect(cpuBusyPct({ ...IDLE, idle: 200 }, after)).toBe(0);
  });
});

describe("parseProcPidStat", () => {
  it("parses a command that contains spaces and parentheses", () => {
    // tail[i] is field i+3: utime=field14→tail[11]=40, stime=field15→tail[12]=5,
    // vsize=field23→tail[20]=1700000, rss=field24→tail[21]=123.
    const line = "1234 (node server) S 1 2 3 4 5 6 7 8 9 10 40 5 0 0 0 0 0 0 0 1700000 123";
    expect(parseProcPidStat(line)).toEqual({
      pid: 1234,
      command: "node server",
      state: "S",
      cpuTicks: 45,
      vsizeBytes: 1_700_000,
      rssPages: 123,
    });
  });

  it("returns null for a line with no command field", () => {
    expect(parseProcPidStat("1234 S 1 2 3")).toBeNull();
    expect(parseProcPidStat("not a stat line")).toBeNull();
  });

  it("treats missing numeric fields as zero rather than NaN", () => {
    const parsed = parseProcPidStat("9 (short) S");
    expect(parsed).not.toBeNull();
    expect(parsed?.cpuTicks).toBe(0);
    expect(parsed?.rssPages).toBe(0);
  });
});

describe("cgroup parsers", () => {
  it("v2 limit: a number parses, 'max' and garbage mean no limit", () => {
    expect(parseCgroupLimitV2("8589934592\n")).toBe(8_589_934_592);
    expect(parseCgroupLimitV2("max\n")).toBeNull();
    expect(parseCgroupLimitV2("")).toBeNull();
    expect(parseCgroupLimitV2("nonsense")).toBeNull();
  });

  it("v1 limit: the unlimited sentinel is not mistaken for a real number", () => {
    expect(parseCgroupLimitV1("4294967296\n")).toBe(4_294_967_296);
    expect(parseCgroupLimitV1("9223372036854771712\n")).toBeNull();
  });

  it("current usage parses, negatives do not", () => {
    expect(parseCgroupCurrent("12345\n")).toBe(12_345);
    expect(parseCgroupCurrent("-1\n")).toBeNull();
    expect(parseCgroupCurrent("junk")).toBeNull();
  });
});

describe("parseProcStatusVmRssKb", () => {
  it("reads the VmRSS line in kibibytes", () => {
    expect(parseProcStatusVmRssKb("Name:\tnode\nVmRSS:\t2048 kB\nVmPeak:\t4096 kB\n")).toBe(2048);
  });

  it("returns null when VmRSS is absent or malformed", () => {
    expect(parseProcStatusVmRssKb("Name:\tnode\n")).toBeNull();
    expect(parseProcStatusVmRssKb("VmRSS:\tjunk\n")).toBeNull();
    expect(parseProcStatusVmRssKb("VmRSS:\t-4 kB\n")).toBeNull();
  });
});

describe("rankProcesses", () => {
  const list = [
    { pid: 3, command: "c", state: "S", rssBytes: 5, cpuTicks: 1 },
    { pid: 1, command: "a", state: "S", rssBytes: 9, cpuTicks: 1 },
    { pid: 2, command: "b", state: "S", rssBytes: 9, cpuTicks: 1 },
  ];

  it("ranks by resident memory descending, ties broken by pid", () => {
    expect(rankProcesses(list, 3).map((p) => p.pid)).toEqual([1, 2, 3]);
  });

  it("caps the list", () => {
    expect(rankProcesses(list, 2)).toHaveLength(2);
    expect(rankProcesses(list, 0)).toEqual([]);
  });
});

describe("formatBytes / formatPct", () => {
  it("formats byte magnitudes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KiB");
    expect(formatBytes(5 * 1024 ** 3)).toBe("5.0 GiB");
    expect(formatBytes(3 * 1024 ** 4)).toBe("3.0 TiB");
  });

  it("does not invent a size for a non-number", () => {
    expect(formatBytes(Number.NaN)).toBe("?");
    expect(formatBytes(-5)).toBe("?");
  });

  it("formats percentages with one decimal", () => {
    expect(formatPct(23.456)).toBe("23.5%");
    expect(formatPct(0)).toBe("0.0%");
  });
});

describe("diskUsage", () => {
  it("derives total, free, used and percentage from statfs", async () => {
    const deps = makeDeps({
      statfs: { "/": { blocks: 1_000, bsize: 4_096, bfree: 250, bavail: 200 } },
    });
    expect(await diskUsage("/", deps)).toEqual({
      path: "/",
      totalBytes: 4_096_000,
      freeBytes: 1_024_000,
      availableBytes: 819_200,
      usedBytes: 3_072_000,
      usedPct: 75,
    });
  });
});

describe("cgroupMemory", () => {
  it("reads cgroup v2 when memory.max is present", async () => {
    const deps = makeDeps({
      texts: {
        "/sys/fs/cgroup/memory.max": "max\n",
        "/sys/fs/cgroup/memory.current": "1073741824\n",
      },
    });
    expect(await cgroupMemory(deps)).toEqual({
      version: "v2",
      limitBytes: null,
      currentBytes: 1_073_741_824,
    });
  });

  it("falls back to cgroup v1", async () => {
    const deps = makeDeps({
      texts: {
        "/sys/fs/cgroup/memory/memory.limit_in_bytes": "4294967296\n",
        "/sys/fs/cgroup/memory/memory.usage_in_bytes": "1024\n",
      },
    });
    expect(await cgroupMemory(deps)).toEqual({
      version: "v1",
      limitBytes: 4_294_967_296,
      currentBytes: 1024,
    });
  });

  it("reports unavailable when neither version is mounted", async () => {
    expect(await cgroupMemory(makeDeps())).toEqual({
      version: "unavailable",
      limitBytes: null,
      currentBytes: null,
    });
  });
});

describe("processUsage", () => {
  it("reads every numeric pid, taking resident memory from VmRSS", async () => {
    const deps = makeDeps({
      dirs: { "/proc": ["1", "2", "42", "self", "thread-self", "not-a-pid", "irq"] },
      texts: {
        "/proc/1/stat": "1 (init) S 0 1 1 0 -1 0 0 0 0 0 10 5 0 0 0 0 0 0 0 0 1000 4",
        "/proc/1/status": "Name:\tinit\nVmRSS:\t100 kB\n",
        "/proc/42/stat": "42 (worker) R 1 2 2 0 -1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 2000 512",
        "/proc/42/status": "Name:\tworker\nVmRSS:\t2048 kB\n",
      },
    });
    const processes = await processUsage(deps);
    expect(processes).toEqual([
      { pid: 1, command: "init", state: "S", rssBytes: 102_400, cpuTicks: 15 },
      { pid: 42, command: "worker", state: "R", rssBytes: 2_097_152, cpuTicks: 0 },
    ]);
  });

  it("falls back to the stat page count when status hides VmRSS", async () => {
    const deps = makeDeps({
      dirs: { "/proc": ["9"] },
      texts: { "/proc/9/stat": "9 (fallback) S 0 1 1 0 -1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 3" },
    });
    // 3 pages x 4096 fallback page size.
    expect(await processUsage(deps)).toEqual([
      { pid: 9, command: "fallback", state: "S", rssBytes: 12_288, cpuTicks: 0 },
    ]);
  });

  it("returns an empty list when /proc is unreadable", async () => {
    expect(await processUsage(makeDeps())).toEqual([]);
  });
});

describe("largestDirectories", () => {
  it("aggregates recursive file sizes per directory and ranks them", async () => {
    const deps = makeDeps({
      dirs: { "/a": ["big", "small", "link"], "/a/big": ["f1", "f2"], "/a/small": ["f3"] },
      files: { "/a/big/f1": 500, "/a/big/f2": 300, "/a/small/f3": 10 },
      links: ["/a/link"],
    });
    const found = await largestDirectories(["/a"], deps, { maxDepth: 3 });
    expect(found).toEqual([
      { path: "/a/big", bytes: 800, files: 2, depth: 1 },
      { path: "/a/small", bytes: 10, files: 1, depth: 1 },
    ]);
  });

  it("never follows symlinks", async () => {
    // /a/escape is a symlink; if it were followed, /elsewhere/f would be counted under /a.
    const deps = makeDeps({
      dirs: { "/a": ["escape"], "/elsewhere": ["f"] },
      files: { "/elsewhere/f": 9_999 },
      links: ["/a/escape"],
    });
    const found = await largestDirectories(["/a"], deps, { maxDepth: 3 });
    expect(found).toEqual([]);
  });

  it("honours the directory budget", async () => {
    const deps = makeDeps({
      dirs: { "/a": ["b", "c"], "/a/b": [], "/a/c": [] },
      files: { "/a/b/f": 1, "/a/c/f": 2 },
    });
    const found = await largestDirectories(["/a"], deps, { maxDepth: 2, maxDirs: 2 });
    // With only 2 directory visits allowed, the walk stops early and reports less.
    expect(found.length).toBeLessThanOrEqual(2);
  });

  it("keeps the deepest useful level, not the root", async () => {
    const deps = makeDeps({
      dirs: { "/a": ["b"], "/a/b": ["f"] },
      files: { "/a/b/f": 7 },
    });
    const found = await largestDirectories(["/a"], deps, { maxDepth: 2 });
    expect(found.map((entry) => entry.path)).toEqual(["/a/b"]);
  });
});

describe("collectHostResources", () => {
  it("assembles one read-only snapshot from disk, memory, cgroup, cpu and processes", async () => {
    const deps = makeDeps({
      statfs: { "/": { blocks: 1_000, bsize: 4_096, bfree: 250, bavail: 200 } },
      texts: {
        "/proc/stat": "cpu  0 0 0 100 0 0 0 0 0 0\ncpu0 0 0 0 100 0 0 0 0 0 0\n",
        "/sys/fs/cgroup/memory.max": "4294967296\n",
        "/sys/fs/cgroup/memory.current": "1024\n",
        "/proc/7/stat": "7 (node) S 1 2 3 4 5 6 7 8 9 10 1 1 0 0 0 0 0 0 0 0 100",
        "/proc/7/status": "Name:\tnode\nVmRSS:\t2048 kB\n",
      },
      dirs: { "/proc": ["7"] },
      files: {},
      hostname: "baseline-box",
    });
    const snapshot = await collectHostResources(deps, { cpuSampleMs: 0, processLimit: 10 });
    expect(snapshot.host).toBe("baseline-box");
    expect(snapshot.collectedAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(snapshot.disk).toHaveLength(1);
    expect(snapshot.disk[0]?.usedPct).toBe(75);
    expect(snapshot.cgroupMemory).toEqual({
      version: "v2",
      limitBytes: 4_294_967_296,
      currentBytes: 1024,
    });
    // One sample only: no busy percentage, but the load and core counts are there.
    expect(snapshot.cpu.busyPct).toBeNull();
    expect(snapshot.cpu.source).toBe("proc");
    expect(snapshot.processes).toHaveLength(1);
    expect(snapshot.processes[0]?.command).toBe("node");
    expect(snapshot.processCount).toBe(1);
    // Memory comes from the real os module; assert invariants rather than exact values.
    expect(snapshot.memory.totalBytes).toBeGreaterThan(0);
    expect(snapshot.memory.usedBytes).toBe(snapshot.memory.totalBytes - snapshot.memory.freeBytes);
    expect(snapshot.memory.usedPct).toBeGreaterThanOrEqual(0);
    expect(snapshot.memory.usedPct).toBeLessThanOrEqual(100);
  });

  it("skips an unreadable filesystem instead of failing the snapshot", async () => {
    const deps = makeDeps({ texts: {}, dirs: { "/proc": [] } });
    const snapshot = await collectHostResources(deps, {
      diskPaths: ["/", "/mnt/missing"],
      cpuSampleMs: 0,
    });
    expect(snapshot.disk).toEqual([]);
    expect(snapshot.processes).toEqual([]);
  });
});

describe("formatters", () => {
  it("renders the disk, memory and process sections readably", () => {
    const deps = makeDeps({
      statfs: { "/": { blocks: 1_000, bsize: 4_096, bfree: 250, bavail: 200 } },
      texts: {
        "/proc/stat": "cpu  0 0 0 100 0 0 0 0 0 0\n",
        "/sys/fs/cgroup/memory.max": "max\n",
        "/sys/fs/cgroup/memory.current": "0\n",
      },
      dirs: { "/proc": [] },
    });
    return (async () => {
      const snapshot = await collectHostResources(deps, { cpuSampleMs: 0 });
      expect(formatDisk(snapshot.disk)).toContain("75.0% used");
      const memoryText = formatMemory(snapshot);
      expect(memoryText).toContain("cgroup v2: limit max");
      expect(memoryText).toContain("cpu busy: n/a");
      expect(formatProcesses([])).toContain("none readable");
      expect(formatDirectories([], "/")).toContain("none readable");
      expect(
        formatProcesses([{ pid: 1, command: "init", state: "S", rssBytes: 1024, cpuTicks: 3 }]),
      ).toContain("[1] init — RSS 1.0 KiB");
    })();
  });
});
