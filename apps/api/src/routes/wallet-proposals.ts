import { ORPCError } from "@orpc/server";
import {
  cancelWalletProposal,
  findWalletProposal,
  getWalletProposal,
  listWalletProposals,
  WalletProposalError,
  walletProposalView,
} from "@rakazo/adapters";
import type { RouterContext } from "./context.js";

/**
 * The owner's transaction proposals. These are the signed-in person's own
 * proposals, scoped by row-level security and by every query's userId; no bot
 * tool reaches this surface. PR 6 lists, reads and cancels — confirming and
 * signing are a separate, password-gated step, and nothing here can sign.
 *
 * Expiry is a real persisted transition, performed by a conditional update
 * against the database clock with its security event in the same transaction
 * (see wallet-proposals.ts). A read never invents a status: it runs the same
 * sweep first, so what it returns is what the table says.
 */
export function walletProposalRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;

  return {
    proposals: authed.wallets.proposals.handler(async ({ context }) => {
      return {
        proposals: await listWalletProposals({
          prisma: deps.prisma,
          userId: context.actor.userId,
          spaceId: context.actor.spaceId,
        }),
      };
    }),
    proposal: authed.wallets.proposal.handler(async ({ context, input }) => {
      // One transaction: the sweep and the read see the same snapshot, so a row
      // returned as "proposed" was live at the moment it was read.
      const found = await getWalletProposal({
        prisma: deps.prisma,
        userId: context.actor.userId,
        spaceId: context.actor.spaceId,
        proposalId: input.proposalId,
      });
      if (!found) throw new ORPCError("NOT_FOUND", { message: "Proposal not found" });
      return walletProposalView(found);
    }),
    cancelProposal: authed.wallets.cancelProposal.handler(async ({ context, input }) => {
      try {
        await cancelWalletProposal({
          prisma: deps.prisma,
          userId: context.actor.userId,
          spaceId: context.actor.spaceId,
          proposalId: input.proposalId,
        });
      } catch (error) {
        if (error instanceof WalletProposalError) {
          throw new ORPCError(error.code === "proposal_not_found" ? "NOT_FOUND" : "BAD_REQUEST", {
            message: error.message,
          });
        }
        throw error;
      }
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
