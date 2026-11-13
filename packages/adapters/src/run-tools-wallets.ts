import type { ToolHandlers } from "./run-tool-gate.js";
import { listUserWallets } from "./user-wallets.js";

/** Wallet tools: what a bot may see of the person's wallets. Secrets are never among it. */
export const walletTools: ToolHandlers = {
  async list_wallets(ctx) {
    const { deps, run } = ctx;
    return { wallets: await listUserWallets(deps.prisma, run.userId) };
  },
};
