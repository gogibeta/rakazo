# AgentX — FULL Implementation Plan (ALL user requests)

**Written:** 2026-11-15 ~15:12 IST, at the user's directive: "all features I told you to implement — all means all."
**Sources:** feature-completeness audit (~/workspace/agentx-fulltest/feature-completeness.md, 93 requests), ~/MEMORY.md, daily logs, ~/workspace/rakazo-research/.
**Working model:** AutoClaw writes ALL code (one PR at a time, in the order below). Muse verifies every PR (code + CI + Astra review on risky PRs), merges, deploys, live-tests. **Owner-hands items go LAST** (user directive 2026-11-15) — nothing in the queue blocks on them.

---

## STEP 0 — Finish what is in flight

- **PR #63 — Wallet PR 6: transaction proposals** (AutoClaw). Status: built, all 10 Astra findings fixed, CI 33/33 green, verified by Muse. Remaining: Astra re-review (Xingchi chat endpoint returning 403 since ~15:00 IST; retry loop running) → merge → rollout → live test (bot proposes a tx; owner sees the deterministic proposal; no signing yet).

## PART 1 — Implementation queue (in order)

### Wallet completion
1. **Wallet PR 7 — owner confirmation + vault signing + broadcast** for GENERAL transactions {to, value, data}: send, ERC-20 transfer, mint, contract deploy, arbitrary calls. Owner confirms the exact immutable proposal (hash shown); vault signs (password unlock grant required); allowlisted RPC broadcast; idempotent retries (a failed/lost broadcast must never create a second tx or new nonce); explicit states: signing-failed / broadcast-failed / accepted-but-response-lost / pending / confirmed / dropped. PR 7 must re-validate at sign time (balance, nonce freshness per design) and verify the vault signing address == proposal's persisted fromAddress. Every step audited.
2. **Wallet PR 8 — fill hardening**: the PR #22 browser-fill path brought up to the same standard (typed refusals, audit completeness, unlock-grant checks, migrated-wallet rules consistent with PRs 6–7).
3. **Wallet PR 9 — adversarial pass**: isolated stolen-DB + stolen-files theft exercise (no production data), throttle/race tests, grant-replay tests; fixes for anything found.

### Already-built PRs to land
4. **PR #54 — computer viewer "Connecting…" overlay** (branch fix/computer-viewer-connecting-state): rebase onto main, re-verify CI, merge, deploy, live test.
5. **PR #55 — Models page catalog cache fix** (branch fix/models-catalog-cache): rebase, re-verify, merge, deploy, live test (Models page loads fast, stale-while-revalidate).
6. **PR #28 — chat control tools** (branch chat-app-model-tools): rebase, resolve conflicts, tools app_list_models / app_get_settings / app_set_model, CI, merge, deploy, live test (plain-words model change from chat).
7. **PR #29 — custom connections** (branch feat/custom-connections): rebase; ADD capability types per Astra design (connections declare what they can do; call_connection enforces); CI, merge, deploy, live test (owner pastes a key in Settings → Custom connections — that paste is owner-hands, see Part LAST; the PR itself must not block on it).

### Security fixes batch (audit-confirmed, ~/workspace/agentx-fulltest/security-audit/run-1/)
8. Vault service off the Postgres OWNER login in the images compose (use rakazo_app like production).
9. CI publish gate: publish-server-images gets a `needs:` gate so a red main never tags :edge.
10. save_shared_memory approval gate (tainted runs must not poison user-scope memory unapproved).
11. Terminal WebSocket session revocation after upgrade.
12. Wallet-vault throttle race fix.
13. Memory-prompt delimiter escape.
14. Signups default OFF in .env.images.example.
15. Default tool-call loop cap (MAX_TOOL_CALLS_PER_TURN default).

### Security validations (13 needs-validation items — verify, fix if real)
16. Live Set-Cookie capture (terminal-WS origin + voice CSRF), RLS bypass-key table state, proxy encoded-IP parsing, system-files realpath TOCTOU, supervisor symlink-follow, import spool limits, unpruned Event/Run/Task growth, approval-expiry-at-commit re-check (post-PR #50). Each: verdict + fix PR if confirmed.

### Anti-fabrication wave
17. Authority-marked history replay; fix head+tail truncation dropping mid-payload facts; machine-readable capability registry; **deterministic server-rendered cards** for wallets / tx proposals / balances / model identity (audit A55); contradiction gate; typed result envelopes {status, authoritative, complete, source, observed_at, data, error, next}; stop conditions for missing capabilities; **fix the "Wallet Operations" preinstalled skill to preparation-only until signing exists** (it currently describes a nonexistent wallet_send — Astra ruled it harmful).

### Completeness features (never built)
18. **A40 — Per-message model provenance labels** in the chat UI (which model actually served each reply).
19. **A68 — New-chat bot picker**: tagging/picking a specific bot in a NEW chat starts that bot's session (closes the F4 gap); untagged goes to Chief (orchestrator, already live).
20. **A43 — In-app VM status**: the app shows machine state + why it is down + when it returns (data from the InstaBox API via the deployment).
21. **A13 — Drex workspace file search / Q&A with cited answers** (the unbuilt half of "Drex ALL features"): design the per-bot workspace ↔ Nace mapping or a local equivalent; build it.
22. **A54 — Drex auto context purge**: deterministic-first purge of useless/contradicted context, Settings toggle to turn it OFF (design: rakazo-research/drex-context-purge.md). **PLUS (user, 2026-11-15): a manual per-chat clean — the user can trigger the same purge for one specific chat on demand, not only the automatic purge — to save tokens in that chat.**
23. **A69 — Bot self-improvement loop**: assembled loop over shared memory (after item 10's save_shared_memory gate lands).
24. **A70 — Preinstalled Skills Pack**: build the remaining skills (1 Truthfulness, 3 Memory & Self-Improvement, 4 Web & X Reading, 5 Documents with Drex, 6 Messaging & Chat Apps, 7 App Control & Connections, 8 Coding in Sandbox, 9 Testnet Airdrop Farming, 10 Orchestration for Chief; skill 2 Wallet Operations already shipped — update it per item 17 and again when PR 7 lands).

### QwenPaw workspace phase (A73, incl. A33)
25. **Workspace tab** (peer of Chat, never inside Settings): Files = known project folders + preview-toggle editor, type/size/last-modified columns (System files v2 spec: separate tab, explicit unlock gate, secrets denylist always applies); memory-on-files (date-grouped entries); skills-as-folders. Files canonical ONLY for editable knowledge; Postgres stays canonical for bots/routing/sessions/secrets (Astra adopt-with-changes governs). Follow qwenpaw-adoption-plan.md phases.

### Remaining platform items
26. **A71 — Faster web/X reading**: fixtweet relay direct-JSON path + built-in X-reading skill, benchmarked against the current path (research: faster-web-reading-step7.md).
27. **A72 — Code Mode pattern A/B spike**: build the spike, run the eval (code-mode-eval.md), report; adopt only if it wins.
28. **A74 — General keys hardening** (beyond wallets): keys/wallets must stay protected even if the machine's files are hacked. Astra-led design first (keys-wallets-hardening.md), then implement the agreed design for model-provider keys + service credentials (the wallet slice is PRs 1–9 above).
29. **A75 — EIP-1193 wallet provider** injected into the sandbox browser so dapps see a connected wallet (backed by the vault; user-approved fills/signs only).

### Testing completion (Muse-led; AutoClaw fixes what fails)
30. **Full functional test wave**: all ~260 planned cases (~/workspace/agentx-fulltest/functional/), including the never-tested deployed features (A5 Code Change + Debug skills, A6 Checkpoints, A7 Worktree isolation, A8 Retrospective, A17 rich messaging cards, A19 streaming to chats, A20 routine results — create a routine to test, A22 browser stealth, A24 memory-prefix change), Gate 6 multi-key rotation live test (two disposable keys), Gate 7 proxy live tests, per-PR test blocks as each Part 1 PR deploys, Phase Z final sweep.
31. **Eval live runs**: F0 production-corpus baseline + Layer 2 live answers (memory-recall + context-integrity) with an Astra-pinned scratch bot.
32. **A82 — Computer auto-recovery**: formal closure — controlled power-cycle test, verify team computer recovery end-to-end, fix if it fails.
33. **phase0-export.sh fix** (write-on-machine + instabox pull; pre-create rakazo_app role) + re-run the export/restore rehearsal.

### WordGameX
34. **B4 — StreetFighterdle fixes**: clue-text corrections + give-up answer as a popup (goal workspace exists, never done).

### Last by the user's own sequencing
35. **B10 — Ripwire implementation**: research done (adopt with guardrails, trial on our tree); implement LAST, after everything above.

## PART LAST — Owner-hands (the user does these at the end; nothing above blocks on them)
- **Live wallet migration**: type the existing wallet password once in Settings → Crypto wallets (password already set 2026-11-15 02:31 IST). Unlocks: PR #62 unlock-UI live test, PR 6 live test with a migrated wallet, PR 7 live tests.
- **PR 7 live test confirmations**: confirm the 0.0001 HYPE test send (+ a testnet mint/deploy) in the app when Muse presents them.
- **PR #29 live test**: paste a GitHub PAT in Settings → Custom connections.
- **B3 — WordGameX share cards deploy**: say "deploy it" in an interactive turn (built + committed 79f1512; background deploys are 403-blocked).
- **A78 — WhatsApp**: create the Meta Business app + number if still wanted.
- **Decisions**: restore grok's primary chat from the Phase 0 export (only copy; ~16h unrecoverable either way) — yes/no. F6 approvals test re-run (needs Approvals Mode switched to Ask temporarily) — yes/no.
- **Revoke the fine-grained GitHub token** given to AutoClaw when all tasks are complete.

## Explicitly OUT (user decisions, not features)
- A45 8-hour runs / paid InstaBox plan — user chose to STAY on free (2026-11-14).
- A76 Fortress browser engine — parked by the user (activates tilion themselves).
- A77 Composio — rejected by the user (2026-11-13); replaced by PR #29.
- External coding engines inside AgentX (Claude Code / Codex / ACP) — rejected (2026-11-12). AutoClaw as the external builder for the fork's code is the user's separate explicit instruction (2026-11-15).

## Status snapshot (2026-11-15 15:12 IST)
- LIVE-VERIFIED: 41+ of 93 requests (all PRs through #62 except as noted; foundations F0–F8; wallet PRs 1–5).
- IN FLIGHT: PR #63 (Step 0).
- This plan's Part 1 = every remaining NOT-STARTED / RESEARCH-ONLY / BUILT-PR-OPEN / IN-PROGRESS item from the audit, ordered.
