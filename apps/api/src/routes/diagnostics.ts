import { renderDiagnostics } from "../diagnostics.js";
import { collectDiagnostics, diagnosticsEnvFields } from "../diagnostics-collect.js";
import type { RouterContext } from "./context.js";

export function diagnosticsRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    diagnostics: {
      // The same redacted report as the operator CLI, scoped to the signed-in
      // user's own bots and runs, so it can be copied and shared for support.
      report: authed.diagnostics.report.handler(async ({ context }) => {
        const input = await collectDiagnostics(diagnosticsEnvFields(deps.env), deps.prisma, {
          userId: context.actor.userId,
        });
        return { report: renderDiagnostics(input) };
      }),
    },
  };
}
