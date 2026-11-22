import { Trans, useLingui } from "@lingui/react/macro";
import type { WalletSummary, WalletUseSummary, WalletVaultStatus } from "@rakazo/contracts";
import { Button, Field, FieldLabel, Input, Spinner } from "@rakazo/ui-web";
import type { FormEvent } from "react";
import { useEffect, useId, useState } from "react";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { SuccessPop } from "./ai/primitives";

/**
 * The signed-in person's named crypto wallets. The form takes a name and the
 * secret itself; the server derives the public address and seals the secret,
 * which is never shown again. A bot can ask to type a wallet's secret into a
 * page, and the person approves each fill; the history below is those fills.
 */
/**
 * The wallet password: the cryptographic lock on every saved wallet key.
 * Setting it stores only a verifier on the server; the password itself is
 * never stored or read back, and there is no recovery — a forgotten password
 * means importing the wallets again under a new one.
 */
function WalletPasswordSettings({
  onStatusChange,
}: {
  onStatusChange?: (configured: boolean) => void;
}) {
  const { t } = useLingui();
  const formId = useId();
  const [status, setStatus] = useState<WalletVaultStatus | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    rpc.wallets
      .vaultStatus()
      .then((next) => {
        if (alive) {
          setStatus(next);
          onStatusChange?.(next.configured);
        }
      })
      .catch((caught: unknown) => {
        if (alive) setError(errorText(caught, t`Could not load the wallet password state`));
      });
    return () => {
      alive = false;
    };
  }, [t, onStatusChange]);

  const configured = status?.configured ?? false;
  const canSubmit =
    status !== null &&
    password.length >= 8 &&
    password === confirmation &&
    (!configured || currentPassword.length > 0);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending || !canSubmit) return;
    setPending(true);
    setSaved(false);
    setError(null);
    try {
      const next = configured
        ? await rpc.wallets.changeVaultPassword({ currentPassword, newPassword: password })
        : await rpc.wallets.setVaultPassword({ password });
      setStatus(next);
      onStatusChange?.(next.configured);
      setCurrentPassword("");
      setPassword("");
      setConfirmation("");
      setSaved(true);
    } catch (caught) {
      setError(
        errorText(
          caught,
          configured
            ? t`Could not change the wallet password`
            : t`Could not set the wallet password`,
        ),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <form onSubmit={submit} className="space-y-3 rounded-xl border border-border px-4 py-4">
        <div className="text-body text-foreground">
          <Trans>Wallet password</Trans>
        </div>
        <p className="text-body-sm text-muted-foreground">
          <Trans>
            This password locks your wallet keys. It cannot be recovered: if you forget it, you will
            need to import your wallets again.
          </Trans>
        </p>
        {status === null ? (
          <Spinner />
        ) : (
          <>
            {configured ? (
              <Field>
                <FieldLabel htmlFor={`${formId}-current`}>
                  <Trans>Current wallet password</Trans>
                </FieldLabel>
                <Input
                  id={`${formId}-current`}
                  type="password"
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                  autoComplete="current-password"
                  required
                />
              </Field>
            ) : null}
            <Field>
              <FieldLabel htmlFor={`${formId}-password`}>
                {configured ? <Trans>New wallet password</Trans> : <Trans>Wallet password</Trans>}
              </FieldLabel>
              <Input
                id={`${formId}-password`}
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${formId}-confirm`}>
                <Trans>Confirm wallet password</Trans>
              </FieldLabel>
              <Input
                id={`${formId}-confirm`}
                type="password"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                autoComplete="new-password"
                required
              />
            </Field>
          </>
        )}
        {error ? (
          <p role="alert" className="text-body-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex items-center gap-3">
          <Button type="submit" size="sm" disabled={pending || !canSubmit}>
            {pending ? <Spinner /> : null}
            {configured ? (
              <Trans>Change wallet password</Trans>
            ) : (
              <Trans>Set wallet password</Trans>
            )}
          </Button>
          {saved ? <SuccessPop label={t`Saved`} /> : null}
        </div>
      </form>
      {status?.configured ? (
        <WalletUnlockSettings
          status={status}
          onStatus={(next) => {
            setStatus(next);
            onStatusChange?.(next.configured);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * The wallet vault, unlocked: one entry of the wallet password opens it
 * for six hours, fixed — nothing extends the window — and Lock ends it
 * now. The password goes straight to the vault and is never stored, read
 * back, or shown again; the grant itself never reaches the browser, only
 * the status above. Bots may use the vault only while it is unlocked and
 * only in runs the owner started.
 */
function WalletUnlockSettings({
  status,
  onStatus,
}: {
  status: WalletVaultStatus;
  onStatus: (next: WalletVaultStatus) => void;
}) {
  const { t } = useLingui();
  const formId = useId();
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unlocked = status.unlocked;
  const expiresAt = status.expiresAt ? new Date(status.expiresAt).toLocaleString() : null;

  async function unlock(event: FormEvent) {
    event.preventDefault();
    if (pending || password.length === 0) return;
    setPending(true);
    setError(null);
    try {
      const next = await rpc.wallets.vaultUnlock({ password });
      onStatus(next);
      setPassword("");
    } catch (caught) {
      setError(errorText(caught, t`Could not unlock the wallet vault`));
    } finally {
      setPending(false);
    }
  }

  async function lock() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      onStatus(await rpc.wallets.vaultLock());
    } catch (caught) {
      setError(errorText(caught, t`Could not lock the wallet vault`));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-3 rounded-xl border border-border px-4 py-4">
      <div className="text-body text-foreground">
        <Trans>Unlock wallets</Trans>
      </div>
      {unlocked && expiresAt ? (
        <p className="text-body-sm text-muted-foreground">
          <Trans>Unlocked until {expiresAt}.</Trans>
        </p>
      ) : (
        <p className="text-body-sm text-muted-foreground">
          <Trans>Unlocking lasts six hours.</Trans>
        </p>
      )}
      {!status.vaultAvailable ? (
        <p role="alert" className="text-body-sm text-destructive">
          <Trans>The wallet vault is unavailable.</Trans>
        </p>
      ) : unlocked ? (
        <Button type="button" size="sm" disabled={pending} onClick={() => void lock()}>
          {pending ? <Spinner /> : null}
          <Trans>Lock wallets</Trans>
        </Button>
      ) : (
        <form onSubmit={unlock} className="space-y-3">
          <Field>
            <FieldLabel htmlFor={`${formId}-unlock`}>
              <Trans>Unlock password</Trans>
            </FieldLabel>
            <Input
              id={`${formId}-unlock`}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
          </Field>
          <Button type="submit" size="sm" disabled={pending || password.length === 0}>
            {pending ? <Spinner /> : null}
            <Trans>Unlock for six hours</Trans>
          </Button>
        </form>
      )}
      {error ? (
        <p role="alert" className="text-body-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function WalletsSettings() {
  const { t } = useLingui();
  const formId = useId();
  const [wallets, setWallets] = useState<WalletSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [secret, setSecret] = useState("");
  const [pending, setPending] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  /** The token plus the wallet it names, waiting for the owner to confirm. */
  const [confirmRemoval, setConfirmRemoval] = useState<{
    walletId: string;
    token: string;
    label: string;
  } | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [uses, setUses] = useState<WalletUseSummary[] | null>(null);
  const [usesError, setUsesError] = useState<string | null>(null);
  const [vaultConfigured, setVaultConfigured] = useState(false);
  const [migrateId, setMigrateId] = useState<string | null>(null);
  const [migratePassword, setMigratePassword] = useState("");
  const [migratePending, setMigratePending] = useState(false);
  const [migrateError, setMigrateError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    rpc.wallets
      .list()
      .then(({ wallets: next }) => {
        if (alive) setWallets(next);
      })
      .catch((caught: unknown) => {
        if (alive) setLoadError(errorText(caught, t`Could not load wallets`));
      });
    return () => {
      alive = false;
    };
  }, [t]);

  const canSubmit = name.trim().length > 0 && secret.trim().length > 0;

  async function add(event: FormEvent) {
    event.preventDefault();
    if (pending || !canSubmit) return;
    setPending(true);
    setSaved(false);
    setError(null);
    try {
      const added = await rpc.wallets.add({ name: name.trim(), secret });
      setWallets((current) => [...(current ?? []), added]);
      setName("");
      setSecret("");
      setSaved(true);
    } catch (caught) {
      setError(errorText(caught, t`Could not add the wallet`));
    } finally {
      setPending(false);
    }
  }

  async function remove(wallet: WalletSummary) {
    if (removingId) return;
    setRemovingId(wallet.id);
    setError(null);
    try {
      // Removing asks for a single-use token first. The token comes back with the
      // wallet's name and address, which is what the owner is shown before the
      // removal goes through — a removal request on its own names nothing.
      const confirmation = await rpc.wallets.requestRemove({ walletId: wallet.id });
      setConfirmRemoval({
        walletId: wallet.id,
        token: confirmation.token,
        label: `${confirmation.wallet.name} (${confirmation.wallet.address})`,
      });
    } catch (caught) {
      setError(errorText(caught, t`Could not remove the wallet`));
    } finally {
      setRemovingId(null);
    }
  }

  /** The owner confirmed the wallet named in the token: spend it. */
  async function confirmRemove() {
    if (!confirmRemoval) return;
    const { walletId, token } = confirmRemoval;
    setRemovingId(walletId);
    setError(null);
    try {
      await rpc.wallets.remove({ walletId, confirmationToken: token });
      setWallets((current) => (current ?? []).filter((entry) => entry.id !== walletId));
      if (historyId === walletId) setHistoryId(null);
      setConfirmRemoval(null);
    } catch (caught) {
      setError(errorText(caught, t`Could not remove the wallet`));
    } finally {
      setRemovingId(null);
    }
  }

  async function migrate(event: FormEvent, wallet: WalletSummary) {
    event.preventDefault();
    if (migratePending || migratePassword.length === 0) return;
    setMigratePending(true);
    setMigrateError(null);
    try {
      const migrated = await rpc.wallets.migrate({
        walletId: wallet.id,
        password: migratePassword,
      });
      setWallets((current) =>
        (current ?? []).map((entry) => (entry.id === migrated.id ? migrated : entry)),
      );
      setMigrateId(null);
      setMigratePassword("");
    } catch (caught) {
      setMigrateError(errorText(caught, t`Could not migrate the wallet`));
    } finally {
      setMigratePending(false);
    }
  }

  async function toggleHistory(wallet: WalletSummary) {
    if (historyId === wallet.id) {
      setHistoryId(null);
      return;
    }
    setHistoryId(wallet.id);
    setUses(null);
    setUsesError(null);
    try {
      const { uses: next } = await rpc.wallets.uses({ walletId: wallet.id });
      setUses(next);
    } catch (caught) {
      setUsesError(errorText(caught, t`Could not load the history`));
    }
  }

  return (
    <div className="space-y-5">
      <p className="text-body-sm text-muted-foreground">
        <Trans>Use burner wallets only — never a wallet that holds real funds.</Trans>
      </p>
      <WalletPasswordSettings onStatusChange={setVaultConfigured} />
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
          <FieldLabel htmlFor={`${formId}-secret`}>
            <Trans>Private key or seed phrase</Trans>
          </FieldLabel>
          <Input
            id={`${formId}-secret`}
            type="password"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            autoComplete="off"
            required
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
            <Trans>Add wallet</Trans>
          </Button>
          {saved ? <SuccessPop label={t`Added`} /> : null}
        </div>
      </form>
      {loadError ? (
        <p role="alert" className="text-body-sm text-destructive">
          {loadError}
        </p>
      ) : wallets === null ? (
        <Spinner />
      ) : wallets.length > 0 ? (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {wallets.map((wallet) => (
            <li key={wallet.id} className="px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-body text-foreground">{wallet.name}</div>
                  <div className="truncate text-body-sm text-muted-foreground">
                    {wallet.address} · {wallet.chain.toUpperCase()}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void toggleHistory(wallet)}
                  >
                    <Trans>History</Trans>
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={removingId === wallet.id}
                    onClick={() => void remove(wallet)}
                  >
                    {removingId === wallet.id ? <Spinner /> : null}
                    <Trans>Remove</Trans>
                  </Button>
                </div>
              </div>
              {confirmRemoval?.walletId === wallet.id ? (
                <fieldset
                  aria-label={t`Confirm removal`}
                  className="mt-2 space-y-2 rounded-lg border border-border bg-muted/40 px-3 py-2"
                >
                  <p className="text-body-sm text-foreground">
                    <Trans>Remove this wallet? Its key is kept, so this can be undone.</Trans>
                  </p>
                  <p className="break-all text-body-sm text-muted-foreground">
                    {confirmRemoval.label}
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      disabled={removingId === wallet.id}
                      onClick={() => void confirmRemove()}
                    >
                      {removingId === wallet.id ? <Spinner /> : null}
                      <Trans>Remove</Trans>
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setConfirmRemoval(null)}
                    >
                      <Trans>Keep it</Trans>
                    </Button>
                  </div>
                </fieldset>
              ) : null}
              {wallet.migrationStatus === "password_protected" ? (
                <p className="pt-1 text-body-sm text-muted-foreground">
                  <Trans>Password protected</Trans>
                </p>
              ) : (
                <div className="space-y-2 pt-2">
                  <p className="text-body-sm text-muted-foreground">
                    {wallet.migrationStatus === "migration_failed" ? (
                      <Trans>Migration failed — the wallet is unchanged.</Trans>
                    ) : (
                      <Trans>Not password protected yet.</Trans>
                    )}
                  </p>
                  {!vaultConfigured ? (
                    <p className="text-body-sm text-muted-foreground">
                      <Trans>Set a wallet password first.</Trans>
                    </p>
                  ) : migrateId === wallet.id ? (
                    <form
                      onSubmit={(event) => void migrate(event, wallet)}
                      className="flex flex-wrap items-end gap-2"
                    >
                      <Field>
                        <FieldLabel htmlFor={`${formId}-migrate-${wallet.id}`}>
                          <Trans>Wallet password</Trans>
                        </FieldLabel>
                        <Input
                          id={`${formId}-migrate-${wallet.id}`}
                          type="password"
                          value={migratePassword}
                          onChange={(event) => setMigratePassword(event.target.value)}
                          autoComplete="current-password"
                          required
                        />
                      </Field>
                      <Button
                        type="submit"
                        size="sm"
                        disabled={migratePending || migratePassword.length === 0}
                      >
                        {migratePending ? <Spinner /> : null}
                        <Trans>Migrate wallet</Trans>
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={migratePending}
                        onClick={() => {
                          setMigrateId(null);
                          setMigratePassword("");
                          setMigrateError(null);
                        }}
                      >
                        <Trans>Cancel</Trans>
                      </Button>
                    </form>
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setMigrateId(wallet.id);
                        setMigratePassword("");
                        setMigrateError(null);
                      }}
                    >
                      <Trans>Migrate</Trans>
                    </Button>
                  )}
                  {migrateId === wallet.id && migrateError ? (
                    <p role="alert" className="text-body-sm text-destructive">
                      {migrateError}
                    </p>
                  ) : null}
                </div>
              )}
              {historyId === wallet.id ? (
                <div className="pt-3">
                  {usesError ? (
                    <p role="alert" className="text-body-sm text-destructive">
                      {usesError}
                    </p>
                  ) : uses === null ? (
                    <Spinner />
                  ) : uses.length > 0 ? (
                    <ul className="space-y-2">
                      {uses.map((use) => (
                        <li key={use.id} className="text-body-sm text-muted-foreground">
                          {use.botName}
                          {use.purpose ? ` · ${use.purpose}` : ""} · {use.site} ·{" "}
                          {new Date(use.createdAt).toLocaleString()}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-body-sm text-muted-foreground">
                      <Trans>Not used yet.</Trans>
                    </p>
                  )}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
