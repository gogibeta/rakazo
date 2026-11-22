import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveHostPhysicalMemoryBytes,
  resolveHostReserveMemoryBytes,
  resolveRamAdmissionLimit,
  resolveServiceMemoryPeaksBytes,
} from "./ram-admission.js";

const GIB = 1024 ** 3;

const OVERRIDES = [
  "RAKAZO_HOST_PHYSICAL_MEMORY",
  "RAKAZO_SERVICE_MEMORY_PEAKS",
  "RAKAZO_HOST_RESERVE_MEMORY",
  "RAKAZO_MAX_CONCURRENT_COMPUTERS",
  "RAKAZO_COMPUTER_MEMORY",
] as const;

const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const name of OVERRIDES) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
});

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("resolveRamAdmissionLimit", () => {
  it("is off until the measured service peaks are configured", () => {
    // No fabricated default: the peaks are a live-host measurement (M5), and the
    // budget must not pretend to know them.
    expect(resolveRamAdmissionLimit()).toBe(0);
  });

  it("admits floor((physical - peaks - reserve) / computer cap) computers", () => {
    process.env.RAKAZO_HOST_PHYSICAL_MEMORY = `${8 * GIB}`;
    process.env.RAKAZO_SERVICE_MEMORY_PEAKS = `${1 * GIB}`;
    process.env.RAKAZO_HOST_RESERVE_MEMORY = `${1 * GIB}`;
    process.env.RAKAZO_COMPUTER_MEMORY = "2g";
    // (8 GiB - 1 GiB - 1 GiB) / 2 GiB = 3
    expect(resolveRamAdmissionLimit()).toBe(3);
  });

  it("floors a partial remaining budget rather than rounding up", () => {
    process.env.RAKAZO_HOST_PHYSICAL_MEMORY = `${8 * GIB}`;
    process.env.RAKAZO_SERVICE_MEMORY_PEAKS = `${2 * GIB}`;
    process.env.RAKAZO_HOST_RESERVE_MEMORY = `${1 * GIB}`;
    process.env.RAKAZO_COMPUTER_MEMORY = "2g";
    // (8 - 2 - 1) / 2 = 2.5 -> 2: a half-affordable computer is not affordable.
    expect(resolveRamAdmissionLimit()).toBe(2);
  });

  it("admits nothing when the services and reserve already exhaust the host", () => {
    process.env.RAKAZO_HOST_PHYSICAL_MEMORY = `${8 * GIB}`;
    process.env.RAKAZO_SERVICE_MEMORY_PEAKS = `${8 * GIB}`;
    process.env.RAKAZO_COMPUTER_MEMORY = "2g";
    expect(resolveRamAdmissionLimit()).toBe(0);
  });

  it("is off when computers have no memory cap to budget against", () => {
    process.env.RAKAZO_HOST_PHYSICAL_MEMORY = `${8 * GIB}`;
    process.env.RAKAZO_SERVICE_MEMORY_PEAKS = `${1 * GIB}`;
    process.env.RAKAZO_COMPUTER_MEMORY = "0";
    expect(resolveRamAdmissionLimit()).toBe(0);
  });

  it("lets an explicit concurrency cap override the formula", () => {
    process.env.RAKAZO_MAX_CONCURRENT_COMPUTERS = "5";
    expect(resolveRamAdmissionLimit()).toBe(5);
  });

  it("rejects a non-positive or non-integer explicit cap", () => {
    process.env.RAKAZO_MAX_CONCURRENT_COMPUTERS = "0";
    expect(() => resolveRamAdmissionLimit()).toThrow(/positive integer/);
    process.env.RAKAZO_MAX_CONCURRENT_COMPUTERS = "2.5";
    expect(() => resolveRamAdmissionLimit()).toThrow(/positive integer/);
  });
});

describe("resolveServiceMemoryPeaksBytes", () => {
  it("is 0 when unconfigured and parses a docker-style size", () => {
    expect(resolveServiceMemoryPeaksBytes()).toBe(0);
    process.env.RAKAZO_SERVICE_MEMORY_PEAKS = "1536m";
    expect(resolveServiceMemoryPeaksBytes()).toBe(1536 * 1024 ** 2);
  });

  it("refuses a value that is not a size", () => {
    process.env.RAKAZO_SERVICE_MEMORY_PEAKS = "a lot";
    expect(() => resolveServiceMemoryPeaksBytes()).toThrow(/must be a size/);
  });
});

describe("resolveHostPhysicalMemoryBytes", () => {
  it("prefers the configured figure over os.totalmem()", () => {
    process.env.RAKAZO_HOST_PHYSICAL_MEMORY = "7964m";
    expect(resolveHostPhysicalMemoryBytes()).toBe(7964 * 1024 ** 2);
  });

  it("falls back to a positive host figure when unconfigured", () => {
    expect(resolveHostPhysicalMemoryBytes()).toBeGreaterThan(0);
  });
});

describe("resolveHostReserveMemoryBytes", () => {
  it("defaults to 1 GiB held back for the host itself", () => {
    expect(resolveHostReserveMemoryBytes()).toBe(1 * GIB);
    process.env.RAKAZO_HOST_RESERVE_MEMORY = "512m";
    expect(resolveHostReserveMemoryBytes()).toBe(512 * 1024 ** 2);
  });
});
