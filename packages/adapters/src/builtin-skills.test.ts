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
