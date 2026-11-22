import { withKeyedLock } from "./supervisor-logic.js";

const botLifecycleLocks = new Map<string, Promise<unknown>>();
const computerScreenLocks = new Map<string, Promise<unknown>>();
const spaceComputerLocks = new Map<string, Promise<unknown>>();
const ramAdmissionLocks = new Map<string, Promise<unknown>>();
// Single key: the RAM budget is host-wide, so admission is one global critical section.
const RAM_ADMISSION_KEY = "host";

// Serialize create/delete for one bot so DELETE cannot remove a per-bot network
// while POST still needs it between ensureBotNetwork and container attach.
export async function withBotLifecycleLock<T>(botId: string, task: () => Promise<T>): Promise<T> {
  return withKeyedLock(botLifecycleLocks, botId, task);
}

// Serialize screen claim/release/cancel for one computer so a restart-orphan
// cancel cannot race a replacement claim and kill the newer Chromium session.
export async function withComputerScreenLock<T>(
  computerId: string,
  task: () => Promise<T>,
): Promise<T> {
  return withKeyedLock(computerScreenLocks, computerId, task);
}

// Serialize per-space create admission (count + create) so different bots cannot
// race past SANDBOX_MAX_COMPUTERS_PER_SPACE. Callers must already hold the bot
// lifecycle lock; never acquire a bot lock while holding this lock.
export async function withSpaceComputerLock<T>(
  spaceId: string,
  task: () => Promise<T>,
): Promise<T> {
  return withKeyedLock(spaceComputerLocks, spaceId, task);
}

// Serialize the host-wide RAM admission count+create so two Spaces admitting at
// the same time cannot each see a free slot and both create, oversubscribing the
// host. Always the innermost lock: never take a bot or Space lock while holding it.
export async function withRamAdmissionLock<T>(task: () => Promise<T>): Promise<T> {
  return withKeyedLock(ramAdmissionLocks, RAM_ADMISSION_KEY, task);
}
