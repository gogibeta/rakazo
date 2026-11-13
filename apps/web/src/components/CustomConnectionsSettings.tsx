import { Trans, useLingui } from "@lingui/react/macro";
import type {
  CustomConnectionAddInput,
  CustomConnectionAuthStyle,
  CustomConnectionSummary,
} from "@rakazo/contracts";
import {
  Button,
  Field,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
  Spinner,
} from "@rakazo/ui-web";
import type { FormEvent } from "react";
import { useEffect, useId, useState } from "react";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { SuccessPop } from "./ai/primitives";

const AUTH_STYLES: Array<{ value: CustomConnectionAuthStyle; label: string }> = [
  { value: "bearer", label: "Bearer token" },
  { value: "header", label: "Header" },
  { value: "query", label: "Query parameter" },
];

/** The preset the connect button fills in; the person only pastes their token. */
const GITHUB_PRESET = {
  name: "GitHub",
  baseUrl: "https://api.github.com",
  authStyle: "bearer" as const,
};

function authStyleLabel(connection: CustomConnectionSummary): string {
  if (connection.authStyle === "bearer") return "Bearer token";
  if (connection.authStyle === "header") return `Header · ${connection.authName ?? ""}`;
  return `Query · ${connection.authName ?? ""}`;
}

/**
 * The signed-in person's registered API services. The form takes a name, a
 * base URL, how the service takes its key, and the key itself; the server
 * seals the key, which is never shown again. Bots call a service through the
 * server, which adds the key at call time.
 */
export function CustomConnectionsSettings() {
  const { t } = useLingui();
  const formId = useId();
  const [connections, setConnections] = useState<CustomConnectionSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [authStyle, setAuthStyle] = useState<CustomConnectionAuthStyle>("bearer");
  const [authName, setAuthName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [pending, setPending] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    rpc.customConnections
      .list()
      .then(({ connections: next }) => {
        if (alive) setConnections(next);
      })
      .catch((caught: unknown) => {
        if (alive) setLoadError(errorText(caught, t`Could not load connections`));
      });
    return () => {
      alive = false;
    };
  }, [t]);

  const needsAuthName = authStyle !== "bearer";
  const canSubmit =
    name.trim().length > 0 &&
    baseUrl.trim().length > 0 &&
    (!needsAuthName || authName.trim().length > 0);
  const githubConnected = (connections ?? []).some((entry) => entry.name === GITHUB_PRESET.name);

  function fillPreset() {
    setName(GITHUB_PRESET.name);
    setBaseUrl(GITHUB_PRESET.baseUrl);
    setAuthStyle(GITHUB_PRESET.authStyle);
    setAuthName("");
    setError(null);
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    if (pending || !canSubmit) return;
    setPending(true);
    setSaved(false);
    setError(null);
    try {
      const input: CustomConnectionAddInput = {
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        authStyle,
        authName: needsAuthName ? authName.trim() : null,
      };
      if (apiKey) input.apiKey = apiKey;
      const added = await rpc.customConnections.add(input);
      setConnections((current) => [...(current ?? []), added]);
      setName("");
      setBaseUrl("");
      setAuthName("");
      setApiKey("");
      setSaved(true);
    } catch (caught) {
      setError(errorText(caught, t`Could not add the connection`));
    } finally {
      setPending(false);
    }
  }

  async function remove(connection: CustomConnectionSummary) {
    if (removingId) return;
    setRemovingId(connection.id);
    setError(null);
    try {
      await rpc.customConnections.remove({ connectionId: connection.id });
      setConnections((current) => (current ?? []).filter((entry) => entry.id !== connection.id));
    } catch (caught) {
      setError(errorText(caught, t`Could not remove the connection`));
    } finally {
      setRemovingId(null);
    }
  }

  async function test(connection: CustomConnectionSummary) {
    if (testingId) return;
    setTestingId(connection.id);
    try {
      const result = await rpc.customConnections.test({ connectionId: connection.id });
      setTestResults((current) => ({
        ...current,
        [connection.id]:
          result.status !== null
            ? t`Reachable — HTTP ${result.status}`
            : (result.error ?? t`Could not reach the service`),
      }));
    } catch (caught) {
      setTestResults((current) => ({
        ...current,
        [connection.id]: errorText(caught, t`Could not reach the service`),
      }));
    } finally {
      setTestingId(null);
    }
  }

  return (
    <div className="space-y-5">
      <p className="text-body-sm text-muted-foreground">
        <Trans>
          Keys are stored encrypted and never shown again. Your bots can call these services, but
          they never see the keys.
        </Trans>
      </p>
      <div className="flex items-center justify-between gap-3 rounded-xl border border-border px-4 py-4">
        <div className="min-w-0">
          <div className="text-body text-foreground">
            <Trans>GitHub</Trans>
          </div>
          <div className="text-body-sm text-muted-foreground">
            {githubConnected ? (
              <Trans>Connected. Your bots can call the GitHub API.</Trans>
            ) : (
              <Trans>Paste a personal access token and your bots can call the GitHub API.</Trans>
            )}
          </div>
        </div>
        {githubConnected ? null : (
          <Button type="button" size="sm" onClick={fillPreset}>
            <Trans>Connect GitHub</Trans>
          </Button>
        )}
      </div>
      <form onSubmit={add} className="space-y-3 rounded-xl border border-border px-4 py-4">
        <Field>
          <FieldLabel htmlFor={`${formId}-name`}>
            <Trans>Name</Trans>
          </FieldLabel>
          <Input
            id={`${formId}-name`}
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${formId}-baseUrl`}>
            <Trans>Base URL</Trans>
          </FieldLabel>
          <Input
            id={`${formId}-baseUrl`}
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://api.example.com"
            required
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field>
            <FieldLabel htmlFor={`${formId}-authStyle`}>
              <Trans>How the key is sent</Trans>
            </FieldLabel>
            <NativeSelect
              id={`${formId}-authStyle`}
              value={authStyle}
              onChange={(event) => setAuthStyle(event.target.value as CustomConnectionAuthStyle)}
            >
              {AUTH_STYLES.map((entry) => (
                <NativeSelectOption key={entry.value} value={entry.value}>
                  {entry.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          {needsAuthName ? (
            <Field>
              <FieldLabel htmlFor={`${formId}-authName`}>
                {authStyle === "header" ? (
                  <Trans>Header name</Trans>
                ) : (
                  <Trans>Parameter name</Trans>
                )}
              </FieldLabel>
              <Input
                id={`${formId}-authName`}
                value={authName}
                onChange={(event) => setAuthName(event.target.value)}
                placeholder={authStyle === "header" ? "X-Api-Key" : "api_key"}
                autoComplete="off"
                required
              />
            </Field>
          ) : null}
        </div>
        <Field>
          <FieldLabel htmlFor={`${formId}-apiKey`}>
            <Trans>API key</Trans>
          </FieldLabel>
          <Input
            id={`${formId}-apiKey`}
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            autoComplete="off"
          />
        </Field>
        {error ? (
          <p role="alert" className="text-body-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex items-center gap-3">
          <Button type="submit" size="sm" disabled={pending || !canSubmit}>
            {pending ? <Spinner /> : null}
            <Trans>Add connection</Trans>
          </Button>
          {saved ? <SuccessPop label={t`Added`} /> : null}
        </div>
      </form>
      {loadError ? (
        <p role="alert" className="text-body-sm text-destructive">
          {loadError}
        </p>
      ) : connections === null ? (
        <Spinner />
      ) : connections.length > 0 ? (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {connections.map((connection) => (
            <li key={connection.id} className="px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-body text-foreground">{connection.name}</div>
                  <div className="truncate text-body-sm text-muted-foreground">
                    {connection.baseUrl} · {authStyleLabel(connection)}
                    {connection.hasApiKey ? ` · ${t`Key saved`}` : ""}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={testingId === connection.id}
                    onClick={() => void test(connection)}
                  >
                    {testingId === connection.id ? <Spinner /> : null}
                    <Trans>Test</Trans>
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={removingId === connection.id}
                    onClick={() => void remove(connection)}
                  >
                    {removingId === connection.id ? <Spinner /> : null}
                    <Trans>Remove</Trans>
                  </Button>
                </div>
              </div>
              {testResults[connection.id] ? (
                <div className="pt-2 text-body-sm text-muted-foreground">
                  {testResults[connection.id]}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
