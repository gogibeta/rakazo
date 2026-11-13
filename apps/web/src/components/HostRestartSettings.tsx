import { Trans, useLingui } from "@lingui/react/macro";
import { Button, SectionHeading } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useSpaceQueries } from "../lib/query";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";

/**
 * Power-cycle the machine this deployment runs on. Admins only; the button
 * stays disabled until the server says a host machine is configured, because
 * a restart aimed nowhere would only confuse.
 */
export function HostRestartSettings() {
  const { t } = useLingui();
  const me = useQuery(useSpaceQueries().me.queryOptions());
  const isAdmin = Boolean(me.data?.isAdmin);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [initiated, setInitiated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdmin) return;
    let alive = true;
    rpc.deployment
      .hostStatus()
      .then((status) => {
        if (alive) setConfigured(status.restartConfigured);
      })
      .catch((caught: unknown) => {
        if (alive) setError(errorText(caught, t`Could not load host status`));
      });
    return () => {
      alive = false;
    };
  }, [isAdmin, t]);

  if (!isAdmin) return null;

  async function restart() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await rpc.deployment.restartHost();
      setInitiated(true);
      setConfirming(false);
    } catch (caught) {
      setError(errorText(caught, t`Could not restart the virtual machine`));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="space-y-3">
      <SectionHeading>
        <Trans>Virtual machine</Trans>
      </SectionHeading>
      {configured === false ? (
        <p className="text-body-sm text-muted-foreground">
          <Trans>Restart is not configured on this deployment.</Trans>
        </p>
      ) : null}
      {initiated ? (
        <p className="text-body-sm text-muted-foreground">
          <Trans>Restarting. The app will be unreachable until the machine boots again.</Trans>
        </p>
      ) : confirming ? (
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={pending}
            onClick={() => void restart()}
          >
            <Trans>Confirm restart</Trans>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => setConfirming(false)}
          >
            <Trans>Cancel</Trans>
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          variant="destructive"
          size="sm"
          disabled={pending || configured !== true}
          onClick={() => setConfirming(true)}
        >
          <Trans>Restart virtual machine</Trans>
        </Button>
      )}
      {error ? (
        <p role="alert" className="text-body-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
