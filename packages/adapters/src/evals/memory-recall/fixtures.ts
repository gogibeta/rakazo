import type { MemoryPromptDocument } from "../../memory-context.js";

/**
 * The memory-recall eval question set and the fixture corpus it runs against.
 *
 * The fixture documents carry data-level deployment facts only (counts, names,
 * a public testnet address already recorded in the design doc). No secrets, no
 * key material, no personal data. The production corpus is never committed:
 * it is exported from the deployment and passed to the runner as data.
 */

export type EvalQuestion = {
  id: string;
  kind: "scored" | "control";
  question: string;
  /** The answer fact, for the report. Controls have no fact: nothing in memory answers them. */
  fact?: string;
  /**
   * Strings whose presence in the assembled context proves the fact reached
   * the prompt (Layer 1). For controls these are the strings that would have
   * to be present for the question to be answerable from memory at all.
   */
  contextNeedles: string[];
  /** Accepted answer substrings (case-insensitive) for Layer 2 grading. */
  answerAliases?: string[];
  /** Every one of these must appear in the answer (case-insensitive). */
  answerAllOf?: string[];
  /** Regex source tested against the answer, for numeric facts. */
  answerPattern?: string;
};

export const FIXTURE_DOCUMENTS: MemoryPromptDocument[] = [
  {
    scope: "user",
    path: "deployment-facts.md",
    revision: 1,
    updatedAt: "2026-11-14T00:00:00.000Z",
    content: `# Deployment facts

- This deployment's public web address is grokagent.pages.dev.
- This space has 2 bots: Chief and grok.
- Telegram direct messages are linked to Chief.
- When a new chat doesn't tag a bot, untagged new chats go to Chief.
- Chief's configured model is gpt-6-astra.
- 4 model connections are configured, including Intern InkStone, MOSS, and Xingchi.
- Web search runs through Monid's free endpoints.
`,
  },
  {
    scope: "bot",
    path: "wallet-notes.md",
    revision: 1,
    updatedAt: "2026-11-14T01:00:00.000Z",
    content: `# Wallet notes

- Exactly 1 crypto wallet is stored, named "elysium testnet wallet evm".
- The wallet is on the Kinetiq Elysium testnet, chain ID 99801.
- The wallet's address is 0xDB25dD5028aA0AA7B6aed5f31132b7b195Ab779A.
- It is a burner wallet, testnet only.
`,
  },
];

export const QUESTIONS: EvalQuestion[] = [
  {
    id: "q1-wallet-count",
    kind: "scored",
    question: "How many crypto wallets are stored?",
    fact: "1",
    contextNeedles: ["exactly 1 crypto wallet"],
    answerPattern: "(?:^|\\D)(1|one)(?:\\D|$)",
  },
  {
    id: "q2-wallet-name",
    kind: "scored",
    question: "What is the stored wallet called?",
    fact: "elysium testnet wallet evm",
    contextNeedles: ["elysium testnet wallet evm"],
    answerAliases: ["elysium testnet wallet evm"],
  },
  {
    id: "q3-wallet-network",
    kind: "scored",
    question: "Which network is the stored wallet on?",
    fact: "Kinetiq Elysium testnet",
    contextNeedles: ["Kinetiq Elysium testnet"],
    answerAliases: ["kinetiq elysium", "elysium testnet"],
  },
  {
    id: "q4-wallet-chain-id",
    kind: "scored",
    question: "What is the stored wallet's chain ID?",
    fact: "99801",
    contextNeedles: ["99801"],
    answerPattern: "99801",
  },
  {
    id: "q5-wallet-address",
    kind: "scored",
    question: "What is the stored wallet's address?",
    fact: "0xDB25dD5028aA0AA7B6aed5f31132b7b195Ab779A",
    contextNeedles: ["0xDB25dD5028aA0AA7B6aed5f31132b7b195Ab779A"],
    answerAliases: ["0xDB25dD5028aA0AA7B6aed5f31132b7b195Ab779A"],
  },
  {
    id: "q6-bot-count",
    kind: "scored",
    question: "How many bots are in this space?",
    fact: "2",
    contextNeedles: ["2 bots"],
    answerPattern: "(?:^|\\D)(2|two)(?:\\D|$)",
  },
  {
    id: "q7-bot-names",
    kind: "scored",
    question: "What are the bots' names?",
    fact: "Chief, grok",
    contextNeedles: ["Chief and grok"],
    answerAllOf: ["chief", "grok"],
  },
  {
    id: "q8-telegram-bot",
    kind: "scored",
    question: "Which bot receives Telegram direct messages?",
    fact: "Chief",
    contextNeedles: ["Telegram direct messages are linked to Chief"],
    answerAliases: ["chief"],
  },
  {
    id: "q9-untagged-bot",
    kind: "scored",
    question: "When a new chat doesn't tag a bot, which bot gets it?",
    fact: "Chief",
    contextNeedles: ["untagged new chats go to Chief"],
    answerAliases: ["chief"],
  },
  {
    id: "q10-chief-model",
    kind: "scored",
    question: "Which model is Chief configured to use?",
    fact: "gpt-6-astra",
    contextNeedles: ["gpt-6-astra"],
    answerAliases: ["gpt-6-astra"],
  },
  {
    id: "q11-connection-count",
    kind: "scored",
    question: "How many model connections are configured?",
    fact: "4",
    contextNeedles: ["4 model connections"],
    answerPattern: "(?:^|\\D)(4|four)(?:\\D|$)",
  },
  {
    id: "q12-public-address",
    kind: "scored",
    question: "What is this deployment's public web address?",
    fact: "grokagent.pages.dev",
    contextNeedles: ["grokagent.pages.dev"],
    answerAliases: ["grokagent.pages.dev"],
  },
  {
    id: "c1-wallet-balance",
    kind: "control",
    question: "What is the current balance of the Elysium wallet?",
    contextNeedles: ["balance of", "HYPE"],
  },
  {
    id: "c2-grok-yesterday",
    kind: "control",
    question: "What did grok work on yesterday?",
    contextNeedles: ["grok worked", "yesterday"],
  },
  {
    id: "c3-telegram-password",
    kind: "control",
    question: "What is the owner's Telegram password?",
    contextNeedles: ["Telegram password is", "password:"],
  },
];

export const SCORED_QUESTIONS = QUESTIONS.filter((question) => question.kind === "scored");
export const CONTROL_QUESTIONS = QUESTIONS.filter((question) => question.kind === "control");
