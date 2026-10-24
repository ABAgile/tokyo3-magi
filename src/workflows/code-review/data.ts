// The workflow's persisted data: findings, rounds, coverage.
import type { Option } from "../../engine/types.ts";

export type Kind = "issue" | "pattern" | "request";
/**
 * open: waiting for a fixer. fixed / rejected / duplicate: settled by a fixer. deferred: a question waits for a
 * human. skipped: a human chose not to act.
 */
export type Status = "open" | "fixed" | "rejected" | "duplicate" | "deferred" | "skipped";

export interface Site { path: string; line?: number; note?: string }

export interface Attempt {
  round: number;
  model: string;
  outcome: Exclude<Status, "open" | "skipped"> | "failed";
  reason: string;
  commit?: string;
  session?: string;
}

export interface Finding {
  id: string;
  kind: Kind;
  round: number;
  foundBy: string;
  title: string;
  severity: "critical" | "important";
  /** Patterns only: whether it can be applied without a human decision. */
  change?: "mechanical" | "needs-decision";
  sites: Site[];
  /** Named sections of the report: impact, reasoning, fix for issues; pattern, interface, migration, payoff. */
  details: Record<string, string>;
  status: Status;
  /** Fix steps run for this finding; each tries up to fixTries models. */
  runs: number;
  attempts: Attempt[];
  deferral?: { question: string; options: Option[]; recommendation: string };
  /** A human's answer to the deferral, for the next fixer. */
  decision?: string;
  duplicateOf?: string;
  fixedBy?: string;
}

export interface RoundInfo {
  n: number;
  reported: string[];
  commits: string[];
  /** Review steps for which every model failed; such a round cannot count as clean. */
  failed: string[];
}

export type AuditVerdict = "pass" | "findings" | "incomplete";

/** One audit pass: the whole project, split into slices read by strong models in parallel. */
export interface AuditRun {
  id: number;
  /** The review round it followed. */
  after: number;
  /** Fixed when the audit starts, so an interrupted audit resumes on the same slices. */
  shards: string[][];
  reported: string[];
  /** Files an auditor said it could not read. */
  unread: string[];
  /** Slices where every model failed. */
  failed: string[];
  done: boolean;
  verdict?: AuditVerdict;
}

export interface Data {
  /** The round to run next (or running). */
  round: number;
  /** The last round converged and nothing new arrived since. */
  converged: boolean;
  rounds: RoundInfo[];
  audits: AuditRun[];
  findings: Finding[];
  seq: Record<"R" | "P" | "Q", number>;
  coverage: {
    /** Files a review or pattern step read, relative to the target directory. */
    visited: string[];
    /** Times each file was assigned to a reviewer without being read. */
    missed: Record<string, number>;
  };
  /** The commit the last review saw; files changed since go to the next reviewers first. */
  reviewedHead?: string;
  /** Whether fixes must pass the check. Off while the project fails it without any change. */
  checkGate: boolean;
  baseline?: { ok: boolean; output: string };
  /** Set once the history is organized: the per-finding commits map to the commits that hold them now. */
  organized?: { from: number; to: number; raw: string; map: Record<string, string> };
}

export function initData(): Data {
  return {
    round: 1, converged: false, rounds: [], audits: [], findings: [], seq: { R: 0, P: 0, Q: 0 },
    coverage: { visited: [], missed: {} }, checkGate: true,
  };
}

export function addFinding(d: Data, f: Omit<Finding, "id" | "status" | "runs" | "attempts">): Finding {
  const prefix = f.kind === "issue" ? "R" : f.kind === "pattern" ? "P" : "Q";
  const finding: Finding = { ...f, id: `${prefix}${++d.seq[prefix]}`, status: "open", runs: 0, attempts: [] };
  d.findings.push(finding);
  return finding;
}

export const findById = (d: Data, id: string): Finding | undefined => d.findings.find((f) => f.id === id);
export const openFindings = (d: Data): Finding[] => d.findings.filter((f) => f.status === "open");

export function roundInfo(d: Data, n: number): RoundInfo {
  let r = d.rounds.find((x) => x.n === n);
  if (!r) d.rounds.push((r = { n, reported: [], commits: [], failed: [] }));
  return r;
}

export function markVisited(d: Data, files: string[]): void {
  d.coverage.visited = [...new Set([...d.coverage.visited, ...files])].sort();
}
