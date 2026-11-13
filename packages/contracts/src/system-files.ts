import { z } from "zod";

/**
 * Admin browsing and editing of text files under one directory on the
 * server, chosen by the operator with SYSTEM_FILES_ROOT. Paths are always
 * relative to that root; the server resolves each one and refuses anything
 * that lands outside it. Unset, every call reports the feature disabled.
 */

/** Largest file the editor will read or write, in bytes. */
export const SYSTEM_FILES_MAX_BYTES = 512 * 1024;

/** Most entries one folder listing returns. */
export const SYSTEM_FILES_MAX_ENTRIES = 1000;

/** A path inside the root with "/" separators; "" is the root itself. */
const relativePath = z.string().max(1024);

export const SystemFilesStatusSchema = z.object({
  enabled: z.boolean(),
});
export type SystemFilesStatus = z.infer<typeof SystemFilesStatusSchema>;

export const SystemFileEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(["directory", "file"]),
  /** Byte size for files; null for folders. */
  size: z.number().nullable(),
});
export type SystemFileEntry = z.infer<typeof SystemFileEntrySchema>;

export const SystemFilesListInput = z.object({ path: relativePath });
export type SystemFilesListInput = z.infer<typeof SystemFilesListInput>;

export const SystemFilesListSchema = z.object({
  enabled: z.boolean(),
  path: z.string(),
  entries: z.array(SystemFileEntrySchema),
  /** True when the folder holds more entries than the listing returns. */
  truncated: z.boolean(),
});
export type SystemFilesList = z.infer<typeof SystemFilesListSchema>;

export const SystemFilesReadInput = z.object({ path: relativePath });
export type SystemFilesReadInput = z.infer<typeof SystemFilesReadInput>;

export const SystemFilesReadSchema = z.object({
  enabled: z.boolean(),
  path: z.string(),
  /** The file's text when it can be edited here; null when it cannot. */
  content: z.string().nullable(),
  size: z.number(),
  editable: z.boolean(),
  /** Why the file cannot be edited, when it cannot. */
  reason: z.enum(["binary", "too-large"]).nullable(),
});
export type SystemFilesRead = z.infer<typeof SystemFilesReadSchema>;

export const SystemFilesWriteInput = z.object({
  path: relativePath.min(1),
  content: z.string().max(SYSTEM_FILES_MAX_BYTES),
});
export type SystemFilesWriteInput = z.infer<typeof SystemFilesWriteInput>;

export const SystemFilesWriteSchema = z.object({
  ok: z.literal(true),
  /** The written file's size in bytes. */
  size: z.number(),
});
export type SystemFilesWrite = z.infer<typeof SystemFilesWriteSchema>;
