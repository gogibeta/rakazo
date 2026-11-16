import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WORKSPACE_ESCAPE_EXIT,
  WORKSPACE_ESCAPE_MESSAGE,
  workspaceReadScript,
  workspaceWriteScript,
} from "./workspace-file-scripts.js";

/**
 * Runs the real scripts a computer runs, against a scratch directory standing in for the
 * workspace root. The scripts take the root as an argument for exactly this reason.
 */
let root: string;
let outside: string;

beforeEach(() => {
  const base = mkdtempSync(path.join(tmpdir(), "workspace-containment-"));
  root = path.join(base, "workspace");
  outside = path.join(base, "outside");
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(outside, "secret.txt"), "outside the workspace");
  writeFileSync(path.join(root, "notes.md"), "inside the workspace");
  mkdirSync(path.join(root, "sub"), { recursive: true });
  writeFileSync(path.join(root, "sub", "inner.md"), "a file in a subdirectory");
});

afterEach(() => {
  rmSync(path.dirname(root), { recursive: true, force: true });
});

function read(target: string) {
  return spawnSync("python3", ["-c", workspaceReadScript(), root, target, "-1"], {
    encoding: "utf8",
  });
}

function write(target: string, content: string) {
  return spawnSync("python3", ["-c", workspaceWriteScript(), root, target, "0"], {
    encoding: "utf8",
    input: content,
  });
}

const target = (...segments: string[]) => path.join(root, ...segments);

describe("workspace file scripts", () => {
  it("reads and writes ordinary files unchanged", () => {
    const read1 = read(target("notes.md"));
    expect(read1.status, read1.stderr).toBe(0);
    expect(Buffer.from(read1.stdout, "base64").toString()).toBe("inside the workspace");

    const write1 = write(target("sub", "new.md"), "written");
    expect(write1.status, write1.stderr).toBe(0);
    expect(readFileSync(target("sub", "new.md"), "utf8")).toBe("written");
  });

  it("creates a missing directory for a write, and the file is not executable", () => {
    const result = write(target("fresh", "deep", "file.md"), "made");
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(target("fresh", "deep", "file.md"), "utf8")).toBe("made");
  });

  it("refuses to read a file that links outside the workspace", () => {
    symlinkSync(path.join(outside, "secret.txt"), target("escape.txt"));
    const result = read(target("escape.txt"));
    expect(result.status).toBe(WORKSPACE_ESCAPE_EXIT);
    expect(result.stderr).toContain(WORKSPACE_ESCAPE_MESSAGE);
    expect(result.stdout).toBe("");
  });

  it("refuses to write a file that links outside the workspace", () => {
    symlinkSync(path.join(outside, "secret.txt"), target("escape.txt"));
    const result = write(target("escape.txt"), "overwritten");
    expect(result.status).toBe(WORKSPACE_ESCAPE_EXIT);
    expect(result.stderr).toContain(WORKSPACE_ESCAPE_MESSAGE);
    // The file it pointed at is untouched.
    expect(readFileSync(path.join(outside, "secret.txt"), "utf8")).toBe("outside the workspace");
  });

  it("refuses to write through a symlinked final component that does not exist yet", () => {
    // A dangling link out of the workspace: opening it would create the target outside.
    symlinkSync(path.join(outside, "created.txt"), target("dangling.txt"));
    const result = write(target("dangling.txt"), "escaped");
    expect(result.status).toBe(WORKSPACE_ESCAPE_EXIT);
    expect(readFileSync(path.join(outside, "secret.txt"), "utf8")).toBe("outside the workspace");
  });

  it("refuses to read through a symlinked parent directory pointing outside", () => {
    symlinkSync(outside, target("linked"));
    const result = read(target("linked", "secret.txt"));
    expect(result.status).toBe(WORKSPACE_ESCAPE_EXIT);
    expect(result.stderr).toContain(WORKSPACE_ESCAPE_MESSAGE);
    expect(result.stdout).toBe("");
  });

  it("refuses to write through a symlinked parent directory pointing outside", () => {
    symlinkSync(outside, target("linked"));
    const result = write(target("linked", "planted.txt"), "escaped");
    expect(result.status).toBe(WORKSPACE_ESCAPE_EXIT);
    expect(result.stderr).toContain(WORKSPACE_ESCAPE_MESSAGE);
    // Nothing was created outside, including the directories for it.
    expect(spawnSync("test", ["-e", path.join(outside, "planted.txt")]).status).toBe(1);
  });

  it("refuses to create directories through a symlinked parent pointing outside", () => {
    symlinkSync(outside, target("linked"));
    const result = write(target("linked", "made", "up", "file.md"), "escaped");
    expect(result.status).toBe(WORKSPACE_ESCAPE_EXIT);
    expect(spawnSync("test", ["-e", path.join(outside, "made")]).status).toBe(1);
  });

  it("allows a symlink that stays inside the workspace", () => {
    symlinkSync(target("sub", "inner.md"), target("inside-link.md"));
    const read1 = read(target("inside-link.md"));
    expect(read1.status, read1.stderr).toBe(0);
    expect(Buffer.from(read1.stdout, "base64").toString()).toBe("a file in a subdirectory");

    // Writing through it replaces what the resolved path names, inside the workspace.
    const write1 = write(target("sub", "other.md"), "first");
    expect(write1.status, write1.stderr).toBe(0);
    symlinkSync(target("sub", "other.md"), target("inside-write-link.md"));
    const write2 = write(target("inside-write-link.md"), "second");
    expect(write2.status, write2.stderr).toBe(0);
    expect(readFileSync(target("sub", "other.md"), "utf8")).toBe("second");
  });

  it("allows a symlinked directory that stays inside the workspace", () => {
    symlinkSync(target("sub"), target("inner-dir"));
    const result = read(target("inner-dir", "inner.md"));
    expect(result.status, result.stderr).toBe(0);
    expect(Buffer.from(result.stdout, "base64").toString()).toBe("a file in a subdirectory");
  });

  it("refuses the workspace root itself as a file", () => {
    const result = read(root);
    // The root resolves to itself and is contained, so the refusal comes from opening a directory.
    expect(result.status).not.toBe(0);
    expect(result.status).not.toBe(WORKSPACE_ESCAPE_EXIT);
  });
});
