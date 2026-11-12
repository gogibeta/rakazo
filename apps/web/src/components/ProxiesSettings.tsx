import { Trans, useLingui } from "@lingui/react/macro";
import type { ProxyAddInput, ProxyProtocol, ProxySummary } from "@rakazo/contracts";
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

const PROTOCOLS: Array<{ value: ProxyProtocol; label: string }> = [
  { value: "http", label: "HTTP" },
  { value: "https", label: "HTTPS" },
  { value: "socks5", label: "SOCKS5" },
];

/**
 * The signed-in person's named proxies. The form collects the parts (or one
 * pasted URL) and the server composes and seals the connection; a saved
 * proxy's password is never shown again.
 */
export function ProxiesSettings() {
  const { t } = useLingui();
  const formId = useId();
  const [proxies, setProxies] = useState<ProxySummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<"fields" | "url">("fields");
  const [name, setName] = useState("");
  const [protocol, setProtocol] = useState<ProxyProtocol>("http");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [country, setCountry] = useState("");
  const [username, setUsername] = useState("");
  const [secret, setSecret] = useState("");
  const [url, setUrl] = useState("");
  const [pending, setPending] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    rpc.proxies
      .list()
      .then(({ proxies: next }) => {
        if (alive) setProxies(next);
      })
      .catch((caught: unknown) => {
        if (alive) setLoadError(errorText(caught, t`Could not load proxies`));
      });
    return () => {
      alive = false;
    };
  }, [t]);

  const portNumber = Number(port);
  const canSubmit =
    name.trim().length > 0 &&
    (mode === "url"
      ? url.trim().length > 0
      : host.trim().length > 0 &&
        Number.isInteger(portNumber) &&
        portNumber >= 1 &&
        portNumber <= 65_535);

  async function add(event: FormEvent) {
    event.preventDefault();
    if (pending || !canSubmit) return;
    setPending(true);
    setSaved(false);
    setError(null);
    try {
      let input: ProxyAddInput;
      if (mode === "url") {
        input = { name: name.trim(), url: url.trim() };
      } else {
        input = {
          name: name.trim(),
          protocol,
          host: host.trim(),
          port: portNumber,
          country: country.trim() ? country.trim().toUpperCase() : null,
          username: username.trim() ? username.trim() : null,
        };
        if (secret) input.password = secret;
      }
      const added = await rpc.proxies.add(input);
      setProxies((current) => [...(current ?? []), added]);
      setName("");
      setHost("");
      setPort("");
      setCountry("");
      setUsername("");
      setSecret("");
      setUrl("");
      setSaved(true);
    } catch (caught) {
      setError(errorText(caught, t`Could not add the proxy`));
    } finally {
      setPending(false);
    }
  }

  async function remove(proxy: ProxySummary) {
    if (removingId) return;
    setRemovingId(proxy.id);
    setError(null);
    try {
      await rpc.proxies.remove({ proxyId: proxy.id });
      setProxies((current) => (current ?? []).filter((entry) => entry.id !== proxy.id));
    } catch (caught) {
      setError(errorText(caught, t`Could not remove the proxy`));
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <div className="space-y-5">
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
        {mode === "fields" ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel htmlFor={`${formId}-protocol`}>
                  <Trans>Protocol</Trans>
                </FieldLabel>
                <NativeSelect
                  id={`${formId}-protocol`}
                  value={protocol}
                  onChange={(event) => setProtocol(event.target.value as ProxyProtocol)}
                >
                  {PROTOCOLS.map((entry) => (
                    <NativeSelectOption key={entry.value} value={entry.value}>
                      {entry.label}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel htmlFor={`${formId}-country`}>
                  <Trans>Country</Trans>
                </FieldLabel>
                <Input
                  id={`${formId}-country`}
                  value={country}
                  onChange={(event) => setCountry(event.target.value.toUpperCase())}
                  placeholder="US"
                  maxLength={2}
                />
              </Field>
            </div>
            <div className="grid grid-cols-[1fr_120px] gap-3">
              <Field>
                <FieldLabel htmlFor={`${formId}-host`}>
                  <Trans>Host</Trans>
                </FieldLabel>
                <Input
                  id={`${formId}-host`}
                  value={host}
                  onChange={(event) => setHost(event.target.value)}
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${formId}-port`}>
                  <Trans>Port</Trans>
                </FieldLabel>
                <Input
                  id={`${formId}-port`}
                  value={port}
                  onChange={(event) => setPort(event.target.value)}
                  inputMode="numeric"
                  required
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel htmlFor={`${formId}-username`}>
                  <Trans>Username</Trans>
                </FieldLabel>
                <Input
                  id={`${formId}-username`}
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="off"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${formId}-secret`}>
                  <Trans>Password</Trans>
                </FieldLabel>
                <Input
                  id={`${formId}-secret`}
                  type="password"
                  value={secret}
                  onChange={(event) => setSecret(event.target.value)}
                  autoComplete="off"
                />
              </Field>
            </div>
          </>
        ) : (
          <Field>
            <FieldLabel htmlFor={`${formId}-url`}>
              <Trans>Proxy URL</Trans>
            </FieldLabel>
            <Input
              id={`${formId}-url`}
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="http://user:pass@host:port"
              required
            />
          </Field>
        )}
        {error ? (
          <p role="alert" className="text-body-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex items-center gap-3">
          <Button type="submit" size="sm" disabled={pending || !canSubmit}>
            {pending ? <Spinner /> : null}
            <Trans>Add proxy</Trans>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setMode(mode === "fields" ? "url" : "fields")}
          >
            {mode === "fields" ? (
              <Trans>Paste a URL instead</Trans>
            ) : (
              <Trans>Use separate fields</Trans>
            )}
          </Button>
          {saved ? <SuccessPop label={t`Added`} /> : null}
        </div>
      </form>
      {loadError ? (
        <p role="alert" className="text-body-sm text-destructive">
          {loadError}
        </p>
      ) : proxies === null ? (
        <Spinner />
      ) : proxies.length > 0 ? (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {proxies.map((proxy) => (
            <li key={proxy.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="truncate text-body text-foreground">{proxy.name}</div>
                <div className="text-body-sm text-muted-foreground">
                  {proxy.host}:{proxy.port}
                  {proxy.country ? ` · ${proxy.country}` : ""} · {proxy.protocol.toUpperCase()}
                </div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={removingId === proxy.id}
                onClick={() => void remove(proxy)}
              >
                {removingId === proxy.id ? <Spinner /> : null}
                <Trans>Remove</Trans>
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
