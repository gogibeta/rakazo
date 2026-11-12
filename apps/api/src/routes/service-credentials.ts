import {
  clearServiceCredentials,
  getServiceCredentials,
  updateServiceCredentials,
} from "../service-credentials-config.js";
import type { RouterContext } from "./context.js";

export function serviceCredentialsRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    serviceCredentials: {
      get: authed.serviceCredentials.get.handler(({ context }) =>
        getServiceCredentials(deps, context.actor),
      ),
      update: authed.serviceCredentials.update.handler(({ context, input }) =>
        updateServiceCredentials(deps, context.actor, input),
      ),
      clear: authed.serviceCredentials.clear.handler(({ context, input }) =>
        clearServiceCredentials(deps, context.actor, input),
      ),
    },
  };
}
