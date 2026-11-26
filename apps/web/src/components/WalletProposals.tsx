import type { WalletProposal } from "@rakazo/contracts";
import { Spinner } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";

/**
 * Read-only view of the owner's wallet transaction proposals (step 29, B3).
 * Nothing here signs or broadcasts: it shows what a bot asked for, decoded
 * where possible, so the owner can review before approving.
 */
export function WalletProposals() {
  const [proposals, setProposals] = useState<WalletProposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const proposalsFn = (
      rpc.wallets as { proposals?: () => Promise<{ proposals: WalletProposal[] }> }
    ).proposals;
    if (!proposalsFn) {
      setLoading(false);
      return;
    }
    const resultPromise = proposalsFn();
    if (!resultPromise || typeof resultPromise.then !== "function") {
      setLoading(false);
      return;
    }
    resultPromise
      .then((result) => {
        if (alive) setProposals(result.proposals);
      })
      .catch((caught: unknown) => {
        if (alive) setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (loading) return <Spinner />;
  if (error) return <p className="text-body-sm text-red-600">{error}</p>;
  if (proposals.length === 0) return <p className="text-body-sm text-muted-foreground">No proposals.</p>;

  return (
    <ul className="space-y-2">
      {proposals.map((p) => {
        return (
          <li key={p.id} className="rounded border p-2 text-body-sm">
            <div className="font-medium">
              {p.walletName} — {p.to ?? "(deploy)"} · {p.amountWei} {p.nativeSymbol}
            </div>
            <div className="text-caption text-muted-foreground">
              {p.chainName} · {p.status} · expires {p.expiresAt}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
