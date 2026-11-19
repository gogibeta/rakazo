import { useEffect, useRef, useState } from "react";

/**
 * Copies by selecting the text in a hidden field. Only reached on a secure page where the
 * Clipboard API is present but refused the write; an insecure page never gets here.
 */
function copyBySelection(text: string): boolean {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const field = document.createElement("textarea");
  field.value = text;
  field.readOnly = true;
  field.setAttribute("aria-hidden", "true");
  field.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0";
  // Next to the focused control, so a dialog's focus trap lets the selection happen.
  (active?.parentElement ?? document.body).append(field);
  field.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  field.remove();
  active?.focus({ preventScroll: true });
  return copied;
}

/** Names that resolve to this machine, where browsers treat plain http as secure anyway. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Whether this page may write the clipboard at all: https, or a loopback address.
 *
 * Browsers grant the Clipboard API only to a secure context, and that refusal is the rule to
 * enforce here rather than a hint to fall back from — `execCommand("copy")` still works on an
 * insecure page, so a document inside a bot's page could otherwise write the reader's clipboard
 * from it. We serve only http and https, where protocol plus hostname fully decides the answer, so
 * no platform probe is needed and none is possible under jsdom.
 */
export function clipboardAllowed(): boolean {
  const { protocol, hostname } = window.location;
  return protocol === "https:" || LOOPBACK_HOSTS.has(hostname) || hostname.endsWith(".localhost");
}

/**
 * Puts text on the clipboard; true once there. Refuses on a page that is not a secure context — see
 * `clipboardAllowed`. `isCurrent` lets a caller stop a superseded write from reporting success
 * over newer text.
 */
export function writeClipboard(text: string, isCurrent = () => true): Promise<boolean> {
  if (!clipboardAllowed()) return Promise.resolve(false);
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).then(
      () => true,
      () => isCurrent() && copyBySelection(text),
    );
  }
  return Promise.resolve(copyBySelection(text));
}

/**
 * Copy text and report a short-lived "copied" flag for button feedback, and whether the last
 * copy failed so the caller can offer the text to select by hand. Only the newest attempt's
 * outcome counts, and its exact text travels with the failure, so a result that arrives out of
 * order or a content change after the click cannot put different text in the fallback dialog.
 * `copy` resolves true only when its own attempt succeeded and still counts.
 */
export function useCopyText(): [
  copied: boolean,
  copy: (text: string) => Promise<boolean>,
  failed: boolean,
  reset: () => void,
  failedText: string,
] {
  const [state, setState] = useState<{ status: "idle" | "copied" | "failed"; text: string }>({
    status: "idle",
    text: "",
  });
  const attemptRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      // A copy that settles after unmount must not start a new feedback timer.
      attemptRef.current++;
      if (timerRef.current) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const copy = (text: string) => {
    const attempt = ++attemptRef.current;
    if (timerRef.current) window.clearTimeout(timerRef.current);
    // The earlier confirmation ends here; a write that never settles must not keep it on.
    setState((current) => (current.status === "copied" ? { status: "idle", text: "" } : current));
    return writeClipboard(text, () => attempt === attemptRef.current).then((ok) => {
      // A newer attempt superseded this one; its outcome decides.
      if (attempt !== attemptRef.current) return false;
      setState({ status: ok ? "copied" : "failed", text: ok ? "" : text });
      if (ok) {
        timerRef.current = window.setTimeout(() => {
          timerRef.current = null;
          if (attempt !== attemptRef.current) return;
          setState({ status: "idle", text: "" });
        }, 2000);
      }
      return ok;
    });
  };

  const reset = () => {
    // A copy still in flight must not reopen the dialog with its late failure.
    attemptRef.current++;
    if (timerRef.current) window.clearTimeout(timerRef.current);
    setState({ status: "idle", text: "" });
  };

  return [state.status === "copied", copy, state.status === "failed", reset, state.text];
}
