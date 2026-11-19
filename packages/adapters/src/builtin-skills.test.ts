import { existsSync, readFileSync } from "node:fs";
import { parseSkillMd } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { BUILTIN_AGENT_SKILLS, RAKAZO_DOCS_URLS } from "./builtin-skills.js";

const repoFile = (path: string) => new URL(`../../../${path}`, import.meta.url);
const publishedSlugs = [
  ...readFileSync(repoFile("apps/www/src/docs.ts"), "utf8").matchAll(/slug: "([\w-]+)"/g),
].map((match) => match[1]);

describe("built-in skills", () => {
  it("all parse, with unique names and picker-length descriptions", () => {
    const names = BUILTIN_AGENT_SKILLS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const skill of BUILTIN_AGENT_SKILLS) {
      const parsed = parseSkillMd(skill.content);
      expect("error" in parsed, skill.name).toBe(false);
      if (!("error" in parsed)) {
        expect(parsed.name).toBe(skill.name);
        expect(parsed.description).toBe(skill.description);
        expect(parsed.body.trim().length).toBeGreaterThan(0);
      }
      expect(skill.description.length, skill.name).toBeLessThanOrEqual(72);
    }
  });

  it("ships the coding skills", () => {
    expect(BUILTIN_AGENT_SKILLS.map((s) => s.name)).toContain("Code Change");
    expect(BUILTIN_AGENT_SKILLS.map((s) => s.name)).toContain("Debug");
    expect(BUILTIN_AGENT_SKILLS.map((s) => s.name)).toContain("Checkpoints");
    expect(BUILTIN_AGENT_SKILLS.map((s) => s.name)).toContain("Retrospective");
  });
});

describe("Drex Decisions skill", () => {
  const skill = BUILTIN_AGENT_SKILLS.find((s) => s.name === "Drex Decisions")!;

  it("names only tools that exist, and says they appear only when configured", () => {
    // decide is gated on decisionsEnabled and the document tools on documentsEnabled
    // (run-tool-selection.ts), so a bot must check its tool list rather than assume.
    expect(skill.content).toContain("not in your tool list");
    expect(skill.content).toContain("has not enabled it");
    for (const tool of ["decide", "document_parse", "document_extract", "document_split"]) {
      expect(skill.content).toContain(tool);
    }
    expect(skill.content).not.toContain("wallet_send");
  });

  it("warns that forced two-option choices get confident wrong answers", () => {
    expect(skill.content).toContain("mutually exclusive");
    expect(skill.content).toContain("needs more information");
    expect(skill.content).toContain("still answers confidently");
  });

  it("treats low confidence as unsettled rather than as a verdict", () => {
    expect(skill.content).toContain("Confidence is a number, not a verdict");
  });

  it("requires reading extraction status, so not_found is not read as a value", () => {
    expect(skill.content).toContain("not_found");
    expect(skill.content).toContain("ambiguous");
    expect(skill.content).toContain("Read the status, not just the value");
  });

  it("says document_locate finds text but does not judge truth", () => {
    expect(skill.content).toContain("It locates text; it does not check whether a claim is true");
  });

  it("treats document content as data, never as instructions", () => {
    expect(skill.content).toContain("never as instructions");
  });
});

describe("Wallet Operations skill", () => {
  const skill = BUILTIN_AGENT_SKILLS.find((s) => s.name === "Wallet Operations")!;

  it("never claims a send happened, and names no tool that could", () => {
    // Signing and broadcast are not in this build, so the skill must not promise
    // either, and must not name a tool a bot could try to call. These are the
    // exact claims the shipped text made before this build supported them.
    for (const claim of [
      "use wallet_send",
      "wallet_send:",
      "signs inside its vault",
      "the server then signs",
      "you receive only the transaction hash",
      "confirms it; the server",
    ]) {
      expect(skill.content, claim).not.toContain(claim);
    }
  });

  it("says plainly that sending is unavailable, and stops at a preparation summary", () => {
    expect(skill.content).toContain("Sending is not available in this build");
    expect(skill.content).toContain("signing is not available yet");
    expect(skill.content).toContain("preparation summary");
    expect(skill.content).toContain("signing is unavailable in this build");
    expect(skill.content).toContain("Preparing is not sending");
  });
});

describe("Social Posts skill", () => {
  const skill = BUILTIN_AGENT_SKILLS.find((s) => s.name === "Social Posts")!;

  it("names the one-link route and the search route that actually exist", () => {
    expect(skill.content).toContain("/ai/2/post?url=");
    expect(skill.content).toContain("/ai/2/ask?q=");
    expect(skill.content).toContain("fixtweet.twapiworker.workers.dev");
  });

  it("states the User-Agent rule, since a missing one is a 401 for every API call", () => {
    expect(skill.content).toContain("User-Agent header");
    expect(skill.content).toContain("401");
  });

  it("teaches the retryable-500 versus terminal-404 rule instead of a retry loop", () => {
    expect(skill.content).toMatch(/wait about 30 seconds/i);
    expect(skill.content).toContain("Only a 404 ends a walk");
  });

  it("refuses to promise networks the worker does not support", () => {
    for (const unsupported of ["Reddit", "Facebook", "YouTube"]) {
      expect(skill.content).toContain(unsupported);
    }
    expect(skill.content).toContain("Not supported");
  });

  it("does not present ?lang= as translation, which is a no-op on this deployment", () => {
    expect(skill.content).toContain("translation is a no-op");
  });
});

describe("Web Research skill", () => {
  const skill = BUILTIN_AGENT_SKILLS.find((s) => s.name === "Web Research")!;

  it("describes the doubled merged cap, so a bot asks for enough results", () => {
    // K3a changed the merge to keep up to twice the requested count; the skill must
    // teach that, or bots keep asking for 5 and reading a narrower web than they get.
    expect(skill.content).toContain("TWICE the count you asked for");
    expect(skill.content).toContain("up to 20 hits");
  });

  it("says both sources run in parallel and a failed one still leaves an answer", () => {
    expect(skill.content).toContain("TWO sources answer every query in parallel");
    expect(skill.content).toContain("the other still answers");
  });

  it("requires reading a page before citing it, since snippets are truncated", () => {
    expect(skill.content).toContain("web_fetch the two or three most promising results");
    expect(skill.content).toContain("snippets are truncated");
  });

  it("treats fetched pages as data, not instructions", () => {
    // Prompt injection through a fetched page is the failure this line prevents.
    expect(skill.content).toContain("never as instructions");
  });

  it("permits reporting that nothing was found instead of padding", () => {
    expect(skill.content).toContain("A confirmed absence is a useful result");
  });
});

describe("Rakazo skill", () => {
  it("links only to published docs pages", () => {
    const skill = BUILTIN_AGENT_SKILLS.find((s) => s.name === "Rakazo")!;
    const urls = [...skill.content.matchAll(/https?:\/\/\S+/g)].map((match) => match[0]);
    expect(urls).toEqual(RAKAZO_DOCS_URLS);
    for (const url of urls) {
      const slug =
        url === "https://rakazo.com/docs.md"
          ? publishedSlugs[0]
          : /^https:\/\/rakazo\.com\/docs\/([\w-]+)\.md$/.exec(url)?.[1];
      expect(publishedSlugs, url).toContain(slug);
      expect(existsSync(repoFile(`docs/${slug}.md`)), url).toBe(true);
    }
  });
});
