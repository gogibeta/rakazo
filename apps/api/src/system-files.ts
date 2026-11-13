import { randomUUID } from "node:crypto";
import { lstat, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
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
  const dir = await resolveExisting(rootReal, input.path);
  const dirInfo = await stat(dir).catch(() => null);
  if (!dirInfo?.isDirectory()) {
    throw new ORPCError("BAD_REQUEST", { message: "Not a folder" });
  }
  const dirents = await readdir(dir, { withFileTypes: true });
  const entries: SystemFileEntry[] = [];
  for (const dirent of dirents) {
    const childPath = input.path ? `${input.path}/${dirent.name}` : dirent.name;
    const full = path.join(dir, dirent.name);
    if (dirent.isSymbolicLink()) {
      // Links that lead out of the root are not listed at all.
      const resolved = await realpath(full).catch(() => null);
      if (!resolved || !isInsideRoot(rootReal, resolved)) continue;
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
  const file = await resolveExisting(rootReal, input.path);
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) throw new ORPCError("BAD_REQUEST", { message: "Not a file" });
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
  const bytes = await readFile(file);
  if (hasBinaryExtension(file) || !isText(bytes)) {
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
  const existing = await stat(target).catch(() => null);
  if (existing) {
    // Never overwrite a binary or oversized file sight unseen from the editor.
    if (existing.size > SYSTEM_FILES_MAX_BYTES) {
      throw new ORPCError("BAD_REQUEST", {
        message: "That file is too large to edit here",
      });
    }
    const current = await readFile(target);
    if (!isText(current)) {
      throw new ORPCError("BAD_REQUEST", { message: "Only text files can be edited here" });
    }
  }
  // Write beside the target and rename over it, so a reader never sees a
  // half-written file and a failed write leaves the original in place.
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.tmp-${randomUUID()}`);
  try {
    await writeFile(temp, bytes);
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  return { ok: true, size: bytes.byteLength };
}
