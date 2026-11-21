import { promptVersion } from "@rakazo/core";

/** The slice of the data layer this helper needs, so tests can pass a narrow fake. */
export type RunPromptVersionStore = {
  run: {
    update(args: { where: { id: string }; data: { promptVersion: string } }): Promise<unknown>;
  };
};

/**
 * Records which prompt version a run executes with, then returns the run request unchanged so
 * it can be passed straight through to the runtime. The version is derived from the prompt
 * text itself (see promptVersion), so editing a prompt produces a new version with no manual
 * bump and every run stays traceable to the exact prompt it ran under. The write is
 * best-effort: it is observational, so a failure never blocks or fails the run.
 */
export function trackRunPromptVersion<T extends { instructions: string }>(
  store: RunPromptVersionStore,
  runId: string,
  request: T,
): T {
  try {
    void store.run
      .update({
        where: { id: runId },
        data: { promptVersion: promptVersion(request.instructions) },
      })
      .catch(() => undefined);
  } catch {
    // Observational only: an absent or failing data layer must never block a run.
  }
  return request;
}
