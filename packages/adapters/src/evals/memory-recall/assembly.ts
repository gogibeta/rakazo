import type { AdapterContext, MemoryStore } from "@rakazo/adapter-kit";
import type { MemoryPromptDocument } from "../../memory-context.js";
import {
  AGENT_MEMORY_MAX_BYTES,
  buildAgentMemoryPrompt,
  readAgentMemory,
} from "../../memory-context.js";
import type { EvalQuestion } from "./fixtures.js";
import type { QuestionResult } from "./results.js";
import { summarize } from "./results.js";

export type Layer1Outcome = {
  /** The assembled context text, exactly as the run would receive it. */
  text: string | undefined;
  results: QuestionResult[];
  summary: ReturnType<typeof summarize>;
};

/**
 * Layer 1: assemble the memory context from already-loaded documents and
 * record, per question, whether its fact reached the prompt. This is the
 * same `buildAgentMemoryPrompt` production runs; the plan it returns (which
 * documents were included, omitted, truncated, and the byte total) is
 * recorded verbatim in every question's result.
 */
export function assembleLayer1(
  documents: readonly MemoryPromptDocument[],
  questions: readonly EvalQuestion[],
  maxBytes: number = AGENT_MEMORY_MAX_BYTES,
): Layer1Outcome {
  const { text, plan } = buildAgentMemoryPrompt(documents, maxBytes);
  const includedDocs = plan.documents.map((doc) => `${doc.scope}:${doc.path}`);
  const omittedDocs = plan.omitted.map((doc) => `${doc.scope}:${doc.path}`);
  const haystack = (text ?? "").toLowerCase();
  const results = questions.map((question) => ({
    id: question.id,
    layer1: {
      factInContext: question.contextNeedles.some((needle) =>
        haystack.includes(needle.toLowerCase()),
      ),
      includedDocs,
      omittedDocs,
      usedBytes: plan.usedBytes,
    },
  }));
  return { text, results, summary: summarize(results, questions) };
}

/**
 * Layer 1 against a live memory store: reads the bot's and the user's
 * documents through `readAgentMemory` and assembles them with the same
 * builder `loadAgentMemoryContext` uses, keeping the plan the context
 * loader discards. Used for the production-corpus run against a scratch
 * space seeded through `MarkdownMemoryStore`.
 */
export async function assembleLayer1FromStore(
  memory: MemoryStore,
  botId: string,
  context: AdapterContext,
  questions: readonly EvalQuestion[],
  maxBytes: number = AGENT_MEMORY_MAX_BYTES,
): Promise<Layer1Outcome> {
  const documents = await readAgentMemory(memory, botId, context);
  return assembleLayer1(documents, questions, maxBytes);
}
