/**
 * Context-integrity eval driver. See packages/adapters/src/evals/context-integrity/README.md.
 *
 * Layer 1 (default): assemble every fixture case's context slice through the
 * production history-replay, serving-note and tool-result-serialization code
 * and record whether the truth (and the seeded falsehood) reached the prompt.
 *
 * Layer 2 (--live --answerer <module>): also stage every case against a live
 * bot and grade its answers. The module must export
 * `createAnswerer(): Promise<ScenarioAnswerer>`. Live runs are a scheduled
 * operator step, never CI: they put real traffic into real bot threads.
 *
 * Run with tsx:
 *   tsx scripts/run-context-integrity-eval.ts [--live --answerer ./answerer.ts] [--out result.json]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { assembleLayer1 } from "../packages/adapters/src/evals/context-integrity/assembly.js";
import { CASES } from "../packages/adapters/src/evals/context-integrity/fixtures.js";
import type { EvalRunRecord } from "../packages/adapters/src/evals/context-integrity/results.js";
import { formatSummary } from "../packages/adapters/src/evals/context-integrity/results.js";
import type { ScenarioAnswerer } from "../packages/adapters/src/evals/context-integrity/run-live.js";
import { runLiveEval } from "../packages/adapters/src/evals/context-integrity/run-live.js";

const { values } = parseArgs({
  options: {
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

async function main(): Promise<void> {
  const date = new Date().toISOString();
  const layer1 = assembleLayer1(CASES);

  let record: EvalRunRecord;
  if (values.live) {
    if (!values.answerer) throw new Error("--live requires --answerer <module>");
    const module = (await import(path.resolve(values.answerer))) as {
      createAnswerer: () => Promise<ScenarioAnswerer>;
    };
    const answerer = await module.createAnswerer();
    record = await runLiveEval({
      answerer,
      cases: CASES,
      layer1Results: layer1.results,
      gitSha: gitSha(),
      date,
    });
  } else {
    record = {
      gitSha: gitSha(),
      mode: "layer1",
      corpus: "fixture",
      date,
      cases: layer1.results,
      summary: layer1.summary,
    };
  }

  const outFile =
    values.out ??
    path.join(
      homedir(),
      "workspace/rakazo-research/eval-results",
      `${date.slice(0, 10)}-context-integrity-${record.mode}.json`,
    );
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify(record, null, 2)}\n`);
  console.log(formatSummary(record, CASES));
  console.log(`\nWrote ${outFile}`);
}

await main();
