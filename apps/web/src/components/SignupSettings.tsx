import { Trans, useLingui } from "@lingui/react/macro";
import type { ServiceCredentialsStatus } from "@rakazo/contracts";
import { Label, SectionHeading, Switch } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { useSpaceQueries } from "../lib/query";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";

/**
 * The account-creation switch for the deployment. It rides the service
 * credentials calls, whose status reports the switch as the signup gate
 * sees it; flipping it applies at once, with no restart.
 */
export function SignupSettings() {
  const { t } = useLingui();
  const me = useQuery(useSpaceQueries().me.queryOptions());
  const switchId = useId();
  const [status, setStatus] = useState<ServiceCredentialsStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isAdmin = Boolean(me.data?.isAdmin);

  useEffect(() => {
    if (!isAdmin) return;
    let alive = true;
    rpc.serviceCredentials
      .get()
      .then((next) => {
        if (alive) setStatus(next);
      })
      .catch((caught: unknown) => {
        if (alive) setError(errorText(caught, t`Could not load access settings`));
      });
    return () => {
      alive = false;
    };
  }, [isAdmin, t]);

  if (!isAdmin) return null;
  if (!status) {
    return error ? (
      <p role="alert" className="text-body-sm text-destructive">
        {error}
      </p>
    ) : null;
  }

  async function toggle(checked: boolean) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      setStatus(await rpc.serviceCredentials.update({ signupsEnabled: checked }));
    } catch (caught) {
      setError(errorText(caught, t`Could not change account creation`));
    } finally {
      setPending(false);
    }
  }

  return (
    <div data-testid="signup-settings" className="rounded-xl border border-border px-4 py-4">
      <SectionHeading variant="heading">
        <Trans>Access</Trans>
      </SectionHeading>
      <div className="mt-4 flex items-center justify-between gap-4">
        <Label htmlFor={switchId} className="text-body font-normal text-foreground">
          <Trans>Allow new account creation</Trans>
        </Label>
        <Switch
          id={switchId}
          data-testid="signups-enabled-toggle"
          checked={status.signupsEnabled}
          disabled={pending}
          onCheckedChange={(checked) => void toggle(checked)}
        />
      </div>
      <p className="mt-2 text-body-sm text-muted-foreground">
        <Trans>
          Off keeps this deployment to its current accounts: the sign-up form closes and new
          accounts are refused.
        </Trans>
      </p>
      {error ? (
        <p role="alert" className="mt-2 text-body-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
