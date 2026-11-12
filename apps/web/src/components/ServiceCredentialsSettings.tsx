import { Trans, useLingui } from "@lingui/react/macro";
import type {
  ServiceCredentialKey,
  ServiceCredentialsStatus,
  ServiceCredentialsUpdate,
} from "@rakazo/contracts";
import { Button, Field, FieldLabel, Input, SectionHeading } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { useSpaceQueries } from "../lib/query";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { SuccessPop } from "./ai/primitives";

type Draft = Partial<Record<ServiceCredentialKey, string>>;

/**
 * Deployment service keys an admin saves instead of setting environment
 * variables. Only which keys are set ever comes back from the server.
 */
export function ServiceCredentialsSettings() {
  const { t } = useLingui();
  const me = useQuery(useSpaceQueries().me.queryOptions());
  const baseId = useId();
  const [status, setStatus] = useState<ServiceCredentialsStatus | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
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
        if (alive) setError(errorText(caught, t`Could not load service keys`));
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

  const fields: Array<{ key: ServiceCredentialKey; label: string }> = [
    { key: "tinyfishApiKey", label: t`TinyFish API key` },
    { key: "naceApiKey", label: t`Nace API key` },
    { key: "telegramBotToken", label: t`Telegram bot token` },
    { key: "telegramWebhookSecret", label: t`Telegram webhook secret` },
    { key: "whatsappAccessToken", label: t`WhatsApp access token` },
    { key: "whatsappPhoneNumberId", label: t`WhatsApp phone number ID` },
    { key: "whatsappAppSecret", label: t`WhatsApp app secret` },
    { key: "whatsappVerifyToken", label: t`WhatsApp verify token` },
  ];
  const dirty = fields.some((field) => draft[field.key]?.trim());

  async function save() {
    if (pending || !dirty) return;
    const values: ServiceCredentialsUpdate = {};
    for (const field of fields) {
      const value = draft[field.key]?.trim();
      if (value) values[field.key] = value;
    }
    setPending(true);
    setError(null);
    try {
      setStatus(await rpc.serviceCredentials.update(values));
      setDraft({});
      setSaved(true);
    } catch (caught) {
      setError(errorText(caught, t`Could not save service keys`));
    } finally {
      setPending(false);
    }
  }

  async function remove(key: ServiceCredentialKey) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      setStatus(await rpc.serviceCredentials.clear({ keys: [key] }));
      setSaved(false);
    } catch (caught) {
      setError(errorText(caught, t`Could not remove the saved key`));
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      data-testid="service-credentials-settings"
      className="rounded-xl border border-border px-4 py-4"
    >
      <SectionHeading variant="heading">
        <Trans>Service keys</Trans>
      </SectionHeading>
      <form
        className="mt-4 grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {/* Edits made while a save is in flight would be replaced by what it saved. */}
        <fieldset className="contents" disabled={pending}>
          {fields.map((field) => (
            <Field key={field.key}>
              <FieldLabel htmlFor={`${baseId}-${field.key}`}>{field.label}</FieldLabel>
              <div className="flex items-center gap-2">
                <Input
                  id={`${baseId}-${field.key}`}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={draft[field.key] ?? ""}
                  placeholder={status[field.key] ? t`Saved` : undefined}
                  onChange={(event) => {
                    setSaved(false);
                    setDraft({ ...draft, [field.key]: event.target.value });
                  }}
                />
                {status[field.key] ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void remove(field.key)}
                  >
                    <Trans>Remove</Trans>
                  </Button>
                ) : null}
              </div>
            </Field>
          ))}
        </fieldset>
        <p className="text-body-sm text-muted-foreground">
          <Trans>Changes apply after a restart.</Trans>
        </p>
        {error ? (
          <p role="alert" className="text-body-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex items-center gap-3">
          <Button type="submit" size="sm" disabled={pending || !dirty}>
            <Trans>Save</Trans>
          </Button>
          {saved ? <SuccessPop label={t`Saved`} /> : null}
        </div>
      </form>
    </div>
  );
}
