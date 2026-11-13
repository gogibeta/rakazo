import { OneTimeCodeTarget, WALLET_PURPOSE_MAX_LENGTH, WalletName } from "@rakazo/contracts";
import type { FleetCardSummary } from "./approval-ask.js";

/** The site a fill_wallet step names, reduced to its origin, so a page URL names its site. */
function fillSite(value: unknown): string {
  const text = String(value ?? "").trim();
  return URL.canParse(text) ? new URL(text).origin : text;
}

/**
 * A wallet use a person approved: one fill of that wallet's secret into one
 * site. Carried in the persisted request, so a replay fills exactly that
 * wallet on exactly that site, with the purpose the card showed. `savedAt` is
 * when the wallet was last saved, so one whose secret was replaced while the
 * approval waited is not typed.
 */
export type WalletUse = {
  wallet: string;
  site: string;
  purpose: string;
  address: string;
  savedAt: string;
};

/** A wallet use as the persisted request holds it, or nothing when it is not one. */
export function walletUseOf(value: unknown): WalletUse | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { wallet, site, purpose, address, savedAt } = value as Record<string, unknown>;
  if (
    !WalletName.safeParse(wallet).success ||
    !OneTimeCodeTarget.safeParse({ origin: site }).success ||
    typeof purpose !== "string" ||
    typeof address !== "string" ||
    typeof savedAt !== "string"
  )
    return undefined;
  return {
    wallet: wallet as string,
    site: new URL(site as string).origin,
    purpose,
    address,
    savedAt,
  };
}

/** The purpose a fill names, as the approval card and the usage record show it: one short line. */
export function walletPurposeOf(value: unknown): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text.slice(0, WALLET_PURPOSE_MAX_LENGTH);
}

/**
 * The wallet and site a browser_act call fills into, from its fill_wallet
 * steps. One call fills one wallet on one site, so one approval covers
 * exactly what it shows.
 */
export function requestedWalletUse(
  actions: unknown,
): { wallet: string; site: string; purpose: string } | { error: string } | undefined {
  if (!Array.isArray(actions)) return undefined;
  const uses = actions.flatMap((raw) => {
    const step = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const wallet = typeof step.wallet === "string" ? step.wallet.trim() : "";
    return step.kind === "fill_wallet" && wallet
      ? [{ wallet, site: fillSite(step.site), purpose: walletPurposeOf(step.purpose) }]
      : [];
  });
  const [first] = uses;
  if (!first) return undefined;
  if (!OneTimeCodeTarget.safeParse({ origin: first.site }).success) {
    return { error: "fill_wallet needs site: the page's HTTPS origin." };
  }
  if (uses.some((use) => use.wallet !== first.wallet || use.site !== first.site)) {
    return { error: "Fill one wallet on one site per browser_act call." };
  }
  return first;
}

/** The approval card for typing a wallet's secret into a page. It asks every time. */
export function walletUseSummary(use: WalletUse): FleetCardSummary {
  const host = new URL(use.site).host;
  return {
    onceOnly: true,
    title: `Type the key for ${use.wallet} on ${host}?`,
    lines: [
      ...(use.purpose ? [use.purpose] : []),
      `Address ${use.address}`,
      "The key or seed phrase goes into the page; the bot never sees it.",
    ],
  };
}
