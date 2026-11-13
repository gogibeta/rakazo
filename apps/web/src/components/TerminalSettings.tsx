import { Trans } from "@lingui/react/macro";
import { TERMINAL_PATH } from "@rakazo/contracts";
import { Button, SectionHeading } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useSpaceQueries } from "../lib/query";

type TerminalState = "connecting" | "open" | "unavailable";

/**
 * A shell in the API's own environment, over the socket the API gates on the
 * admin session. The emulator loads only when an admin opens this page, and a
 * refused or dropped socket reads as unavailable rather than an error.
 */
export function TerminalSettings() {
  const me = useQuery(useSpaceQueries().me.queryOptions());
  const isAdmin = Boolean(me.data?.isAdmin);
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<TerminalState>("connecting");
  const [session, setSession] = useState(0);

  useEffect(() => {
    if (!isAdmin || !containerRef.current) return;
    let disposed = false;
    let socket: WebSocket | undefined;
    let disposeTerminal: (() => void) | undefined;
    setState("connecting");
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      await import("@xterm/xterm/css/xterm.css");
      if (disposed || !containerRef.current) return;
      const terminal = new Terminal({ convertEol: true, fontSize: 13 });
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(containerRef.current);
      fitAddon.fit();
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}${TERMINAL_PATH}`);
      socket.onopen = () => {
        if (!disposed) setState("open");
      };
      socket.onmessage = (event) => terminal.write(String(event.data));
      socket.onclose = () => {
        if (!disposed) setState("unavailable");
      };
      socket.onerror = () => {
        if (!disposed) setState("unavailable");
      };
      terminal.onData((data) => {
        // The shell sits on a pipe, not a PTY: Enter must arrive as a newline.
        if (socket?.readyState === WebSocket.OPEN) socket.send(data.replace(/\r/g, "\n"));
      });
      const onResize = () => fitAddon.fit();
      window.addEventListener("resize", onResize);
      disposeTerminal = () => {
        window.removeEventListener("resize", onResize);
        terminal.dispose();
      };
    })().catch(() => {
      if (!disposed) setState("unavailable");
    });
    return () => {
      disposed = true;
      socket?.close();
      disposeTerminal?.();
    };
  }, [isAdmin, session]);

  if (!isAdmin) return null;

  return (
    <section className="space-y-3">
      <SectionHeading>
        <Trans>Terminal</Trans>
      </SectionHeading>
      <div ref={containerRef} className="overflow-hidden rounded-lg" data-testid="admin-terminal" />
      {state === "unavailable" ? (
        <div className="flex items-center gap-3">
          <p className="text-body-sm text-muted-foreground">
            <Trans>Terminal unavailable.</Trans>
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setSession((value) => value + 1)}
          >
            <Trans>Reconnect</Trans>
          </Button>
        </div>
      ) : null}
    </section>
  );
}
