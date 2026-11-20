/**
 * Shutdown order for the API server, kept apart from `index.ts` so it can be tested: that module
 * starts listening at import time and cannot be imported by a test.
 *
 * The order matters. `closeServer` stops accepting new connections but leaves the existing ones
 * open, so a handler already running can still write its response. `stopAcceptingWork` is the
 * drain: it waits, up to its own deadline, for those handlers to finish. Only then are sockets
 * destroyed, which is what ends the connections that never close on their own (SSE streams,
 * keep-alive). Awaiting `closed` last means the process waits for real work, not for the grace
 * period to expire.
 */
export interface DrainSteps {
  /** Stops accepting new connections; resolves once the listening handle is closed. */
  closeServer: () => Promise<void>;
  /** Waits for in-flight handlers to finish, bounded by the caller's own timeout. */
  stopAcceptingWork: () => Promise<void>;
  /** Destroys sockets that keep themselves open, such as SSE and keep-alive connections. */
  destroySockets: () => void;
}

export async function drainServer(steps: DrainSteps): Promise<void> {
  const closed = steps.closeServer();
  await steps.stopAcceptingWork();
  steps.destroySockets();
  await closed;
}
