import { ORPCError } from "@orpc/server";
import type { HostRestarter } from "@rakazo/adapters";
import { createInstaboxHostRestarter, createRemoteHostRestarter } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { requireAdmin } from "./admins.js";
import type { RouterDeps } from "./router.js";

export interface DeploymentHostDeps {
  prisma: RouterDeps["prisma"];
  env: Pick<
    RouterDeps["env"],
    "adminEmails" | "instaboxApiKey" | "instaboxMachineId" | "hostRestartUrl" | "hostRestartSecret"
  >;
  /** Test seam: the restarter to use instead of the one the environment configures. */
  hostRestarter?: HostRestarter;
}

/**
 * The host restarter the environment configures, if any. An external
 * restarter wins when both its endpoint and its shared secret are set: it
 * performs the power-cycle from outside the machine. Otherwise the sandbox
 * provider's key plus the id of the one machine a restart may target
 * configure the direct path. Either configuration missing its pair disables
 * the feature, and the settings page says so.
 */
function configuredRestarter(deps: DeploymentHostDeps): HostRestarter | undefined {
  if (deps.hostRestarter) return deps.hostRestarter;
  const { hostRestartUrl, hostRestartSecret, instaboxApiKey, instaboxMachineId } = deps.env;
  if (hostRestartUrl && hostRestartSecret) {
    return createRemoteHostRestarter({ url: hostRestartUrl, secret: hostRestartSecret });
  }
  if (!instaboxApiKey || !instaboxMachineId) return undefined;
  return createInstaboxHostRestarter({ apiKey: instaboxApiKey, machineId: instaboxMachineId });
}

export async function getDeploymentHostStatus(
  deps: DeploymentHostDeps,
  actor: Actor,
): Promise<{ restartConfigured: boolean }> {
  await requireAdmin(deps, actor.userId);
  return { restartConfigured: Boolean(configuredRestarter(deps)) };
}

export async function restartDeploymentHost(
  deps: DeploymentHostDeps,
  actor: Actor,
): Promise<{ initiated: true }> {
  await requireAdmin(deps, actor.userId);
  const restarter = configuredRestarter(deps);
  if (!restarter)
    throw new ORPCError("PRECONDITION_FAILED", {
      message: "Host restart is not configured on this deployment.",
    });
  await restarter.restart();
  return { initiated: true };
}
