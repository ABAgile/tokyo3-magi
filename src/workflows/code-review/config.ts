// Settings of the code-review workflow, their defaults, and the command-line options that change them.
// <magi>/config.json can override defaults per workflow: { "code-review": { "maxRounds": 8, ... } }.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { OptionSpec } from "../../engine/types.ts";

export interface Config {
  models: {
    /** Reviewers, in turn: round n, reviewer k takes entry (n-1)*reviewers+k. */
    review: string[];
    /** Pattern scanners, one per round, avoiding that round's reviewers when possible. */
    patterns: string[];
    /** Fixers, avoiding the model that reported the finding; the next takes over when one fails. */
    fix: string[];
    organize: string[];
  };
  /** Review rounds at most. Findings of the last review are still fixed, without a re-review. */
  maxRounds: number;
  /** Reviewers per round, run in parallel on separate slices of the unread files. */
  reviewers: number;
  /** Run the abstraction-pattern scan each round. */
  patterns: boolean;
  /** Lines of unread files given to each reviewer per round. */
  shardLines: number;
  focus: string;
  /** Shell command a fix must pass, run in the target directory. "" disables the gate. */
  check: string;
  checkTimeoutSec: number;
  /** Fixer models tried per finding before it goes to a human. */
  fixTries: number;
  /** Squash and reorder the per-finding commits at the end. */
  organize: boolean;
  checkEachCommit: boolean;
  /** Extra git pathspecs left out of coverage, e.g. ":(exclude)docs". */
  coverageExclude: string[];
}

export function defaults(targetDir: string): Config {
  return {
    models: {
      review: ["openai-codex/gpt-6.1-sol:high", "anthropic/claude-opus-5-5:high", "openai-codex/gpt-6-luna:xhigh"],
      patterns: ["anthropic/claude-opus-5-5:high", "openai-codex/gpt-6.1-sol:high"],
      fix: ["anthropic/claude-sonnet-5-5:high", "openai-codex/gpt-6.1-sol:high", "anthropic/claude-opus-5-5:high"],
      organize: ["anthropic/claude-sonnet-5-5:medium", "openai-codex/gpt-6-luna:high"],
    },
    maxRounds: 6,
    reviewers: 2,
    patterns: true,
    shardLines: 6000,
    focus: "correctness, security, regressions, missing tests, error handling, concurrency, resource leaks",
    check: existsSync(join(targetDir, "go.mod")) ? "go build ./... && go vet ./... && go test ./..." : "",
    checkTimeoutSec: 1200,
    fixTries: 2,
    organize: true,
    checkEachCommit: false,
    coverageExclude: [],
  };
}

function positive(name: string, v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} needs a positive integer`);
  return n;
}

const list = (v: unknown): string[] => String(v).split(",").map((x) => x.trim()).filter(Boolean);

export const options: Record<string, OptionSpec<Config>> = {
  "max-rounds": { type: "string", help: "review rounds at most (default 6)", apply: (c, v) => (c.maxRounds = positive("max-rounds", v)) },
  reviewers: { type: "string", help: "parallel reviewers per round (default 2)", apply: (c, v) => (c.reviewers = positive("reviewers", v)) },
  "shard-lines": { type: "string", help: "lines of unread files per reviewer per round (default 6000)", apply: (c, v) => (c.shardLines = positive("shard-lines", v)) },
  check: { type: "string", help: "command a fix must pass (default for Go: build, vet, test)", apply: (c, v) => (c.check = String(v)) },
  "no-check": { type: "boolean", help: "accept fixes without a check", apply: (c) => (c.check = "") },
  focus: { type: "string", help: "what reviewers prioritize", apply: (c, v) => (c.focus = String(v)) },
  "no-patterns": { type: "boolean", help: "skip the abstraction-pattern scan", apply: (c) => (c.patterns = false) },
  "no-organize": { type: "boolean", help: "keep one commit per finding", apply: (c) => (c.organize = false) },
  "check-each-commit": { type: "boolean", help: "run the check on every organized commit", apply: (c) => (c.checkEachCommit = true) },
  exclude: { type: "string", multiple: true, help: "pathspec left out of coverage, e.g. ':(exclude)docs' (repeatable)", apply: (c, v) => (c.coverageExclude = v as string[]) },
  "review-models": { type: "string", help: "comma-separated reviewer models", apply: (c, v) => (c.models.review = list(v)) },
  "pattern-models": { type: "string", help: "comma-separated pattern-scan models", apply: (c, v) => (c.models.patterns = list(v)) },
  "fix-models": { type: "string", help: "comma-separated fixer models", apply: (c, v) => (c.models.fix = list(v)) },
  "organize-models": { type: "string", help: "comma-separated commit-organizer models", apply: (c, v) => (c.models.organize = list(v)) },
};
