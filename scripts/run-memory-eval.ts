/**
 * Memory-recall eval driver. See packages/adapters/src/evals/memory-recall/README.md.
 *
 * Layer 1 (default): assemble the memory context for a corpus and record
 * which answer facts reach the prompt. Corpus is the committed fixture set,
 * or a production export passed with --documents <file.json> (an array of
 * { scope, path, revision, updatedAt?, content } — exported from the
 * deployment, never committed).
 *
 * Layer 2 (--live --answerer <module>): also put every question to a live
 * bot. The module must export `createAnswerer(): Promise<LiveAnswerer>`.
 * Live runs are a scheduled operator step, never CI: they put real traffic
 * into real bot threads.
 *
 * Run with tsx (as with `pnpm test:evals`):
 *   tsx scripts/run-memory-eval.ts [--documents prod.json] [--live --answerer ./answerer.ts] [--out result.json]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { assembleLayer1 } from "../packages/adapters/src/evals/memory-recall/assembly.js";
import {
  FIXTURE_DOCUMENTS,
  QUESTIONS,
} from "../packages/adapters/src/evals/memory-recall/fixtures.js";
import type { EvalRunRecord } from "../packages/adapters/src/evals/memory-recall/results.js";
import { formatSummary } from "../packages/adapters/src/evals/memory-recall/results.js";
import type { LiveAnswerer } from "../packages/adapters/src/evals/memory-recall/run-live.js";
import { runLiveEval } from "../packages/adapters/src/evals/memory-recall/run-live.js";
import type { MemoryPromptDocument } from "../packages/adapters/src/memory-context.js";

const { values } = parseArgs({
  options: {
    documents: { type: "string" },
    live: { type: "boolean", default: false },
    answerer: { type: "string" },
    out: { type: "string" },
  },
});

function gitSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function loadDocuments(file: string): MemoryPromptDocument[] {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Array<Record<string, unknown>>;
  return parsed.map((entry, index) => {
    if (
      (entry.scope !== "bot" && entry.scope !== "user") ||
      typeof entry.path !== "string" ||
      typeof entry.content !== "string"
    ) {
      throw new Error(`documents[${index}] must have scope ("bot"|"user"), path and content`);
    }
    return {
      scope: entry.scope,
      path: entry.path,
      revision: typeof entry.revision === "number" ? entry.revision : 1,
      updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : undefined,
      content: entry.content,
    };
  });
}

async function main(): Promise<void> {
  const corpus: EvalRunRecord["corpus"] = values.documents ? "production" : "fixture";
  const documents = values.documents ? loadDocuments(values.documents) : FIXTURE_DOCUMENTS;
  const date = new Date().toISOString();
  const layer1 = assembleLayer1(documents, QUESTIONS);

  let record: EvalRunRecord;
  if (values.live) {
    if (!values.answerer) throw new Error("--live requires --answerer <module>");
    const module = (await import(path.resolve(values.answerer))) as {
      createAnswerer: () => Promise<LiveAnswerer>;
    };
    const answerer = await module.createAnswerer();
    record = await runLiveEval({
      answerer,
      questions: QUESTIONS,
      layer1Results: layer1.results,
      corpus,
      gitSha: gitSha(),
      date,
    });
  } else {
    record = {
      gitSha: gitSha(),
      mode: "layer1",
      corpus,
      date,
      questions: layer1.results,
      summary: layer1.summary,
    };
  }

  const outFile =
    values.out ??
    path.join(
      homedir(),
      "workspace/rakazo-research/eval-results",
      `${date.slice(0, 10)}-${corpus}-${record.mode}.json`,
    );
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify(record, null, 2)}\n`);
  console.log(formatSummary(record, QUESTIONS));
  console.log(`\nWrote ${outFile}`);
}

await main();
