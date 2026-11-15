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

  it("never lists, reads, or writes secret files, at any depth", async () => {
    const deps = makeDeps();
    await writeFile(path.join(root, ".env"), "ENCRYPTION_KEY=fake");
    await writeFile(path.join(root, ".env.bak-1"), "ENCRYPTION_KEY=fake");
    await writeFile(path.join(root, "prod.env"), "TOKEN=fake");
    await writeFile(path.join(root, "UPPER.ENV"), "TOKEN=fake");
    await writeFile(path.join(root, "cert.pem"), "-----BEGIN CERTIFICATE-----");
    await writeFile(path.join(root, "tls.key"), "-----BEGIN PRIVATE KEY-----");
    await writeFile(path.join(root, "id_rsa"), "private");
    await writeFile(path.join(root, ".npmrc"), "//registry/:_authToken=fake");
    await writeFile(path.join(root, ".netrc"), "machine example login fake");
    await mkdir(path.join(root, ".ssh"));
    await writeFile(path.join(root, ".ssh", "id_ed25519"), "private");
    await mkdir(path.join(root, ".aws"));
    await writeFile(path.join(root, ".aws", "credentials"), "fake");
    await writeFile(path.join(root, "notes", ".env"), "TOKEN=fake");
    await writeFile(path.join(root, "notes", "deploy.key"), "private");

    // Listings hide them, at the root and inside subfolders.
    const listed = await listSystemFiles(deps, actor, { path: "" });
    expect(listed.entries.map((entry) => entry.name)).toEqual(["notes", "hello.txt"]);
    const nested = await listSystemFiles(deps, actor, { path: "notes" });
    expect(nested.entries.map((entry) => entry.name)).toEqual(["todo.md"]);
    await expect(listSystemFiles(deps, actor, { path: ".ssh" })).rejects.toThrow(
      "not available in system files",
    );

    // Reads are refused with a clean error, not served.
    for (const secret of [
      ".env",
      ".env.bak-1",
      "prod.env",
      "UPPER.ENV",
      "cert.pem",
      "tls.key",
      "id_rsa",
      ".npmrc",
      ".netrc",
      ".ssh",
      ".ssh/id_ed25519",
      ".aws/credentials",
      "notes/.env",
      "notes/deploy.key",
    ]) {
      await expect(readSystemFile(deps, actor, { path: secret })).rejects.toThrow(
        "not available in system files",
      );
    }

    // Writes are refused, and nothing on disk changes.
    await expect(
      writeSystemFile(deps, actor, { path: ".env", content: "pwned=1" }),
    ).rejects.toThrow("not available in system files");
    await expect(
      writeSystemFile(deps, actor, { path: "notes/.env", content: "pwned=1" }),
    ).rejects.toThrow("not available in system files");
    await expect(
      writeSystemFile(deps, actor, { path: "new.key", content: "private" }),
    ).rejects.toThrow("not available in system files");
    await expect(readFile(path.join(root, ".env"), "utf8")).resolves.toBe("ENCRYPTION_KEY=fake");
    await expect(stat(path.join(root, "new.key"))).rejects.toThrow();
  });

  it("refuses symlinks that reach a secret file inside the root", async () => {
    const deps = makeDeps();
    await writeFile(path.join(root, ".env"), "ENCRYPTION_KEY=fake");
    // An innocent name that resolves to the secret, and a secret name that
    // resolves to an ordinary file: both are refused.
    await symlink(path.join(root, ".env"), path.join(root, "innocent.txt"));
    await symlink(path.join(root, "hello.txt"), path.join(root, "prod.env"));
    await expect(readSystemFile(deps, actor, { path: "innocent.txt" })).rejects.toThrow(
      "not available in system files",
    );
    await expect(
      writeSystemFile(deps, actor, { path: "innocent.txt", content: "pwned" }),
    ).rejects.toThrow("not available in system files");
    await expect(readSystemFile(deps, actor, { path: "prod.env" })).rejects.toThrow(
      "not available in system files",
    );
    const listed = await listSystemFiles(deps, actor, { path: "" });
    const names = listed.entries.map((entry) => entry.name);
    expect(names).not.toContain("innocent.txt");
    expect(names).not.toContain("prod.env");
    // The secret on disk is untouched.
    await expect(readFile(path.join(root, ".env"), "utf8")).resolves.toBe("ENCRYPTION_KEY=fake");
  });

  it("still serves ordinary files whose names merely resemble secrets", async () => {
    const deps = makeDeps();
    await writeFile(path.join(root, "env.ts"), "export {};");
    await writeFile(path.join(root, "environment.md"), "# Env\n");
    await writeFile(path.join(root, "monkey.env.txt"), "notes");
    const listed = await listSystemFiles(deps, actor, { path: "" });
    const names = listed.entries.map((entry) => entry.name);
    expect(names).toContain("env.ts");
    expect(names).toContain("environment.md");
    expect(names).toContain("monkey.env.txt");
    await expect(readSystemFile(deps, actor, { path: "env.ts" })).resolves.toMatchObject({
      content: "export {};",
      editable: true,
    });
    await expect(
      writeSystemFile(deps, actor, { path: "monkey.env.txt", content: "edited" }),
    ).resolves.toEqual({ ok: true, size: 6 });
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
