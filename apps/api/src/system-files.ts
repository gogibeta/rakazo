import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, open, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ORPCError } from "@orpc/server";
import type {
  Actor,
  SystemFileEntry,
  SystemFilesList,
  SystemFilesListInput,
  SystemFilesRead,
  SystemFilesReadInput,
  SystemFilesStatus,
  SystemFilesWrite,
  SystemFilesWriteInput,
} from "@rakazo/contracts";
import { SYSTEM_FILES_MAX_BYTES, SYSTEM_FILES_MAX_ENTRIES } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { requireAdmin } from "./admins.js";
import type { RouterDeps } from "./router.js";

export interface SystemFilesDeps {
  prisma: PrismaClient;
  env: Pick<RouterDeps["env"], "adminEmails" | "systemFilesRoot">;
}

/**
 * Extensions that are never treated as text, whatever their bytes say. The
 * content sniff below catches the rest; this list only short-circuits the
 * common binary formats so they are never read into the editor at all.
 */
const BINARY_EXTENSIONS = new Set([
  ".7z",
  ".a",
  ".avi",
  ".bin",
  ".bmp",
  ".class",
  ".db",
  ".dll",
  ".dylib",
  ".eot",
  ".exe",
  ".gif",
  ".gz",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".mkv",
  ".mov",
  ".mp3",
  ".mp4",
  ".o",
  ".otf",
  ".pdf",
  ".png",
  ".pyc",
  ".so",
  ".sqlite",
  ".sqlite3",
  ".tar",
  ".ttf",
  ".war",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".zip",
]);

/** The configured root, or null when the feature is off. */
function configuredRoot(deps: SystemFilesDeps): string | null {
  const root = deps.env.systemFilesRoot?.trim();
  return root ? root : null;
}

function isInsideRoot(rootReal: string, candidate: string): boolean {
  return candidate === rootReal || candidate.startsWith(rootReal + path.sep);
}

function outsideRoot() {
  return new ORPCError("FORBIDDEN", { message: "That path is outside the system files root" });
}

/**
 * Whether one path segment names a secret this surface never serves: env
 * files and private keys hold the deployment's credentials, and the file
 * editor is not a secrets manager. Matching is case-insensitive on a single
 * segment: ".env" and its ".env." variants and backups, any name ending in
 * ".env", key material (".pem"/".key" files, "id_rsa*"/"id_ed25519*"), the
 * credential files ".npmrc"/".netrc", and the credential folders ".ssh",
 * ".aws" and ".gnupg". Ordinary names that merely contain these letters
 * ("env.ts", "environment.md", "monkey.env.txt") do not match.
 */
function isSecretSegment(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.startsWith(".env.") ||
    lower.endsWith(".env") ||
    lower.endsWith(".pem") ||
    lower.endsWith(".key") ||
    lower.startsWith("id_rsa") ||
    lower.startsWith("id_ed25519") ||
    lower === ".npmrc" ||
    lower === ".netrc" ||
    lower === ".ssh" ||
    lower === ".aws" ||
    lower === ".gnupg"
  );
}

function secretPath() {
  return new ORPCError("FORBIDDEN", { message: "That file is not available in system files" });
}

/** Refuses a client-supplied relative path that names a secret at any segment. */
function assertNoSecretSegments(input: string): void {
  for (const segment of input.split(/[\\/]+/)) {
    if (segment && isSecretSegment(segment)) throw secretPath();
  }
}

/** True when any root-relative segment of a resolved path names a secret. */
function resolvedIsSecret(rootReal: string, resolved: string): boolean {
  const relative = path.relative(rootReal, resolved);
  return relative !== "" && relative.split(path.sep).some(isSecretSegment);
}

/**
 * Refuses a resolved path that lands on a secret under an innocent name —
 * a symlink inside the root pointing at the root's own ".env", say.
 */
function assertResolvedNotSecret(rootReal: string, resolved: string): void {
  if (resolvedIsSecret(rootReal, resolved)) throw secretPath();
}

/** The root as a real directory; a configured-but-missing root reads as not found. */
async function realRoot(root: string): Promise<string> {
  let resolved: string;
  try {
    resolved = await realpath(root);
  } catch {
    throw new ORPCError("NOT_FOUND", { message: "The system files root is not available" });
  }
  const info = await stat(resolved).catch(() => null);
  if (!info?.isDirectory()) {
    throw new ORPCError("NOT_FOUND", { message: "The system files root is not available" });
  }
  return resolved;
}

/**
 * Checks the shape of a client-supplied relative path before it touches the
 * filesystem: no NUL bytes, never absolute. ".." segments are left in place
 * here; the realpath containment check after resolution is what refuses
 * them, so symlink escapes are refused by the same rule.
 */
function checkedRelative(input: string): string {
  if (input.includes("\0") || path.isAbsolute(input) || /^[a-zA-Z]:[\\/]/.test(input)) {
    throw outsideRoot();
  }
  return input;
}

/** Resolves an existing path inside the root, following symlinks, or throws. */
async function resolveExisting(rootReal: string, input: string): Promise<string> {
  const joined = path.resolve(rootReal, checkedRelative(input));
  let resolved: string;
  try {
    resolved = await realpath(joined);
  } catch {
    throw new ORPCError("NOT_FOUND", { message: "Not found" });
  }
  if (!isInsideRoot(rootReal, resolved)) throw outsideRoot();
  return resolved;
}

/**
 * Opens a file and proves the thing actually opened is inside the root.
 *
 * Checking a path and then reading it by name is a race: a symlink swapped in
 * between the two steps is followed by the second call, and the containment
 * check never saw it. So the file is opened once and the containment check runs
 * against `/proc/self/fd`, which names the inode behind the descriptor we hold —
 * whatever the path is renamed to later, this descriptor cannot be redirected.
 *
 * Read-only by default; "verify" opens for read *and* keeps the write right, so a
 * caller can inspect what it is about to replace only after the descriptor is
 * known to be safe. Returns a handle the caller must close.
 */
async function openChecked(
  rootReal: string,
  input: string,
  mode: "read" | "verify",
): Promise<{ handle: FileHandle; real: string }> {
  const opened = await openCheckedAt(
    path.resolve(rootReal, checkedRelative(input)),
    rootReal,
    mode,
  );
  // Without `allowMissing` this only returns null if the caller lies about it.
  if (!opened) throw new ORPCError("NOT_FOUND", { message: "Not found" });
  return opened;
}
/** `openChecked` for a path that has already been resolved against the root. */
async function openCheckedAt(
  absolute: string,
  rootReal: string,
  mode: "read" | "verify",
  /** In "verify" mode a missing file is not an error: the caller is about to create it. */
  allowMissing = false,
): Promise<{ handle: FileHandle; real: string } | null> {
  const flags =
    mode === "read"
      ? fsConstants.O_RDONLY
      : // "verify" reads the current bytes *and* keeps the write right, so the
        // caller's own containment check can inspect what it is about to replace.
        // No O_CREAT: a new file is written beside a checked parent instead.
        fsConstants.O_RDWR | fsConstants.O_NOFOLLOW;
  const handle = await open(absolute, flags).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      if (allowMissing) return null;
      throw new ORPCError("NOT_FOUND", { message: "Not found" });
    }
    if (error.code === "ELOOP" || error.code === "EMLINK") throw outsideRoot();
    if (error.code === "EISDIR") throw new ORPCError("BAD_REQUEST", { message: "Not a file" });
    throw error;
  });
  if (!handle) return null;
  let real: string;
  try {
    // `/proc/self/fd` reports the opened inode's own path, so this is not a
    // second lookup by name: it cannot be raced by swapping the path.
    real = await realpath(`/proc/self/fd/${handle.fd}`);
  } catch {
    await handle.close().catch(() => undefined);
    throw outsideRoot();
  }
  if (!isInsideRoot(rootReal, real)) {
    await handle.close().catch(() => undefined);
    throw outsideRoot();
  }
  return { handle, real };
}

/**
 * Resolves where a write may land: the parent folder must already exist
 * inside the root (folders are never created), and an existing target must
 * resolve inside the root too. A symlink that stays inside the root is
 * written through to its target, so the atomic rename never replaces the
 * link itself.
 */
async function resolveForWrite(rootReal: string, input: string): Promise<string> {
  const relative = checkedRelative(input);
  if (!relative) throw new ORPCError("BAD_REQUEST", { message: "Choose a file to save" });
  const joined = path.resolve(rootReal, relative);
  let realParent: string;
  try {
    realParent = await realpath(path.dirname(joined));
  } catch {
    throw new ORPCError("NOT_FOUND", { message: "That folder does not exist" });
  }
  if (!isInsideRoot(rootReal, realParent)) throw outsideRoot();
  const target = path.join(realParent, path.basename(joined));
  const existing = await lstat(target).catch(() => null);
  if (!existing) return target;
  if (existing.isSymbolicLink()) {
    const resolved = await realpath(target).catch(() => null);
    if (!resolved || !isInsideRoot(rootReal, resolved)) throw outsideRoot();
    const targetInfo = await stat(resolved).catch(() => null);
    if (!targetInfo?.isFile()) throw new ORPCError("BAD_REQUEST", { message: "Not a file" });
    return resolved;
  }
  if (!existing.isFile()) throw new ORPCError("BAD_REQUEST", { message: "Not a file" });
  return target;
}

/** Text decodes as UTF-8 with no NUL bytes; anything else is binary here. */
function isText(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function hasBinaryExtension(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export async function getSystemFilesStatus(
  deps: SystemFilesDeps,
  actor: Actor,
): Promise<SystemFilesStatus> {
  await requireAdmin(deps, actor.userId);
  return { enabled: configuredRoot(deps) !== null };
}

export async function listSystemFiles(
  deps: SystemFilesDeps,
  actor: Actor,
  input: SystemFilesListInput,
): Promise<SystemFilesList> {
  await requireAdmin(deps, actor.userId);
  const root = configuredRoot(deps);
  if (!root) return { enabled: false, path: input.path, entries: [], truncated: false };
  const rootReal = await realRoot(root);
  assertNoSecretSegments(input.path);
  const dir = await resolveExisting(rootReal, input.path);
  assertResolvedNotSecret(rootReal, dir);
  const dirInfo = await stat(dir).catch(() => null);
  if (!dirInfo?.isDirectory()) {
    throw new ORPCError("BAD_REQUEST", { message: "Not a folder" });
  }
  const dirents = await readdir(dir, { withFileTypes: true });
  const entries: SystemFileEntry[] = [];
  for (const dirent of dirents) {
    // Secrets are not listed at all, under their own name or a link's.
    if (isSecretSegment(dirent.name)) continue;
    const childPath = input.path ? `${input.path}/${dirent.name}` : dirent.name;
    const full = path.join(dir, dirent.name);
    if (dirent.isSymbolicLink()) {
      // Links that lead out of the root are not listed at all.
      const resolved = await realpath(full).catch(() => null);
      if (!resolved || !isInsideRoot(rootReal, resolved)) continue;
      if (resolvedIsSecret(rootReal, resolved)) continue;
      const info = await stat(resolved).catch(() => null);
      if (info?.isDirectory()) {
        entries.push({ name: dirent.name, path: childPath, type: "directory", size: null });
      } else if (info?.isFile()) {
        entries.push({ name: dirent.name, path: childPath, type: "file", size: info.size });
      }
      continue;
    }
    if (dirent.isDirectory()) {
      entries.push({ name: dirent.name, path: childPath, type: "directory", size: null });
    } else if (dirent.isFile()) {
      const info = await stat(full).catch(() => null);
      if (info) {
        entries.push({ name: dirent.name, path: childPath, type: "file", size: info.size });
      }
    }
  }
  entries.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1,
  );
  return {
    enabled: true,
    path: input.path,
    entries: entries.slice(0, SYSTEM_FILES_MAX_ENTRIES),
    truncated: entries.length > SYSTEM_FILES_MAX_ENTRIES,
  };
}

export async function readSystemFile(
  deps: SystemFilesDeps,
  actor: Actor,
  input: SystemFilesReadInput,
): Promise<SystemFilesRead> {
  await requireAdmin(deps, actor.userId);
  const root = configuredRoot(deps);
  if (!root) {
    return {
      enabled: false,
      path: input.path,
      content: null,
      size: 0,
      editable: false,
      reason: null,
    };
  }
  const rootReal = await realRoot(root);
  assertNoSecretSegments(input.path);
  assertResolvedNotSecret(rootReal, path.resolve(rootReal, checkedRelative(input.path)));
  // Open first, validate the descriptor, then read from that same descriptor:
  // no window remains in which the path could be swapped for a symlink.
  const { handle, real } = await openChecked(rootReal, input.path, "read");
  try {
    assertResolvedNotSecret(rootReal, real);
    const info = await handle.stat();
    if (!info.isFile()) throw new ORPCError("BAD_REQUEST", { message: "Not a file" });
    if (info.size > SYSTEM_FILES_MAX_BYTES) {
      return {
        enabled: true,
        path: input.path,
        content: null,
        size: info.size,
        editable: false,
        reason: "too-large",
      };
    }
    const bytes = await handle.readFile();
    if (hasBinaryExtension(real) || !isText(bytes)) {
      return {
        enabled: true,
        path: input.path,
        content: null,
        size: info.size,
        editable: false,
        reason: "binary",
      };
    }
    return {
      enabled: true,
      path: input.path,
      content: bytes.toString("utf8"),
      size: info.size,
      editable: true,
      reason: null,
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function writeSystemFile(
  deps: SystemFilesDeps,
  actor: Actor,
  input: SystemFilesWriteInput,
): Promise<SystemFilesWrite> {
  await requireAdmin(deps, actor.userId);
  const root = configuredRoot(deps);
  if (!root) {
    throw new ORPCError("BAD_REQUEST", {
      message: "System files are not enabled on this deployment",
    });
  }
  assertNoSecretSegments(input.path);
  const bytes = Buffer.from(input.content, "utf8");
  if (bytes.byteLength > SYSTEM_FILES_MAX_BYTES) {
    throw new ORPCError("BAD_REQUEST", {
      message: `Files larger than ${SYSTEM_FILES_MAX_BYTES} bytes cannot be saved here`,
    });
  }
  if (hasBinaryExtension(input.path)) {
    throw new ORPCError("BAD_REQUEST", { message: "Only text files can be edited here" });
  }
  const rootReal = await realRoot(root);
  const target = await resolveForWrite(rootReal, input.path);
  assertResolvedNotSecret(rootReal, target);
  // Validate the existing file through a descriptor, then write beside it and
  // rename over it. Re-checking the path by name here would reopen the race the
  // read path just closed.
  const opened = await openCheckedAt(target, rootReal, "verify", true);
  const existing = opened
    ? await (async () => {
        const { handle, real } = opened;
        try {
          // Never overwrite a binary or oversized file sight unseen from the editor.
          const info = await handle.stat();
          if (info.size > SYSTEM_FILES_MAX_BYTES) {
            throw new ORPCError("BAD_REQUEST", {
              message: "That file is too large to edit here",
            });
          }
          if (!isText(await handle.readFile())) {
            throw new ORPCError("BAD_REQUEST", { message: "Only text files can be edited here" });
          }
          return real;
        } finally {
          await handle.close().catch(() => undefined);
        }
      })()
    : null;
  // A symlink inside the root is written through to its target, as before.
  const destination = existing ?? target;
  // Write beside the target and rename over it, so a reader never sees a
  // half-written file and a failed write leaves the original in place.
  const temp = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.tmp-${randomUUID()}`,
  );
  try {
    await writeFile(temp, bytes);
    await rename(temp, destination);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  return { ok: true, size: bytes.byteLength };
}
