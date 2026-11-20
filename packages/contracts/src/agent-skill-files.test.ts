import { describe, expect, it } from "vitest";
import { CreateAgentSkillInput, skillFilesIssue, UpdateAgentSkillInput } from "./domain.js";

const body = "---\nname: Billing\ndescription: Chase invoices\n---\n\nSteps.\n";

describe("skill file upload rules", () => {
  it("accepts text files beside SKILL.md", () => {
    expect(skillFilesIssue({ "references/terms.md": "Net 30" })).toBeNull();
    expect(
      skillFilesIssue({ "a.txt": "", "b.json": "{}", "c.yaml": "x: 1", "d.csv": "a,b" }),
    ).toBeNull();
    // No files at all is fine: a skill can be a single SKILL.md.
    expect(skillFilesIssue(undefined)).toBeNull();
    expect(skillFilesIssue({})).toBeNull();
  });

  it("refuses paths that could escape the skill folder", () => {
    for (const path of ["../secret.md", "/etc/passwd.md", "a/../../b.md", "a//b.md", "a\\b.md"])
      expect(skillFilesIssue({ [path]: "x" })).toMatch(/not a safe file path/);
  });

  it("refuses scripts and binaries, the same way a plugin install does", () => {
    expect(skillFilesIssue({ "run.sh": "#!/bin/sh" })).toMatch(/not a supported text file/);
    expect(skillFilesIssue({ "tool.exe": "MZ" })).toMatch(/not a supported text file/);
  });

  it("enforces the count and byte limits", () => {
    const many = Object.fromEntries(
      Array.from({ length: 41 }, (_, index) => [`references/r${index}.md`, "x"]),
    );
    expect(skillFilesIssue(many)).toMatch(/at most 40 files/);
    const big = { "references/big.md": "x".repeat(400_001) };
    expect(skillFilesIssue(big)).toMatch(/at most 400000 characters/);
  });

  it("reports the problem on the files field through the create input", () => {
    const bad = CreateAgentSkillInput.safeParse({ content: body, files: { "run.sh": "x" } });
    expect(bad.success).toBe(false);
    if (!bad.success)
      expect(bad.error.issues.some((issue) => issue.path[0] === "files")).toBe(true);

    const good = CreateAgentSkillInput.safeParse({
      content: body,
      files: { "references/terms.md": "Net 30" },
    });
    expect(good.success).toBe(true);
  });

  it("lets an update carry only files", () => {
    const onlyFiles = UpdateAgentSkillInput.safeParse({
      skillId: "clx0000000000000000000000",
      files: { "references/terms.md": "Net 30" },
    });
    expect(onlyFiles.success).toBe(true);
  });
});
