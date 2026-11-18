import { ORPCError } from "@orpc/server";
import { PluginRefusedError } from "@rakazo/adapters";

/** The generic line, kept only for failures that say nothing about the plugin itself. */
export const PREVIEW_FAILED = "Could not preview a supported plugin from this repository";

/**
 * What to tell someone whose plugin preview was refused. A refusal names what about
 * the repository cannot be installed, so the panel can say that instead of the
 * generic line; anything else (a network failure, a bug) keeps the generic copy.
 */
export function previewRefusal(error: unknown): ORPCError<"BAD_REQUEST", { reason?: string }> {
  if (error instanceof PluginRefusedError)
    return new ORPCError("BAD_REQUEST", { message: error.message, data: { reason: error.reason } });
  return new ORPCError("BAD_REQUEST", { message: PREVIEW_FAILED });
}
