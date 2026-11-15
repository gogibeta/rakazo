import { ORPCError } from "@orpc/server";
import {
  cancelWalletProposal,
  expireOverdueWalletProposals,
  findWalletProposal,
  listWalletProposals,
  WalletProposalError,
  walletProposalSecurityEvent,
  walletProposalView,
} from "@rakazo/adapters";
import { recordSecurityEvent } from "@rakazo/db";
import type { RouterContext } from "./context.js";

/**
 * The owner's transaction proposals. These are the signed-in person's own
 * proposals, scoped by row-level security and by every query's userId; no bot
 * tool reaches this surface. PR 6 lists, reads and cancels — confirming and
 * signing are a separate, password-gated step, and nothing here can sign.
 *
 * Expiry is applied on read, so a list never shows a proposal as live after
 * its deadline; the transition is recorded by the conditional update that
 * performed it, so a repeated read writes no duplicate event.
 */
export function walletProposalRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;

  const proposalEvent = (
    actor: { userId: string; spaceId: string },
    proposalId: string,
    outcome: "created" | "expired" | "cancelled",
    extra: Record<string, string | number> = {},
  ) => recordSecurityEvent(walletProposalSecurityEvent(actor, { proposalId, outcome, ...extra }));

  /** Read one proposal after applying expiry, so the status returned is current. */
  async function liveProposal(input: { userId: string; spaceId: string; proposalId: string }) {
    const found = await findWalletProposal({
      prisma: deps.prisma,
      userId: input.userId,
      proposalId: input.proposalId,
    });
    if (!found) throw new ORPCError("NOT_FOUND", { message: "Proposal not found" });
    if (found.row.status === "proposed" && found.row.expiresAt.getTime() <= Date.now()) {
      await proposalEvent(input, input.proposalId, "expired");
      return { ...found, row: { ...found.row, status: "expired" } };
    }
    return found;
  }

  // Spread into the wallets family, so the router keeps one `wallets` key.
  return {
    proposals: authed.wallets.proposals.handler(async ({ context }) => {
      const expired = await expireOverdueWalletProposals({
        prisma: deps.prisma,
        userId: context.actor.userId,
      });
      if (expired > 0) {
        await proposalEvent(context.actor, "multiple", "expired", { count: expired });
      }
      return {
        proposals: await listWalletProposals({
          prisma: deps.prisma,
          userId: context.actor.userId,
        }),
      };
    }),
    proposal: authed.wallets.proposal.handler(async ({ context, input }) => {
      const found = await liveProposal({
        userId: context.actor.userId,
        spaceId: context.actor.spaceId,
        proposalId: input.proposalId,
      });
      return walletProposalView(found);
    }),
    cancelProposal: authed.wallets.cancelProposal.handler(async ({ context, input }) => {
      try {
        await cancelWalletProposal({
          prisma: deps.prisma,
          userId: context.actor.userId,
          proposalId: input.proposalId,
        });
      } catch (error) {
        if (error instanceof WalletProposalError) {
          if (error.code === "proposal_expired") {
            await proposalEvent(context.actor, input.proposalId, "expired");
            throw new ORPCError("BAD_REQUEST", { message: error.message });
          }
          throw new ORPCError(error.code === "proposal_not_found" ? "NOT_FOUND" : "BAD_REQUEST", {
            message: error.message,
          });
        }
        throw error;
      }
      await proposalEvent(context.actor, input.proposalId, "cancelled");
      const found = await findWalletProposal({
        prisma: deps.prisma,
        userId: context.actor.userId,
        proposalId: input.proposalId,
      });
      if (!found) throw new ORPCError("NOT_FOUND", { message: "Proposal not found" });
      return walletProposalView(found);
    }),
  };
}
