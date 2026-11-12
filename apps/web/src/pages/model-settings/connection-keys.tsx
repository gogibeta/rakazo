import { Trans, useLingui } from "@lingui/react/macro";
import { Button, Input } from "@rakazo/ui-web";
import { useState } from "react";
import { useSpaceRpc } from "../../lib/space-rpc";
import { errorText } from "../../lib/user-error";
import type { ModelSettingsState } from "./use-model-settings";

/**
 * The connection's pooled keys and accounts. Runs try the active one first and
 * fail over to the next when the provider rejects it, so this list only needs
 * labels and status — never a secret value.
 */
export function ConnectionKeysSection({
  acceptsKey,
  beginAddAccountSignIn,
  busy,
  credential,
  refresh,
  subscriptionSignIn,
}: Pick<
  ModelSettingsState,
  "acceptsKey" | "beginAddAccountSignIn" | "busy" | "credential" | "refresh" | "subscriptionSignIn"
>) {
  const { t } = useLingui();
  const rpc = useSpaceRpc();
  const [apiKey, setApiKey] = useState("");
  const [label, setLabel] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keys = credential?.keys ?? [];
  if (!credential || keys.length === 0) return null;

  async function addKey() {
    if (!credential || !apiKey.trim() || pending) return;
    setPending(true);
    setError(null);
    try {
      await rpc.models.addCredentialKey({
        credentialId: credential.id,
        apiKey: apiKey.trim(),
        ...(label.trim() ? { label: label.trim() } : {}),
      });
      setApiKey("");
      setLabel("");
      await refresh({ keepForm: true });
    } catch (err) {
      setError(errorText(err, t`Could not add the key`));
    } finally {
      setPending(false);
    }
  }

  async function removeKey(keyId: string) {
    if (!credential || pending) return;
    setPending(true);
    setError(null);
    try {
      await rpc.models.removeCredentialKey({ credentialId: credential.id, keyId });
      await refresh({ keepForm: true });
    } catch (err) {
      setError(errorText(err, t`Could not remove the key`));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mt-6 border-t border-border pt-4">
      <h5 className="text-body font-medium text-foreground">
        <Trans>Keys and accounts</Trans>
      </h5>
      <ul className="mt-2 divide-y divide-border">
        {keys.map((key) => (
          <li key={key.id} className="flex items-center justify-between gap-3 py-2">
            <span className="min-w-0">
              <span className="block truncate text-body-sm text-foreground">{key.label}</span>
              <span className="block text-body-sm text-muted-foreground">
                {key.reconnectRequired ? (
                  <Trans>Reconnect required</Trans>
                ) : key.active ? (
                  <Trans>Active</Trans>
                ) : key.lastFailedAt ? (
                  <Trans>Last failed {new Date(key.lastFailedAt).toLocaleString()}</Trans>
                ) : key.authKind === "oauth" ? (
                  <Trans>Account</Trans>
                ) : (
                  <Trans>Key</Trans>
                )}
              </span>
            </span>
            {keys.length > 1 ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="-me-2.5 text-muted-foreground"
                disabled={busy || pending}
                onClick={() => void removeKey(key.id)}
              >
                <Trans>Remove</Trans>
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {error ? (
        <p className="mt-2 text-body-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {acceptsKey ? (
        <div className="mt-3 flex flex-col gap-2">
          <Input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={t`New API key`}
            aria-label={t`New API key`}
            autoComplete="off"
            spellCheck={false}
            className="h-10 text-foreground"
          />
          <div className="flex gap-2">
            <Input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder={t`Label (optional)`}
              aria-label={t`Label (optional)`}
              autoComplete="off"
              spellCheck={false}
              className="h-10 text-foreground"
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="h-10 shrink-0"
              disabled={busy || pending || !apiKey.trim()}
              onClick={() => void addKey()}
            >
              <Trans>Add key</Trans>
            </Button>
          </div>
        </div>
      ) : null}
      {subscriptionSignIn ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="mt-3"
          disabled={busy || pending}
          onClick={() => beginAddAccountSignIn()}
        >
          <Trans>Add account</Trans>
        </Button>
      ) : null}
    </div>
  );
}
