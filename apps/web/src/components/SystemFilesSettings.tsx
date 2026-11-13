import { Trans, useLingui } from "@lingui/react/macro";
import type { SystemFileEntry } from "@rakazo/contracts";
import { Badge, Button, Input, SectionHeading, Textarea } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useSpaceQueries } from "../lib/query";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { SuccessPop } from "./ai/primitives";

interface OpenFile {
  path: string;
  content: string;
  editable: boolean;
  reason: "binary" | "too-large" | null;
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Browse and edit text files under the server directory the operator set
 * as SYSTEM_FILES_ROOT. Admins only, and hidden entirely when the server
 * reports the feature disabled.
 */
export function SystemFilesSettings() {
  const { t } = useLingui();
  const me = useQuery(useSpaceQueries().me.queryOptions());
  const isAdmin = Boolean(me.data?.isAdmin);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [dir, setDir] = useState("");
  const [entries, setEntries] = useState<SystemFileEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [open, setOpen] = useState<OpenFile | null>(null);
  const [draft, setDraft] = useState("");
  const [newName, setNewName] = useState("");
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdmin) return;
    let alive = true;
    rpc.systemFiles
      .status()
      .then((status) => {
        if (alive) setEnabled(status.enabled);
      })
      .catch(() => {
        // A server without the feature reads as disabled: hide the panel.
        if (alive) setEnabled(false);
      });
    return () => {
      alive = false;
    };
  }, [isAdmin]);

  async function loadDir(path: string) {
    try {
      const listed = await rpc.systemFiles.list({ path });
      setDir(path);
      setEntries(listed.entries);
      setTruncated(listed.truncated);
      setError(null);
    } catch (caught) {
      setError(errorText(caught, t`Could not load this folder`));
    }
  }

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    rpc.systemFiles
      .list({ path: "" })
      .then((listed) => {
        if (!alive) return;
        setDir("");
        setEntries(listed.entries);
        setTruncated(listed.truncated);
      })
      .catch((caught: unknown) => {
        if (alive) setError(errorText(caught, t`Could not load this folder`));
      });
    return () => {
      alive = false;
    };
  }, [enabled, t]);

  if (!isAdmin || !enabled) return null;

  const dirty = Boolean(open?.editable) && draft !== open?.content;
  const crumbs = dir ? dir.split("/") : [];

  async function openFile(entry: SystemFileEntry) {
    setSaved(false);
    try {
      const read = await rpc.systemFiles.read({ path: entry.path });
      setOpen({
        path: read.path,
        content: read.content ?? "",
        editable: read.editable,
        reason: read.reason,
      });
      setDraft(read.content ?? "");
      setError(null);
    } catch (caught) {
      setError(errorText(caught, t`Could not open this file`));
    }
  }

  async function save() {
    if (!open || pending || !dirty) return;
    setPending(true);
    setError(null);
    try {
      await rpc.systemFiles.write({ path: open.path, content: draft });
      setOpen({ ...open, content: draft });
      setSaved(true);
      await loadDir(dir);
    } catch (caught) {
      setError(errorText(caught, t`Could not save this file`));
    } finally {
      setPending(false);
    }
  }

  async function createFile() {
    const name = newName.trim();
    if (pending || !name) return;
    if (name.includes("/") || name.includes("\\")) {
      setError(t`Use a plain file name; the file is created in the open folder.`);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const path = dir ? `${dir}/${name}` : name;
      await rpc.systemFiles.write({ path, content: "" });
      setNewName("");
      await loadDir(dir);
      await openFile({ name, path, type: "file", size: 0 });
    } catch (caught) {
      setError(errorText(caught, t`Could not create this file`));
    } finally {
      setPending(false);
    }
  }

  return (
    <div data-testid="system-files-settings" className="rounded-xl border border-border px-4 py-4">
      <SectionHeading variant="heading">
        <Trans>System files</Trans>
      </SectionHeading>
      <div className="mt-3 flex flex-wrap items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setOpen(null);
            void loadDir("");
          }}
        >
          <Trans>Root</Trans>
        </Button>
        {crumbs.map((crumb, index) => {
          const prefix = crumbs.slice(0, index + 1).join("/");
          return (
            <span key={prefix} className="flex items-center gap-1">
              <span className="text-muted-foreground">/</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setOpen(null);
                  void loadDir(prefix);
                }}
              >
                {crumb}
              </Button>
            </span>
          );
        })}
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-body-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="mt-3 flex flex-col gap-4 md:flex-row">
        <div className="shrink-0 md:w-64">
          <ul className="grid gap-0.5">
            {entries.map((entry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-body-sm hover:bg-muted"
                  aria-current={open?.path === entry.path ? "true" : undefined}
                  onClick={() => {
                    if (entry.type === "directory") {
                      setOpen(null);
                      void loadDir(entry.path);
                    } else {
                      void openFile(entry);
                    }
                  }}
                >
                  <span className="break-all">
                    {entry.type === "directory" ? `${entry.name}/` : entry.name}
                  </span>
                  {entry.size !== null ? (
                    <span className="shrink-0 text-muted-foreground">{formatSize(entry.size)}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
          {truncated ? (
            <p className="mt-2 px-2 text-body-sm text-muted-foreground">
              <Trans>Showing the first 1,000 entries.</Trans>
            </p>
          ) : null}
          <form
            className="mt-3 flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void createFile();
            }}
          >
            <Input
              aria-label={t`New file name`}
              value={newName}
              placeholder={t`New file`}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setNewName(event.target.value)}
            />
            <Button type="submit" size="sm" variant="ghost" disabled={pending || !newName.trim()}>
              <Trans>Create</Trans>
            </Button>
          </form>
        </div>
        <div className="min-w-0 flex-1">
          {open ? (
            <div className="grid gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="break-all font-mono text-body-sm">{open.path}</span>
                {!open.editable ? (
                  <Badge variant="secondary">
                    <Trans>Read-only</Trans>
                  </Badge>
                ) : null}
              </div>
              {open.editable ? (
                <>
                  <Textarea
                    aria-label={open.path}
                    className="font-mono"
                    rows={16}
                    spellCheck={false}
                    value={draft}
                    onChange={(event) => {
                      setSaved(false);
                      setDraft(event.target.value);
                    }}
                  />
                  <div className="flex items-center gap-3">
                    <Button
                      type="button"
                      size="sm"
                      disabled={pending || !dirty}
                      onClick={() => void save()}
                    >
                      <Trans>Save</Trans>
                    </Button>
                    {saved ? <SuccessPop label={t`Saved`} /> : null}
                  </div>
                </>
              ) : (
                <p className="text-body-sm text-muted-foreground">
                  {open.reason === "too-large" ? (
                    <Trans>This file is larger than 512 KB, so it cannot be edited here.</Trans>
                  ) : (
                    <Trans>This file looks binary, so it cannot be edited here.</Trans>
                  )}
                </p>
              )}
            </div>
          ) : (
            <p className="text-body-sm text-muted-foreground">
              <Trans>Choose a file to view or edit.</Trans>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
