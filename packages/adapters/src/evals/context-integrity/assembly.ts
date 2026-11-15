import type { AssistantMessage, Context, Message } from "@earendil-works/pi-ai";
import { servingModelNote } from "../../pi-runtime.js";
import { toHistory } from "../../pi-runtime-history.js";
import { serializeToolResult } from "../../pi-runtime-tools.js";
import { withServingModelNote } from "../../pi-usage.js";
import { isToolError } from "../../run-tools.js";
import type { EvalCase } from "./fixtures.js";
import type { CaseResult } from "./results.js";
import { summarize } from "./results.js";

export type Layer1Outcome = {
  /** Each case's assembled context flattened to one transcript, in case order — the text Layer 1 checks needles against. */
  texts: string[];
  results: CaseResult[];
  summary: ReturnType<typeof summarize>;
};

const NO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * Builds the case's context slice with production code only:
 *
 * - the serving-model note, when the case carries one, is produced by
 *   `servingModelNote` and stamped by `withServingModelNote`, as a dispatch
 *   stamps it;
 * - history is replayed by `toHistory`, the same conversion a real run
 *   applies to stored messages (prior assistant prose comes back as plain
 *   assistant text — nothing marks it as less authoritative than a tool
 *   result; that is the condition these fixtures exist to measure);
 * - each tool exchange becomes an assistant tool call plus a `toolResult`
 *   message whose text is `serializeToolResult`'s output for the handler's
 *   result object, failure objects included.
 *
 * The full instruction prompt is deliberately not part of the slice: Layer 1
 * answers one question — did the authoritative content (and, for
 * contradiction cases, the falsehood it must beat) reach the prompt, in
 * production order?
 */
export function assembleCaseContext(evalCase: EvalCase): Context {
  const messages: Message[] = [];
  let context: Context = { messages };
  if (evalCase.servingModel) {
    const { configured, active, fallbackReason } = evalCase.servingModel;
    context = withServingModelNote(context, servingModelNote(configured, active, fallbackReason));
    messages.push(...context.messages);
  }
  messages.push(...toHistory(evalCase.history, evalCase.question));
  evalCase.toolExchanges.forEach((exchange, index) => {
    const toolCallId = `eval-call-${index}`;
    const call: AssistantMessage = {
      role: "assistant",
      content: [
        { type: "toolCall", id: toolCallId, name: exchange.toolName, arguments: exchange.args },
      ],
      api: "rakazo-history",
      provider: "rakazo-history",
      model: "history",
      usage: NO_USAGE,
      stopReason: "toolUse",
      timestamp: 0,
    };
    messages.push(call, {
      role: "toolResult",
      toolCallId,
      toolName: exchange.toolName,
      content: [
        {
          type: "text",
          text: serializeToolResult(exchange.result, undefined, exchange.toolName, exchange.args),
        },
      ],
      isError: isToolError(exchange.result),
      timestamp: 0,
    });
  });
  messages.push({ role: "user", content: evalCase.question, timestamp: 0 });
  return { messages };
}

/** Flattens a context to the transcript Layer 1 reads: system text and sections, then each message's text in order. */
export function contextText(context: Context): string {
  return context.messages.map(messageText).join("\n");
}

function messageText(message: Message): string {
  if (message.role === "system") {
    const sections = Object.values(message.sections ?? {}).filter(
      (section): section is string => typeof section === "string",
    );
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => part.text).join("\n");
    return [content, ...sections].filter(Boolean).join("\n");
  }
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "toolCall") return `[tool call: ${part.name}]`;
      return `[${part.type}]`;
    })
    .join("\n");
}

/**
 * Layer 1: assemble every case and record, per case, whether the truth and
 * the seeded falsehood reached the prompt and whether the truth follows the
 * falsehood (a current-run tool result always lands after replayed history).
 * A case whose assembly drifts from its design — a fact the serializer
 * shortened away, a falsehood history replay dropped — is recorded as
 * drifted, never silently passed.
 */
export function assembleLayer1(cases: readonly EvalCase[]): Layer1Outcome {
  const contexts = cases.map(assembleCaseContext);
  const texts = contexts.map(contextText);
  const results = cases.map((evalCase, index) => {
    const haystack = texts[index]!.toLowerCase();
    const truthInContext =
      evalCase.truthNeedles.length > 0 &&
      evalCase.truthNeedles.every((needle) => haystack.includes(needle.toLowerCase()));
    const falsehoodInContext = evalCase.falsehoodNeedle
      ? haystack.includes(evalCase.falsehoodNeedle.toLowerCase())
      : false;
    // The truth's LAST occurrence is what counts: a falsehood can itself name
    // the true item (the "connected wallet" claim names the real wallet), so
    // the first occurrence can sit inside the seeded prose. The current
    // run's tool result must be the final word on it.
    const truthIndex = evalCase.truthNeedles.length
      ? haystack.lastIndexOf(evalCase.truthNeedles[0]!.toLowerCase())
      : -1;
    const falsehoodIndex = evalCase.falsehoodNeedle
      ? haystack.indexOf(evalCase.falsehoodNeedle.toLowerCase())
      : -1;
    return {
      id: evalCase.id,
      layer1: {
        truthInContext,
        falsehoodInContext,
        truthAfterFalsehood: truthIndex >= 0 && falsehoodIndex >= 0 && truthIndex > falsehoodIndex,
        contextBytes: new TextEncoder().encode(texts[index]).length,
      },
    };
  });
  return { texts, results, summary: summarize(results, cases) };
}

/** Assembles one case and returns its context and transcript together (runner and tests). */
export function assembleCase(evalCase: EvalCase): { context: Context; text: string } {
  const context = assembleCaseContext(evalCase);
  return { context, text: contextText(context) };
}
