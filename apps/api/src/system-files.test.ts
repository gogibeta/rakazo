import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSystemFilesStatus,
  listSystemFiles,
  readSystemFile,
  writeSystemFile,
} from "./system-files.js";

const actor = { userId: "user-1", spaceId: "space-1", email: "admin@example.com" } as never;

/** A real folder on disk as the root, with an "outside" sibling the root must never reach. */
let base: string;
let root: string;
let outside: string;

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "system-files-"));
  root = path.join(base, "root");
  outside = path.join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.txt"), "outside the root");
  await writeFile(path.join(root, "hello.txt"), "hello world");
  await mkdir(path.join(root, "notes"));
  await writeFile(path.join(root, "notes", "todo.md"), "# Todo\n");
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function makeDeps(options: { admin?: boolean; root?: string | null } = {}) {
  const prisma = {
    user: {
      findUnique: vi.fn(async () => ({ email: "admin@example.com", emailVerified: true })),
    },
  };
  return {
    prisma: prisma as unknown as PrismaClient,
    env: {
      adminEmails: options.admin === false ? [] : ["admin@example.com"],
      systemFilesRoot: options.root === null ? undefined : (options.root ?? root),
    },
  };
}

describe("system files", () => {
  it("is for admins only, even when disabled", async () => {
    const deps = makeDeps({ admin: false });
    await expect(getSystemFilesStatus(deps, actor)).rejects.toThrow("Admins only");
    await expect(listSystemFiles(deps, actor, { path: "" })).rejects.toThrow("Admins only");
    await expect(readSystemFile(deps, actor, { path: "hello.txt" })).rejects.toThrow("Admins only");
    await expect(writeSystemFile(deps, actor, { path: "x.txt", content: "x" })).rejects.toThrow(
      "Admins only",
    );
    const disabled = makeDeps({ admin: false, root: null });
    await expect(getSystemFilesStatus(disabled, actor)).rejects.toThrow("Admins only");
  });

  it("reports disabled when no root is configured", async () => {
    const deps = makeDeps({ root: null });
    await expect(getSystemFilesStatus(deps, actor)).resolves.toEqual({ enabled: false });
    await expect(listSystemFiles(deps, actor, { path: "" })).resolves.toEqual({
      enabled: false,
      path: "",
      entries: [],
      truncated: false,
    });
    const read = await readSystemFile(deps, actor, { path: "hello.txt" });
    expect(read.enabled).toBe(false);
    expect(read.content).toBeNull();
    await expect(writeSystemFile(deps, actor, { path: "x.txt", content: "x" })).rejects.toThrow(
      "not enabled",
    );
  });

  it("lists folders first, then files, with sizes", async () => {
    const deps = makeDeps();
    const listed = await listSystemFiles(deps, actor, { path: "" });
    expect(listed.enabled).toBe(true);
    expect(listed.truncated).toBe(false);
    expect(listed.entries).toEqual([
      { name: "notes", path: "notes", type: "directory", size: null },
      { name: "hello.txt", path: "hello.txt", type: "file", size: 11 },
    ]);
    const nested = await listSystemFiles(deps, actor, { path: "notes" });
    expect(nested.entries).toEqual([
      { name: "todo.md", path: "notes/todo.md", type: "file", size: 7 },
    ]);
  });

  it("reads a text file", async () => {
    const deps = makeDeps();
    await expect(readSystemFile(deps, actor, { path: "hello.txt" })).resolves.toEqual({
      enabled: true,
      path: "hello.txt",
      content: "hello world",
      size: 11,
      editable: true,
      reason: null,
    });
  });

  it("refuses paths that escape the root", async () => {
    const deps = makeDeps();
    await expect(readSystemFile(deps, actor, { path: "../outside/secret.txt" })).rejects.toThrow(
      "outside the system files root",
    );
    await expect(listSystemFiles(deps, actor, { path: ".." })).rejects.toThrow(
      "outside the system files root",
    );
    await expect(listSystemFiles(deps, actor, { path: "notes/../../outside" })).rejects.toThrow(
      "outside the system files root",
    );
    await expect(
      writeSystemFile(deps, actor, { path: "../outside/evil.txt", content: "evil" }),
    ).rejects.toThrow("outside the system files root");
    await expect(
      writeSystemFile(deps, actor, { path: "notes/../../outside/evil.txt", content: "evil" }),
    ).rejects.toThrow("outside the system files root");
    // Nothing was written outside.
    await expect(readFile(path.join(outside, "evil.txt"), "utf8")).rejects.toThrow();
  });

  it("refuses symlinks that escape the root and hides them from listings", async () => {
    const deps = makeDeps();
    await symlink(path.join(outside, "secret.txt"), path.join(root, "leak.txt"));
    await symlink(outside, path.join(root, "leak-dir"));
    await expect(readSystemFile(deps, actor, { path: "leak.txt" })).rejects.toThrow(
      "outside the system files root",
    );
    await expect(listSystemFiles(deps, actor, { path: "leak-dir" })).rejects.toThrow(
      "outside the system files root",
    );
    await expect(
      writeSystemFile(deps, actor, { path: "leak.txt", content: "evil" }),
    ).rejects.toThrow("outside the system files root");
    const listed = await listSystemFiles(deps, actor, { path: "" });
    expect(listed.entries.map((entry) => entry.name)).not.toContain("leak.txt");
    expect(listed.entries.map((entry) => entry.name)).not.toContain("leak-dir");
    // The outside file is untouched.
    await expect(readFile(path.join(outside, "secret.txt"), "utf8")).resolves.toBe(
      "outside the root",
    );
  });

  it("marks binary files read-only by extension and by content", async () => {
    const deps = makeDeps();
    await writeFile(path.join(root, "logo.png"), "not really a png");
    const byExtension = await readSystemFile(deps, actor, { path: "logo.png" });
    expect(byExtension).toMatchObject({ editable: false, reason: "binary", content: null });
    await writeFile(path.join(root, "data.txt"), Buffer.from([0x68, 0x00, 0x69]));
    const byContent = await readSystemFile(deps, actor, { path: "data.txt" });
    expect(byContent).toMatchObject({ editable: false, reason: "binary", content: null });
    await expect(
      writeSystemFile(deps, actor, { path: "logo.png", content: "text" }),
    ).rejects.toThrow("Only text files");
    await expect(
      writeSystemFile(deps, actor, { path: "data.txt", content: "text" }),
    ).rejects.toThrow("Only text files");
  });

  it("marks oversized files read-only and refuses oversized writes", async () => {
    const deps = makeDeps();
    await writeFile(path.join(root, "big.txt"), "x".repeat(512 * 1024 + 1));
    const read = await readSystemFile(deps, actor, { path: "big.txt" });
    expect(read).toMatchObject({ editable: false, reason: "too-large", content: null });
    await expect(
      writeSystemFile(deps, actor, { path: "big.txt", content: "small" }),
    ).rejects.toThrow("too large");
  });

  it("writes edits and new files, leaving no temp files behind", async () => {
    const deps = makeDeps();
    const edited = await writeSystemFile(deps, actor, {
      path: "hello.txt",
      content: "edited",
    });
    expect(edited).toEqual({ ok: true, size: 6 });
    await expect(readFile(path.join(root, "hello.txt"), "utf8")).resolves.toBe("edited");

    const created = await writeSystemFile(deps, actor, {
      path: "notes/new.txt",
      content: "fresh",
    });
    expect(created).toEqual({ ok: true, size: 5 });
    await expect(readFile(path.join(root, "notes", "new.txt"), "utf8")).resolves.toBe("fresh");

    // Saving into a folder that does not exist never creates it.
    await expect(
      writeSystemFile(deps, actor, { path: "missing/x.txt", content: "x" }),
    ).rejects.toThrow("does not exist");
    await expect(stat(path.join(root, "missing"))).rejects.toThrow();

    const names = await readdir(path.join(root, "notes"));
    expect(names.sort()).toEqual(["new.txt", "todo.md"]);
  });

  it("truncates listings at the entry cap", async () => {
    const deps = makeDeps();
    await Promise.all(
      Array.from({ length: 1005 }, (_, index) =>
        writeFile(path.join(root, "notes", `f-${index}.txt`), ""),
      ),
    );
    const listed = await listSystemFiles(deps, actor, { path: "notes" });
    expect(listed.entries).toHaveLength(1000);
    expect(listed.truncated).toBe(true);
  });
});
