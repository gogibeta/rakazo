/**
 * Whether a bot may type a saved wallet's key or seed phrase into a page.
 *
 * Off by default. `fill_wallet` puts the wallet's secret into a page the
 * operator cannot inspect, and the plan makes an injected provider (step 43)
 * the supported way to use a wallet from a browser — so until that lands the
 * one action that hands the secret to arbitrary JavaScript is refused.
 *
 * Reversible on purpose: `RAKAZO_FILL_WALLET=1` restores it, and no code is
 * removed. Deleting the path outright is step 44, gated on N successful live
 * provider sessions.
 */
export function fillWalletEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RAKAZO_FILL_WALLET?.trim() === "1";
}

/** What the model is told instead of the approval card, so it stops asking. */
export const FILL_WALLET_REFUSAL =
  "Typing a wallet's key or seed phrase into a page is switched off. It cannot be turned on from here, so do not retry or look for another way to type the secret: tell the user the wallet cannot be filled into the page.";
