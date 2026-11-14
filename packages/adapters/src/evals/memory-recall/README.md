# Memory-recall eval harness

Measures how well the current memory path recalls, before search-then-expand
replaces the ≤32 KB wholesale injection (`readAgentMemory` →
`buildAgentMemoryPrompt`). Without this baseline, "memory got better" is
unfalsifiable. Two layers, one question set (`fixtures.ts`: 12 scored
questions + 3 fabrication controls, all built from data-level deployment
facts — counts and names, no secrets).

## Layer 1 — context assembly (deterministic, CI-safe, no model)

For each question, assemble the run context exactly as production does and
check whether the answer fact is present in the assembled text, recording
the builder's plan verbatim (included/omitted documents, bytes used). A
question whose fact never reaches the prompt cannot be answered from
memory, whatever the model does — Layer 1 separates retrieval failure from
model failure. Controls carry needles for facts that must _not_ be in
memory; a control whose needles appear is leaking.

Run it:

```sh
tsx scripts/run-memory-eval.ts                      # fixture corpus
tsx scripts/run-memory-eval.ts --documents prod.json # production corpus export
```

`--documents` takes a JSON array of `{ scope, path, revision, updatedAt?,
content }` exported from the deployment's memory documents. Production
documents and production results are deployment data: they live outside
this repo (`~/workspace/rakazo-research/eval-results/<date>-<corpus>-<mode>.json`)
and are never committed. The vitest suite (`memory-recall.assembly.test.ts`)
recomputes the fixture baseline on every run and fails if it drifts from
`baseline/fixture-layer1.json`.

## Layer 2 — live answers (built, deliberately not run in CI)

The same questions put to a real bot, graded against the answer key:
`pass` (key fact present), `fail` (wrong/absent), `fabricated` (a confident
specific answer to a control question — the controls exist to catch exactly
this). Grading is deterministic substring/alias matching (`grading.ts`); no
LLM judge in v1, so the baseline stays re-runnable and diffable.

Protocol for a live run (a scheduled operator step, never CI — it puts
12 questions × runs of real traffic into real bot threads):

1. Use a scratch bot in a testkit scratch space (the `*.postgres.test.ts`
   pattern), seeded with the fixture documents through
   `MarkdownMemoryStore` — the same store production reads through. For the
   production-corpus variant, skip seeding and point the bot at the
   deployment's actual memory.
2. Pin the bot's model config to the deployment's production choice
   (Chief's model), so the baseline measures the path users actually hit.
3. One run per question, fresh session per question (the runner calls
   `reset()` before every `ask()`), so answers come from durable memory
   alone, never from an earlier question's conversation.
4. Provide the bot through a small answerer module exporting
   `createAnswerer(): Promise<LiveAnswerer>` (see `run-live.ts`) and run:

   ```sh
   tsx scripts/run-memory-eval.ts --live --answerer ./answerer.ts
   ```

5. Results land next to the Layer 1 files with `mode: "layer1+layer2"`;
   diff later runs against the baseline files to judge any memory change.

## Baseline status

- Fixture corpus, Layer 1: recorded in `baseline/fixture-layer1.json`
  (12/12 facts present, 3/3 controls clean — the fixture corpus is sized to
  fit, so this is the ceiling the production numbers are read against).
- Production corpus, Layer 1: supported via `--documents`; runs against
  the deployment's exported documents and is recorded outside the repo.
  Expect most facts absent — they live in database rows and tools, not in
  memory documents. That is the honest "today" number the memory phase
  must beat for facts that are supposed to be in memory.
- Layer 2 (either corpus): runner, grading and recording are built and
  unit-tested with a scripted answerer; live execution is the scheduled
  step above.
