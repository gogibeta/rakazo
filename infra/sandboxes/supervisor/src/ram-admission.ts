import os from "node:os";
import { computerResourceLimits, parseMemoryBytes } from "./computer-spec.js";

/**
 * Host-wide RAM admission budget for bot computers.
 *
 * The per-container limits (api 1.5 + worker 2 + vault 0.5 + web 0.5 +
 * supervisor 0.5 + postgres 2 GiB) already sum to 7.0 GiB on a 7,964 MB host,
 * and every bot computer adds its own cap on top. Left unchecked that is an
 * over-commit: enough simultaneous bots can push the host into the OOM killer,
 * which takes down services rather than just one bot.
 *
 * The budget therefore admits a computer only while
 *
 *   concurrent Computers x computer cap + measured service peaks + host reserve
 *     <= physical RAM
 *
 * so the computer cap is derived from what the host can actually hold, not from
 * how many bots a Space allows.
 *
 * The budget is OFF until the measured service peaks are configured. Those
 * peaks are a live-host measurement (see M5: api ~596 MB and worker ~414 MB are
 * known, but vault / web / supervisor / postgres are not yet measured), and
 * guessing them here would hard-code a safety-critical number. Set
 * RAKAZO_SERVICE_MEMORY_PEAKS (or RAKAZO_MAX_CONCURRENT_COMPUTERS) to turn the
 * budget on once the live figures are known.
 */

const DEFAULT_HOST_RESERVE_MEMORY = "1g";

/** An unset variable and one present but blank both mean "use the default". */
function envValue(name: string): string | undefined {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === "" ? undefined : raw.trim();
}

function parseCount(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, received "${raw}"`);
  }
  return value;
}

/** Physical RAM the budget is measured against, in bytes. */
export function resolveHostPhysicalMemoryBytes(): number {
  const configured = envValue("RAKAZO_HOST_PHYSICAL_MEMORY");
  if (configured !== undefined) {
    return parseMemoryBytes("RAKAZO_HOST_PHYSICAL_MEMORY", configured);
  }
  // Docker's os.totalmem() reports the host, not this container's limit, which
  // is the right denominator: the computers and services share one physical host.
  const total = os.totalmem();
  if (!Number.isSafeInteger(total) || total <= 0) {
    throw new Error("os.totalmem() did not report a usable physical memory size");
  }
  return total;
}

/** Memory the services need at their measured peaks, in bytes, or 0 if unconfigured. */
export function resolveServiceMemoryPeaksBytes(): number {
  const configured = envValue("RAKAZO_SERVICE_MEMORY_PEAKS");
  if (configured === undefined) return 0;
  return parseMemoryBytes("RAKAZO_SERVICE_MEMORY_PEAKS", configured);
}

/** Memory held back for the host itself (kernel, page cache headroom, sshd, ...). */
export function resolveHostReserveMemoryBytes(): number {
  const configured = envValue("RAKAZO_HOST_RESERVE_MEMORY");
  return parseMemoryBytes("RAKAZO_HOST_RESERVE_MEMORY", configured ?? DEFAULT_HOST_RESERVE_MEMORY);
}

/**
 * The largest number of computers the host can hold at once, or 0 when the
 * budget is not configured (the budget is opt-in until the service peaks are
 * measured) or when the configured figures cannot admit even one computer.
 */
export function resolveRamAdmissionLimit(): number {
  const explicit = envValue("RAKAZO_MAX_CONCURRENT_COMPUTERS");
  if (explicit !== undefined) {
    return parseCount("RAKAZO_MAX_CONCURRENT_COMPUTERS", explicit);
  }

  const servicePeaksBytes = resolveServiceMemoryPeaksBytes();
  // Unconfigured peaks mean the budget is not in force, not that the host is
  // unlimited: the per-Space cap still applies on its own.
  if (servicePeaksBytes === 0) return 0;

  const computerCapBytes = computerResourceLimits().Memory;
  // A computer without a memory cap cannot be bounded, so no budget can hold.
  if (computerCapBytes === 0) return 0;

  const physicalBytes = resolveHostPhysicalMemoryBytes();
  const reserveBytes = resolveHostReserveMemoryBytes();
  const budgetBytes = physicalBytes - servicePeaksBytes - reserveBytes;
  if (budgetBytes <= 0) return 0;

  return Math.floor(budgetBytes / computerCapBytes);
}
