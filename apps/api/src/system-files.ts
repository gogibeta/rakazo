import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { open, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
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
 * Returns a handle the caller must close.
 */
async function openChecked(
  rootReal: string,
  input: string,
): Promise<{ handle: FileHandle; real: string }> {
  return openCheckedAt(path.resolve(rootReal, checkedRelative(input)), rootReal);
}
/**
 * `openChecked` for a path that has already been resolved against the root.
 */
async function openCheckedAt(
  absolute: string,
  rootReal: string,
): Promise<{ handle: FileHandle; real: string }> {
  const handle = await open(absolute, fsConstants.O_RDONLY).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw new ORPCError("NOT_FOUND", { message: "Not found" });
      if (error.code === "ELOOP" || error.code === "EMLINK") throw outsideRoot();
      if (error.code === "EISDIR") throw new ORPCError("BAD_REQUEST", { message: "Not a file" });
      throw error;
    },
  );
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

/** Where a save actually lands, held open so no later lookup can redirect it. */
interface WriteTarget {
  /** The folder the save lands in, held open: renaming that folder by name cannot move this. */
  parent: FileHandle;
  /** The file's name within that folder. Never a path: a path here would be resolved again. */
  name: string;
  /**
   * The file being replaced, still open across the rename. Kept open so the inode is
   * the one that was inspected, and so the save cannot land on a name that was
   * swapped once the check finished.
   */
  existing: FileHandle | null;
}

/**
 * Resolves where a save may land and pins every part of it to an open descriptor.
 *
 * The old design validated a target path and then renamed onto it by name. Between
 * those steps the client can swap the parent folder for a link that points outside
 * the root, and the rename lands wherever that link now leads: the check was on a
 * name that no longer meant the same thing. A rename is the dangerous step because it
 * replaces the directory entry itself, so nothing done to the *file* can prevent it.
 *
 * So the folder is opened once and every later operation goes through
 * `/proc/self/fd/<fd>`: the write, the replace, and the cleanup all act on the inode
 * that was validated, whatever its name is changed to afterwards. A new file is
 * legitimate as long as its *parent* is inside the root, so a missing target is
 * created beside a pinned parent rather than treated as an escape.
 *
 * Callers must close both handles.
 */
async function openWriteTarget(rootReal: string, input: string): Promise<WriteTarget> {
  const relative = checkedRelative(input);
  if (!relative) throw new ORPCError("BAD_REQUEST", { message: "Choose a file to save" });
  const joined = path.resolve(rootReal, relative);
  // Pin the folder the client named, before anything else touches the filesystem.
  const pinned = await openDirectory(path.dirname(joined));
  let existing: FileHandle | null = null;
  try {
    const parentReal = await directoryReal(pinned, rootReal);
    existing = await open(`${fdPath(pinned)}/${path.basename(joined)}`, fsConstants.O_RDWR).catch(
      (error: NodeJS.ErrnoException) => {
        // A missing target is the create case: its folder is already proven, so the
        // save may add the file there. This is the new-file containment check.
        if (error.code === "ENOENT") return null;
        if (error.code === "EISDIR") throw new ORPCError("BAD_REQUEST", { message: "Not a file" });
        if (error.code === "ELOOP" || error.code === "EMLINK") throw outsideRoot();
        throw error;
      },
    );
    if (!existing) return { parent: pinned, name: path.basename(joined), existing: null };
    // Opening followed any link, so this descriptor names the file the save would
    // replace. Its own folder is what the rename must be anchored to; using the
    // link's folder would replace the link instead of writing through it.
    const real = await realpath(fdPath(existing)).catch(() => null);
    const info = await existing.stat().catch(() => null);
    if (!real || !info || !isInsideRoot(rootReal, real)) {
      throw outsideRoot();
    }
    if (!info.isFile()) throw new ORPCError("BAD_REQUEST", { message: "Not a file" });
    assertResolvedNotSecret(rootReal, real);
    const realDir = path.dirname(real);
    if (realDir === parentReal) return { parent: pinned, name: path.basename(real), existing };
    // The link points at another folder inside the root: pin that one instead.
    const linked = await openDirectory(realDir);
    try {
      await directoryReal(linked, rootReal);
    } catch (error) {
      await linked.close().catch(() => undefined);
      throw error;
    }
    await pinned.close().catch(() => undefined);
    return { parent: linked, name: path.basename(real), existing };
  } catch (error) {
    // A handle opened here must not outlive a failed resolution.
    await existing?.close().catch(() => undefined);
    await pinned.close().catch(() => undefined);
    throw error;
  }
}

/** `/proc/self/fd/<fd>`: the opened inode, by descriptor instead of by name. */
function fdPath(handle: FileHandle): string {
  return `/proc/self/fd/${handle.fd}`;
}

async function openDirectory(dirPath: string): Promise<FileHandle> {
  return open(dirPath, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY).catch(() => {
    throw new ORPCError("NOT_FOUND", { message: "That folder does not exist" });
  });
}

/** Proves an open folder is the one we validated, and returns its real path. */
async function directoryReal(handle: FileHandle, rootReal: string): Promise<string> {
  const real = await realpath(fdPath(handle)).catch(() => null);
  if (!real || !isInsideRoot(rootReal, real)) throw outsideRoot();
  return real;
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
  const { handle, real } = await openChecked(rootReal, input.path);
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
  const target = await openWriteTarget(rootReal, input.path);
  // Every operation below goes through the pinned folder descriptor, so renaming
  // the folder (or replacing the file) after this point cannot redirect the save.
  try {
    if (target.existing) {
      // Never overwrite a binary or oversized file sight unseen from the editor.
      const info = await target.existing.stat();
      if (info.size > SYSTEM_FILES_MAX_BYTES) {
        throw new ORPCError("BAD_REQUEST", { message: "That file is too large to edit here" });
      }
      if (!isText(await target.existing.readFile())) {
        throw new ORPCError("BAD_REQUEST", { message: "Only text files can be edited here" });
      }
    }
    // Write beside the destination and rename over it, so a reader never sees a
    // half-written file and a failed write leaves the original in place. Both paths
    // are descriptor-relative: the temporary file is created in the folder that was
    // validated, and the rename replaces the entry in that same folder.
    const temp = `.${target.name}.tmp-${randomUUID()}`;
    try {
      await writeFile(`${fdPath(target.parent)}/${temp}`, bytes);
      await rename(`${fdPath(target.parent)}/${temp}`, `${fdPath(target.parent)}/${target.name}`);
    } catch (error) {
      await rm(`${fdPath(target.parent)}/${temp}`, { force: true }).catch(() => undefined);
      throw error;
    }
  } finally {
    await target.existing?.close().catch(() => undefined);
    await target.parent.close().catch(() => undefined);
  }
  return { ok: true, size: bytes.byteLength };
}
