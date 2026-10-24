// code-review: review, fix, and refactor a codebase until a review round comes back clean.
//
// Each round: take in human answers and requests; fix every open finding (one fixer per finding, one commit
// per fix, gated on the project check); then review: reviewers read unread files and files changed since the
// last review, and a pattern scanner looks across the project for handling that belongs behind one interface.
// Converged: a round reports nothing, nothing is open, every file has been read. After maxRounds reviews, the
// last findings are still fixed, without another review. Finally the commits are organized.
//
// Every step goes through ctx.step, so on resume run() starts from the top and skips what is done.
import { changedFiles, commitAll, diffFiles, discard, git, head, runShell, treeOf } from "../../engine/git.ts";
import type { AgentOutcome, Ctx, Option, Outcome, Workflow } from "../../engine/types.ts";
import { filesRead, inventory, makeShards, unread } from "../../kit/coverage.ts";
import { rotation } from "../../kit/models.ts";
import { organizeHistory } from "../../kit/organize.ts";
import { type Config, defaults, options } from "./config.ts";
import { addFinding, type AuditRun, type AuditVerdict, type Data, findById, type Finding, initData, markVisited, openFindings, roundInfo } from "./data.ts";
import { auditPrompt, findingText, fixPrompt, patternPrompt, reviewPrompt } from "./prompts.ts";
import { narrate } from "./narrative.ts";
import { callCommit, executive, reportHtml } from "./html.ts";
import { report } from "./report.ts";
import { PatternSchema, type Resolution, ResolutionSchema, ReviewSchema } from "./schemas.ts";

type C = Ctx<Data, Config>;

export const codeReview: Workflow<Data, Config> = {
  name: "code-review",
  summary: "review, fix, and refactor a codebase with rotating models until reviews come back clean",
  defaults,
  options,
  init: initData,
  report,
  executive,
  callCommit,
  narrate,
  html: reportHtml,

  async run(ctx) {
    await baseline(ctx);
    for (;;) {
      const n = ctx.data.round;
      if (takeHumanInput(ctx)) ctx.data.converged = false;
      if (ctx.data.converged) {
        const outcome = await conclude(ctx);
        if (outcome) return finish(ctx, outcome);
        ctx.data.converged = false; // the audit found work
      }

      await fixOpenFindings(ctx, n);
      if (n > ctx.config.maxRounds) return finish(ctx, "exhausted");

      const reported = await review(ctx, n);
      const unreadCount = unreadFiles(ctx).length;
      const failed = roundInfo(ctx.data, n).failed;
      ctx.data.converged = reported === 0 && failed.length === 0 && openFindings(ctx.data).length === 0 && unreadCount === 0;
      ctx.data.round = n + 1;
      ctx.save();
      ctx.log(`round ${n}: ${reported} new finding(s), ${roundInfo(ctx.data, n).commits.length} commit(s), ${unreadCount} file(s) not read yet${failed.length ? `; failed: ${failed.join(", ")}` : ""}`);
      if (ctx.data.converged) {
        const outcome = await conclude(ctx);
        if (outcome) return finish(ctx, outcome);
        ctx.data.converged = false;
      }
    }
  },
};

async function finish(ctx: C, outcome: Outcome): Promise<Outcome> {
  ctx.log(`${outcome} after ${ctx.data.round - 1} review round(s)`);
  if (!ctx.config.organize) return outcome;
  const describe = (sha: string) => {
    const ids = ctx.data.findings.filter((f) => f.attempts.some((a) => a.commit === sha)).map((f) => `${f.id} ${f.title}`);
    return ids.length ? `Addresses: ${ids.join("; ")}` : "";
  };
  const organized = await organizeHistory(ctx, { ...ctx.config, models: ctx.config.models.organize, describe, previous: ctx.data.organized?.map });
  if (organized) {
    ctx.data.organized = { from: organized.from, to: organized.to, raw: organized.raw, map: organized.map };
    ctx.save();
  }
  return outcome;
}

// ---- audit ----

/**
 * What a clean review leads to: a final audit of the whole project, unless the audits are used up. Returns the
 * outcome, or undefined when the audit found work and the loop must go on.
 */
async function conclude(ctx: C): Promise<Outcome | undefined> {
  const audits = ctx.data.audits;
  if (!audits.some((a) => !a.done)) {
    if (audits.at(-1)?.verdict === "pass") return "converged";
    if (audits.filter((a) => a.verdict === "findings").length >= ctx.config.audits) return "converged";
  }
  const verdict = await audit(ctx);
  if (verdict === "findings") return undefined;
  return verdict === "pass" ? "converged" : "unaudited";
}

/** One audit: every file, in slices read in parallel. An interrupted audit resumes on the same slices. */
async function audit(ctx: C): Promise<AuditVerdict> {
  const d = ctx.data;
  let run: AuditRun | undefined = d.audits.find((a) => !a.done);
  if (!run) {
    const inv = inventory(ctx.cwd, ctx.config.coverageExclude);
    const files = [...inv.keys()];
    run = {
      id: d.audits.length + 1,
      after: d.round - 1,
      shards: makeShards(inv, files, [], Math.max(files.length, 1), ctx.config.shardLines).filter((s) => s.length > 0),
      reported: [], unread: [], failed: [], done: false,
    };
    d.audits.push(run);
    ctx.save();
  }
  const current = run;
  await Promise.all(current.shards.map((shard, j) => auditShard(ctx, current, j, shard)));
  current.done = true;
  current.verdict = current.failed.length || current.unread.length ? "incomplete" : current.reported.length ? "findings" : "pass";
  ctx.log(`audit ${current.id} after round ${current.after}: ${current.verdict}, ${current.reported.length} finding(s)`
    + (current.unread.length ? `, ${current.unread.length} file(s) not read` : "")
    + (current.failed.length ? `, failed: ${current.failed.join(", ")}` : ""));
  ctx.save();
  return current.verdict;
}

async function auditShard(ctx: C, run: AuditRun, j: number, shard: string[]): Promise<void> {
  const key = `audit${run.id}/${j + 1}`;
  await ctx.step(key, async () => {
    const o = await ctx.agent({
      key, write: false, result: ReviewSchema,
      models: rotation(ctx.config.models.audit, run.id + j),
      prompt: () => auditPrompt({ focus: ctx.config.focus, shard, findings: ctx.data.findings, skipped: ctx.skipped() }),
    });
    return {
      ok: o.output !== undefined, model: o.model ?? "", findings: o.output?.findings ?? [],
      notCovered: o.output?.not_covered ?? [], read: readBy(ctx, o),
    };
  }, (r) => {
    markVisited(ctx.data, r.read);
    if (!r.ok) run.failed.push(key);
    run.unread.push(...r.notCovered);
    for (const x of r.findings) {
      const f = addFinding(ctx.data, {
        kind: "issue", round: run.after, foundBy: r.model, step: key, title: x.title, severity: x.severity, sites: x.sites,
        details: { impact: x.impact, reasoning: x.reasoning, fix: x.fix },
      });
      run.reported.push(f.id);
      reported(ctx, run.after, f);
    }
  });
}

// ---- human input ----

/** Answers reopen or skip deferred findings; requests become findings. Returns whether anything arrived. */
function takeHumanInput(ctx: C): boolean {
  const answers = ctx.answers();
  const requests = ctx.requests();
  for (const q of answers) {
    const f = findById(ctx.data, q.id);
    if (f && q.answer?.skip) f.status = "skipped";
    else if (f && q.answer) Object.assign(f, { status: "open", decision: q.answer.text });
    ctx.consume(q.id);
  }
  for (const r of requests) {
    addFinding(ctx.data, {
      kind: "request", round: ctx.data.round, foundBy: "operator", severity: "important", sites: [],
      title: r.text.split("\n")[0].slice(0, 72), details: { request: r.text },
    });
    ctx.consume(r.id);
  }
  return answers.length + requests.length > 0;
}

/** Run the check once on the unchanged project. If it already fails, fixing that becomes the first request. */
async function baseline(ctx: C): Promise<void> {
  const { check, checkTimeoutSec } = ctx.config;
  if (!check) return;
  await ctx.step("baseline", async () => runShell(ctx.cwd, check, checkTimeoutSec), (r) => {
    ctx.data.baseline = r;
    ctx.data.checkGate = r.ok;
    if (r.ok) return;
    addFinding(ctx.data, {
      kind: "request", round: 1, foundBy: "baseline", severity: "critical", sites: [],
      title: "Make the project check pass",
      details: { request: `\`${check}\` fails on the unchanged project. Make it pass. Output:\n${r.output}` },
    });
    ctx.log("the check fails before any change; fixes are not gated on it until it passes");
  });
}

// ---- fixing ----

const seq = (f: Finding): number => Number(f.id.slice(1));
const rank = (f: Finding): number =>
  f.decision ? 0 : f.kind === "request" ? 1 : f.severity === "critical" ? 2 : f.kind === "issue" ? 3 : 4;

async function fixOpenFindings(ctx: C, n: number): Promise<void> {
  // Pick again after every fix: one fix can settle other findings through also_resolves, and an answer or request
  // that arrived during the last fix is taken in here, so it runs before the next fix.
  for (;;) {
    takeHumanInput(ctx);
    const next = openFindings(ctx.data).sort((a, b) => rank(a) - rank(b) || seq(a) - seq(b))[0];
    if (!next) return;
    await fix(ctx, n, next);
  }
}

interface FixResult {
  status: Resolution["status"] | "failed";
  resolution?: Resolution;
  model: string;
  commit?: string;
  failures: AgentOutcome<unknown>["failures"];
  sessions: string[];
  gateOpened?: boolean;
}

/** One fix step: a fixer resolves the finding; a fix that passes the check becomes one commit. */
async function fix(ctx: C, n: number, f: Finding): Promise<void> {
  const cfg = ctx.config;
  const wt = ctx.state.target.worktree;
  const key = `r${n}/fix/${f.id}/${f.runs + 1}`;
  await ctx.step(key, async (): Promise<FixResult> => {
    const before = head(wt);
    let checkedTree: string | undefined;
    let gateOpened = false;
    const failedModels = f.attempts.filter((a) => a.outcome === "failed").map((a) => a.model);
    const outcome = await ctx.agent({
      key, write: true, result: ResolutionSchema, maxRepairs: 4, timeoutMin: cfg.fixTimeoutMin,
      models: rotation(cfg.models.fix, 0, [f.foundBy, ...failedModels]).slice(0, cfg.fixTries),
      prompt: (failures) => fixPrompt({ finding: f, check: ctx.data.checkGate ? cfg.check : "", open: openFindings(ctx.data), failures }),
      // The check gate: a fixed result that fails the check goes back to the same fixer with the output.
      verify: (r) => {
        const problem = resolutionProblem(f, r, ctx.data.findings);
        if (problem) return problem;
        if (head(wt) !== before) git(wt, ["reset", "-q", "--soft", before]);
        if (r.status !== "fixed" || !cfg.check || !changedFiles(wt).length) return undefined;
        const c = runShell(ctx.cwd, cfg.check, cfg.checkTimeoutSec);
        if (!c.ok && ctx.data.checkGate) {
          return `\`${cfg.check}\` failed:\n${c.output}\n\nFix the failure, then submit again. If you cannot make it pass, submit deferred with options, or rejected.`;
        }
        gateOpened ||= c.ok;
        checkedTree = treeOf(wt);
        return undefined;
      },
    });
    const base = { model: outcome.model ?? "", failures: outcome.failures, sessions: outcome.sessions };
    const r = outcome.output;
    if (!r) return { ...base, status: "failed" };
    if (head(wt) !== before) git(wt, ["reset", "-q", "--soft", before]);
    if (r.status !== "fixed") {
      discard(wt);
      return { ...base, status: r.status, resolution: r };
    }
    if (checkedTree && checkedTree !== treeOf(wt) && ctx.data.checkGate && !runShell(ctx.cwd, cfg.check, cfg.checkTimeoutSec).ok) {
      discard(wt);
      return { ...base, status: "failed", failures: [...base.failures, { model: base.model, reason: "it changed files after the check passed, and the check now fails" }] };
    }
    const subject = r.commit_subject ?? f.title;
    const commit = commitAll(wt, r.commit_body ? `${subject}\n\n${r.commit_body.trim()}\n` : `${subject}\n`);
    return { ...base, status: "fixed", resolution: r, commit, gateOpened };
  }, (res) => applyFix(ctx, n, f, res));
}

function applyFix(ctx: C, n: number, f: Finding, res: FixResult): void {
  f.runs++;
  for (const x of res.failures) f.attempts.push({ round: n, model: x.model, outcome: "failed", reason: x.reason });
  if (res.gateOpened && !ctx.data.checkGate) {
    ctx.data.checkGate = true;
    ctx.log("the check passes now; fixes are gated on it from here on");
  }
  if (res.status === "failed" || !res.resolution) {
    defer(ctx, f, {
      question: `Automatic fixes failed (${res.failures.map((x) => x.reason.split("\n")[0]).join("; ")}). How should it be fixed?`,
      options: [
        { label: "Retry, following the guidance given with this answer", consequences: "Another fixer runs with your instruction." },
        { label: "skip", consequences: "Dropped; later runs on this repository will not raise it again." },
      ],
      recommendation: "Read the fixer sessions, then give specific guidance, or skip.",
    }, res.sessions);
    ctx.log(`${f.id} deferred: automatic fixes failed`);
    return;
  }
  const r = res.resolution;
  f.attempts.push({ round: n, model: res.model, outcome: res.status, reason: r.reason, commit: res.commit, session: res.sessions.at(-1) });
  f.status = res.status;
  f.decision = undefined;
  if (res.status === "fixed") {
    if (res.commit) roundInfo(ctx.data, n).commits.push(res.commit);
    for (const id of r.also_resolves ?? []) {
      const other = findById(ctx.data, id);
      if (other?.status === "open") Object.assign(other, { status: "fixed", fixedBy: f.id });
    }
  }
  if (res.status === "duplicate") f.duplicateOf = r.duplicate_of;
  if (res.status === "deferred") {
    defer(ctx, f, { question: r.question ?? "", options: r.options ?? [], recommendation: r.recommendation ?? "" }, res.sessions);
  }
  ctx.log(`${f.id} ${res.status}${res.commit ? ` in ${res.commit.slice(0, 9)}` : ""}: ${r.reason.split("\n")[0]}`);
}

function defer(ctx: C, f: Finding, deferral: { question: string; options: Option[]; recommendation: string }, sessions: string[]): void {
  Object.assign(f, { status: "deferred", deferral, decision: undefined });
  ctx.ask({ id: f.id, title: f.title, detail: findingText(f), ...deferral, sessions });
}

/** Why a resolution cannot be accepted as given, if it cannot. */
function resolutionProblem(f: Finding, r: Resolution, all: Finding[]): string | undefined {
  if (r.status === "fixed" && !r.commit_subject?.trim()) return "a fixed finding needs commit_subject and commit_body.";
  if (r.status === "deferred" && (!r.question || !r.options || r.options.length < 2 || !r.recommendation)) {
    return "a deferred finding needs a question, at least two options, and a recommendation.";
  }
  if (r.status === "duplicate" && (!r.duplicate_of || r.duplicate_of === f.id || !all.some((x) => x.id === r.duplicate_of))) {
    return "duplicate_of must name another known finding.";
  }
  return undefined;
}

// ---- reviewing ----

function unreadFiles(ctx: C): string[] {
  const d = ctx.data;
  return unread(inventory(ctx.cwd, ctx.config.coverageExclude), new Set(d.coverage.visited), d.coverage.missed);
}

/** Reviewers and the pattern scanner run in parallel. Returns the number of findings reported. */
async function review(ctx: C, n: number): Promise<number> {
  const cfg = ctx.config;
  const wt = ctx.state.target.worktree;
  const sub = ctx.state.target.sub;
  const plan = await ctx.step(`r${n}/plan`, async () => {
    const inv = inventory(ctx.cwd, cfg.coverageExclude);
    const now = head(wt);
    const prev = ctx.data.reviewedHead;
    const changed = prev && prev !== now ? diffFiles(wt, prev, now).filter((p) => p.startsWith(sub)).map((p) => p.slice(sub.length)) : [];
    const pending = unread(inv, new Set(ctx.data.coverage.visited), ctx.data.coverage.missed);
    return { head: now, files: inv.size, shards: makeShards(inv, pending, changed, cfg.reviewers, cfg.shardLines) };
  });
  const reviewerModels = plan.shards.map((_, k) => rotation(cfg.models.review, (n - 1) * cfg.reviewers + k));
  await Promise.all([
    ...plan.shards.map((shard, k) => (k === 0 || shard.length ? reviewer(ctx, n, k, shard, reviewerModels[k]) : undefined)),
    cfg.patterns ? patternScan(ctx, n, plan.files, reviewerModels.map((m) => m[0])) : undefined,
  ]);
  await ctx.step(`r${n}/close`, async () => null, () => {
    const visited = new Set(ctx.data.coverage.visited);
    for (const p of plan.shards.flat()) if (!visited.has(p)) ctx.data.coverage.missed[p] = (ctx.data.coverage.missed[p] ?? 0) + 1;
    ctx.data.reviewedHead = plan.head;
  });
  return roundInfo(ctx.data, n).reported.length;
}

async function reviewer(ctx: C, n: number, k: number, shard: string[], models: string[]): Promise<void> {
  const key = `r${n}/review/${k + 1}`;
  await ctx.step(key, async () => {
    const o = await ctx.agent({
      key, models, write: false, result: ReviewSchema,
      prompt: () => reviewPrompt({ focus: ctx.config.focus, shard, findings: ctx.data.findings, skipped: ctx.skipped() }),
    });
    return { ok: o.output !== undefined, model: o.model ?? "", findings: o.output?.findings ?? [], read: readBy(ctx, o) };
  }, (r) => {
    if (!r.ok) roundInfo(ctx.data, n).failed.push(key);
    markVisited(ctx.data, r.read);
    for (const x of r.findings) {
      reported(ctx, n, addFinding(ctx.data, {
        kind: "issue", round: n, foundBy: r.model, step: key, title: x.title, severity: x.severity, sites: x.sites,
        details: { impact: x.impact, reasoning: x.reasoning, fix: x.fix },
      }));
    }
  });
}

async function patternScan(ctx: C, n: number, files: number, avoid: string[]): Promise<void> {
  const key = `r${n}/patterns`;
  await ctx.step(key, async () => {
    const o = await ctx.agent({
      key, write: false, result: PatternSchema,
      models: rotation(ctx.config.models.patterns, n - 1, avoid),
      prompt: () => patternPrompt({ files, findings: ctx.data.findings, skipped: ctx.skipped() }),
      verify: (r) => {
        const bad = r.patterns.filter((p) => p.change === "needs-decision" && (!p.options || p.options.length < 2 || !p.recommendation));
        return bad.length ? `needs-decision patterns need at least two options and a recommendation: ${bad.map((p) => p.title).join("; ")}` : undefined;
      },
    });
    return { ok: o.output !== undefined, model: o.model ?? "", patterns: o.output?.patterns ?? [], read: readBy(ctx, o), sessions: o.sessions };
  }, (r) => {
    if (!r.ok) roundInfo(ctx.data, n).failed.push(key);
    markVisited(ctx.data, r.read);
    for (const p of r.patterns) {
      const f = addFinding(ctx.data, {
        kind: "pattern", round: n, foundBy: r.model, step: key, title: p.title, severity: "important", change: p.change, sites: p.sites,
        details: { pattern: p.pattern, interface: p.interface, migration: p.migration, payoff: p.payoff },
      });
      // A pattern that needs a decision goes straight to a human; a fixer would only defer it again.
      if (p.change === "needs-decision") {
        defer(ctx, f, { question: `Introduce this abstraction? ${p.title}`, options: p.options ?? [], recommendation: p.recommendation ?? "" }, r.sessions);
      }
      reported(ctx, n, f);
    }
  });
}

function readBy(ctx: C, o: AgentOutcome<unknown>): string[] {
  return filesRead(ctx.cwd, o.reads, o.commands, inventory(ctx.cwd, ctx.config.coverageExclude));
}

function reported(ctx: C, n: number, f: Finding): void {
  roundInfo(ctx.data, n).reported.push(f.id);
  ctx.log(`${f.id} ${f.kind === "pattern" ? `pattern (${f.change})` : f.severity}: ${f.title}`);
}
