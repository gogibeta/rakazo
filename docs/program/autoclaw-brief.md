# AutoClaw handover brief — AgentX program (given 2026-11-15 ~12:52 IST)

User decision 2026-11-15: from now on AutoClaw (autoclaw.z.ai, user's account, user's fine-grained GitHub token, limited time) writes ALL the code and commits to GitHub. Muse's role: give AutoClaw the context + task prompts, verify whether each task is actually done (CI/diff/live), merge + deploy + live-test, then issue the next prompt. Muse's own PR 6 builder subagent was stopped mid-build to avoid duplicate work; its partial tree sits at ~/workspace/rakazo-wallet-pr6 (AutoClaw cannot see it — it works from GitHub only).

## Message 1 — context (pasted to AutoClaw)

You are the coding agent for AgentX (a fork of Rakazo). Repo: https://github.com/gogibeta/rakazo — work there with the token provided. Default branch: main. Current main: 8e4ba33bc635c4c466c2e3771515aad7d7b3709a.

STACK: pnpm 12 + Turbo monorepo, Node 24, TypeScript, Biome formatter/linter. Apps: api, web, worker, desktop, mobile, www, vault. Packages: adapters, auth, contracts, core, db, memory, testkit.

BINDING RULES:
1. Read the repo's AGENTS.md first and follow it exactly (PR body format ## What / ## Why / ## Changes / ## Risk / ## Tested under ~350 words; Biome only; top-level import type; never run intl:extract; never edit messages.po or CHANGELOG.md).
2. Public repo: NEVER commit secrets, personal data, machine IDs, or real wallet addresses/keys. Placeholders only.
3. New tool names go in BOTH packages/adapters index.test.ts registry AND packages/contracts BUILTIN_TOOL_NAMES. Every new RPC path goes in packages/testkit authorization.test.ts (exhaustiveProtectedCalls). Every new DB model joins ROW_SECURITY_MODELS in packages/db/src/row-security.ts. Any new process.env read in server code requires the var added to the shared env anchor of all three compose files (infra/compose/docker-compose.yml, docker-compose.prod.yml, docker-compose.images.yml).
4. Workflow: ONE PR at a time. Branch from latest main → implement → run the affected test suites locally → push → open PR → wait until CI finishes → report: PR number, head SHA, files changed, test results, CI result. Do NOT merge PRs. Do NOT deploy. The verifier merges, deploys and live-tests, then gives you the next task.
5. Stay with each PR until its CI finishes. Known CI noise to ignore: the 'Translation catalogs' workflow, Vercel 'Authorization required'. A failure ONLY in the 'Preview startup tests' step of 'Lint and typecheck' (plus its dependent 'Checks' gate) is a known flake — report it as such with evidence; everything else must be green.

PROGRAM STATE (all merged + deployed + live-verified): rebrand to AgentX; signup toggle; System files v1 + denylist fix; Telegram send tool; host restart via external worker; wallet PRs 1–5 (envelope crypto, wallet_vaults + password UI, vault signer service, password migration, unlock UI + owner-started-run authorization — PRs #38–#41, #53, #56, #62); foundations F0–F8 (tool events + audit, run budgets, multi-session schema, routing contract, history hardening, approval TTL, windowed loop guard, computer lease tests — PRs #43, #45–#52, #61); model-identity fix (#37, #44); context-integrity evals (#57); restart_host Never-ask guard (#59).

WALLET SECURITY INVARIANTS (never violate): private keys live only in the vault signer service (apps/vault); api/worker/bots NEVER receive a private key or the wallet password. Migrated wallets use a password-wrap-only envelope — the server key alone must NOT be able to open them. No backdoor: without the user's wallet password nobody can sign — not bots, not the server. Every wallet operation is audited. Fill/sign refusals stay typed errors.

QUEUE (in order; wait for the verifier's go between tasks):
TASK 1: Wallet PR 6 — transaction proposals (spec in next message).
TASK 2: Wallet PR 7 — owner confirmation + vault signing + broadcast for GENERAL transactions.
TASK 3: PR #54 — computer viewer 'Connecting…' overlay (branch fix/computer-viewer-connecting-state exists; rebase onto main, re-verify, update PR).
TASK 4: PR #55 — models catalog cache fix (branch fix/models-catalog-cache exists; rebase, re-verify, update PR).
TASK 5: PR #28 — chat control tools (branch chat-app-model-tools; rebase onto main, resolve conflicts, re-verify CI).
TASK 6: PR #29 — custom connections (branch feat/custom-connections; rebase; ADD capability types to connections per the design note in the task when given).
TASK 7: Security fixes batch (separate PRs, order given later).
TASK 8: Anti-fabrication wave (order given later).

Acknowledge this context, then start TASK 1 from the next message.

## Message 2 — TASK 1 spec (pasted to AutoClaw)

TASK 1 — Wallet PR 6: transaction proposal model + validation. Branch: feat/wallet-proposals-pr6 from main 8e4ba33bc635c4c466c2e3771515aad7d7b3709a.

Read first: packages/adapters/src/wallet-envelope.ts, wallet-vault*.ts, user-wallets.ts; apps/api/src/routes/wallets.ts; apps/vault; packages/contracts/src/rpc.ts + wallets.ts (the merged wallet PRs #38–#41, #53, #56, #62 built these).

Scope (proposals ONLY — no signing, no broadcast; that is TASK 2):
- New table wallet_proposals (+ additive migration): immutable canonical transaction {id, userId, walletId, chainId, from, to (nullable = contract deploy), asset, amountWei (string), data (hex, nullable), nonce, gasLimit, maxFeePerGas, maxPriorityFeePerGas, rpcProfile, status, canonicalHash, createdAt, expiresAt}. PR 6 statuses: proposed / expired / cancelled.
- Server-side chain registry (bots never pick an RPC URL): Elysium testnet 99801, HyperEVM testnet 998, Ethereum Sepolia 11155111, each with a server-selected RPC profile.
- GENERAL transaction shape {to, value, data} covering: native send, ERC-20 transfer, mint, contract deploy (to = null, data = bytecode), arbitrary contract calls. NOT send-only.
- New bot tool wallet_propose: only in owner-started runs. The server validates everything and persists the proposal first: allowlisted chain only; wallet exists, belongs to the user, and is password_protected (refuse legacy wallets with a typed error); valid recipient address; amount parsed exactly as string/BigInt wei (no floats); balance check including gas via the allowlisted RPC; nonce fetched from chain; gas estimated with server caps; expiry ~15 minutes. Returns a deterministic proposal summary (wallet, chain, to, amount, fees, nonce, expiry, canonical hash). The bot NEVER receives key material.
- Owner RPCs: list + get own proposals, cancel a proposed one. NO confirm/sign endpoint in this PR.
- Immutability: canonical fields cannot change after persist (any change = a new proposal); canonicalHash = hash of the canonical serialization, recomputed on validation.
- Audit events for created / expired / cancelled.
- Vault service untouched for signing (sign still refuses signing_not_enabled).

Tests: happy paths (native send, data-carrying call, deploy shape); refusals (unallowlisted chain, legacy wallet, insufficient balance incl. fees, invalid recipient, float/overflow amount, non-owner-started run); immutability + canonical hash stability; expired proposal cannot transition further. House traps: tool name in BOTH registries, RPC paths in testkit authorization list, model in ROW_SECURITY_MODELS.

When CI is fully green, report: PR number, head SHA, files changed +/-, local + CI test results. Do not merge.
