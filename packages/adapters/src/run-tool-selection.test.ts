import { describe, expect, it } from "vitest";
import { FRESH_CONTEXT_EXCLUDED_TOOLS } from "./pi-runtime-subagent.js";
import { selectBuiltinToolsForRun } from "./run-tool-selection.js";

/**
 * The background path shipped without a test, and that is how its deny-list drifted from the
 * foreground one: the foreground list was pinned by a test, while this path kept a second copy
 * that nothing compared to it. Both paths now read one definition, and this suite holds the
 * background half to it.
 */
describe("selectBuiltinToolsForRun with freshContext", () => {
  const base = {
    ticketBoardEnabled: true,
    historyRetrievalEnabled: true,
    graphicalToolsAllowed: true,
    groupId: null,
    trigger: "user",
    semanticMemoryEnabled: true,
    semanticMemoryForgets: true,
    messagingChannelRun: false,
    // A bot with an address and a claimed mailbox: `read_email` is only offered to one that has
    // it (`emailInbox`, or having been offered the claim), so the "offers them all" half needs
    // this or it would wrongly report read_email missing.
    emailInbox: true,
  } as const;

  const names = (options: Record<string, unknown>) =>
    selectBuiltinToolsForRun({ ...base, ...options }).map((tool) => tool.name);

  it("withholds every excluded tool, and offers them all when the flag is absent", () => {
    const withheld = names({ freshContext: true });
    for (const name of FRESH_CONTEXT_EXCLUDED_TOOLS) {
      expect(withheld).not.toContain(name);
    }
    // Without this half the assertion above would pass on a list filtered out for an unrelated
    // reason, so the tools must really be available on an ordinary run.
    const normal = names({});
    for (const name of FRESH_CONTEXT_EXCLUDED_TOOLS) {
      expect(normal).toContain(name);
    }
  });

  it("keeps the workspace tools, because the document may name files to open", () => {
    const withheld = names({ freshContext: true });
    expect(withheld.some((name) => name === "read_file" || name === "shell")).toBe(true);
  });

  it("holds back the inventory tools that only look harmless", () => {
    // Read-only tools are not safe in a clean room when what they read is the bot's own earlier
    // work: task_catalog is its open tasks and saved routines, scratchpad_list its parked todos,
    // skill_list / skill_read the skills it wrote in earlier runs, schedule_list its routines
    // -- each routine's prompt is text the bot wrote about what it was working on -- and
    // read_email its own mailbox, which is its earlier correspondence.
    const withheld = names({ freshContext: true });
    for (const name of [
      "task_catalog",
      "scratchpad_list",
      "skill_list",
      "skill_read",
      "schedule_list",
      "read_email",
    ]) {
      expect(withheld).not.toContain(name);
    }
  });
});
