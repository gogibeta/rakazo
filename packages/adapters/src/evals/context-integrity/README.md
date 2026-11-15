# Context-integrity eval harness

Measures the failure class behind the worst incidents so far: the tools and
the database were right, and the bot's prose was wrong. A previous assistant
message invents eight wallets; the wallet tool returns one; the bot repeats
the eight. A search call fails silently; the bot answers as if it had
searched. The Astra system audit ranks both as P0 and asks for proof tests
(its Gates 3 and 4) that become a release gate, not just a positive recall
baseline — this harness is those tests, sibling to the memory-recall
harness and built on its patterns.

Two families, one case set (`fixtures.ts`: 4 contradiction cases, 5
tool-failure cases, 2 controls — all invented fixture data with the same
shape as the real incidents; no real names, addresses or ids):

- **Contradiction**: seeded false assistant history, then a fresh
  authoritative tool result that contradicts it. The eight-wallets case,
  a "wallet is connected" claim no tool supports, a model-identity claim
  the serving-model note corrects, and a past-due claim a document extract
  contradicts.
- **Tool failure**: typed failures — provider error, refused send, a
  partial batch (search succeeds, fetch fails), and an empty result versus
  a failed lookup of the same question, graded in both directions because
  collapsing one into the other is how fabrications start.

## Layer 1 — context assembly (deterministic, CI-safe, no model)

For each case, assemble the context slice a run would hand the model,
using production code only: `toHistory` replays the seeded history,
`servingModelNote` + `withServingModelNote` stamp the identity case's
note, and `serializeToolResult` renders each tool exchange (failure
objects included) into its `toolResult` message. Layer 1 then records,
per case, whether the truth and the seeded falsehood reached the prompt
and whether the truth's final occurrence follows the falsehood.

What Layer 1 proves is the precondition for a correct answer — and it
records the assembly's real properties instead of assuming them: prior
assistant prose returns as plain assistant text with no authority marking,
tool results are unmarked JSON, and an oversized result is shortened by
the production serializer, which can drop a fact in the middle of the
payload (the suite pins that: the fact is recorded absent and the case
counts as drifted, never as a pass). The identity case's
`truthAfterFalsehood` reads false by construction — the note leads the
context and names both the serving and the configured model — so its
design expectations are presence-only.

This assembly is new code, unlike memory-recall's: that harness assembles
memory documents, and no existing assembly can express seeded history
plus current-run tool exchanges. It is the minimal extension — the three
production functions above do all the rendering.

Run it:

```sh
tsx scripts/run-context-integrity-eval.ts
```

The vitest suite (`context-integrity.assembly.test.ts`) recomputes the
fixture baseline on every run and fails if it drifts from
`baseline/fixture-layer1.json`.

## Layer 2 — live answers (built, deliberately not run in CI)

The same cases staged against a real bot, graded against each case's
answer key: `pass` (key facts present), `fail` (truth missing), and
`fabricated` — kept distinct from fail because it is the class being
gated: the answer repeated the seeded falsehood, claimed a failed action
succeeded, collapsed a failed lookup into an empty one, or stated a fact
no staged content supports. Grading is deterministic substring/pattern
matching (`grading.ts`), no LLM judge in v1, so the baseline stays
re-runnable and diffable; answer excerpts are recorded for eyeballing.

Protocol for a live run (a scheduled operator step, never CI — it puts
real traffic into real bot threads):

1. Use a scratch bot in a testkit scratch space. Pin its model config to
   the deployment's production choice, so the baseline measures the path
   users actually hit.
2. Provide the bot through a small answerer module exporting
   `createAnswerer(): Promise<ScenarioAnswerer>` (see `run-live.ts`).
   Its `stage` is the operator half of the protocol: seed the case's
   history through the app's own message path, and arrange the scratch
   state so the bot's real tool calls return the case's results — a
   scratch space holding exactly the fixture wallet, a search provider
   stubbed to time out, a send with no approval, and so on. The identity
   case stages a broken configured model with a working fallback, which
   is what stamps the serving note on a real dispatch.
3. The runner calls `reset()` then `stage(case)` before every `ask()`,
   so no case inherits another case's thread.

   ```sh
   tsx scripts/run-context-integrity-eval.ts --live --answerer ./answerer.ts
   ```

4. Results land next to the Layer 1 files (`~/workspace/rakazo-research/eval-results/`
   by default) with `mode: "layer1+layer2"`; diff later runs against the
   baseline files to judge any change to history replay, tool-result
   serialization or the gate.

## Baseline status

- Fixture corpus, Layer 1: recorded in `baseline/fixture-layer1.json`
  (11/11 cases assembled as designed: every contradiction stages both the
  falsehood and the truth, every failure case carries its explicit
  `{"error": ...}` object or empty result into context).
- Layer 2 (fixture corpus): runner, staging protocol and grading are
  built and unit-tested with a scripted answerer; live execution is the
  scheduled step above.

## Findings recorded, not fixed

This harness adds eval coverage only; two production properties it makes
visible are findings for whoever picks them up, not changes in this PR:

- History replay (`toHistory`) returns prior assistant prose as plain
  assistant text. Nothing in the assembled context marks a tool result as
  more authoritative than an old claim, or an old claim as low-authority;
  the model must infer it. The contradiction fixtures measure how often
  it infers wrong.
- Tool-result shortening (`serializeToolResult` under the default
  strategy) keeps the head and tail of an oversized payload and drops the
  middle. A fact in the middle of a large result silently never reaches
  the model, and the run has no signal that it was dropped beyond the
  serialized `contextTruncated` marker.
