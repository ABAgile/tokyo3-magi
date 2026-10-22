// History organization for workflows that commit as they go: a model groups and orders the run's commits into a
// reviewable history. A plan is dry-run while the model can still revise it; the final rebuild must end at
// exactly the same tree, or the history stays as it was. The previous history is kept on "<branch>-raw".
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Static, Type } from "typebox";
import { commitAll, discard, git, head, runShell } from "../engine/git.ts";
import type { Ctx, RunState } from "../engine/types.ts";

export const PlanSchema = Type.Object({
  commits: Type.Array(
    Type.Object({
      shas: Type.Array(Type.String(), { minItems: 1, description: "Existing commits to combine, in the order to apply them" }),
      subject: Type.String({ minLength: 1, maxLength: 72 }),
      body: Type.String(),
    }),
    { minItems: 1, description: "The new commits, in order" },
  ),
});
export type Plan = Static<typeof PlanSchema>;

export interface OrganizeOptions {
  models: string[];
  check: string;
  checkTimeoutSec: number;
  /** Run the check on every new commit before accepting the history. */
  checkEachCommit: boolean;
  /** Extra context for a commit, e.g. the findings it addresses. */
  describe?: (sha: string) => string;
}

export interface Organized { from: number; to: number; raw: string; head: string }

/** Organize the commits since the run's base. Journaled per HEAD, so it reruns only after new commits. */
export async function organizeHistory<D, C>(ctx: Ctx<D, C>, o: OrganizeOptions): Promise<Organized | null> {
  const s = ctx.state as RunState;
  const wt = s.target.worktree;
  const shas = git(wt, ["rev-list", "--reverse", `${s.target.base}..HEAD`]).split("\n").filter(Boolean);
  if (shas.length < 2) return null;
  const key = `organize/${head(wt).slice(0, 12)}`;
  return ctx.step(key, async () => {
    const history = shas.map((sha) => `${git(wt, ["show", "--stat", "--format=### %H%n%B", sha]).trim()}${o.describe ? `\n${o.describe(sha)}` : ""}`).join("\n\n");
    const outcome = await ctx.agent({
      key, models: o.models, write: false, result: PlanSchema,
      prompt: () => prompt(history),
      verify: (plan) => {
        const problem = normalize(plan, shas) ?? tryPlan(s, plan);
        return problem ? `${problem}. Revise the plan.` : undefined;
      },
    });
    if (!outcome.output) {
      ctx.log("kept the history as it is: no acceptable plan");
      return null;
    }
    const result = rebuild(s, outcome.output, o);
    if (typeof result === "string") {
      ctx.log(`kept the history as it is: ${result}`);
      return null;
    }
    ctx.log(`organized ${shas.length} commits into ${result.to}; the previous history is on ${result.raw}`);
    return result;
  });
}

function prompt(history: string): string {
  return `These commits were made one change at a time by an automated loop. Rewrite them into a history a reviewer can follow.

${history}

Rules:
- Every commit above appears in exactly one new commit. Never drop one.
- Combine commits that change the same behavior: a change and a later correction of it, or several fixes of one recurring defect. Keep unrelated topics in separate commits.
- Order the new commits so that each builds on the ones before it: prerequisites and shared abstractions first. Keep the relative order of commits that touch the same files unless there is a reason to change it.
- Each message: an imperative, effect-oriented subject of at most 72 characters, and a body wrapped at 72 columns that explains why and the behavior change, including any compatibility impact. No finding IDs, round numbers, or other labels from the loop.

Inspect commits with git show as needed.`;
}

/** Expand abbreviated SHAs in place, and check every commit is used exactly once. */
function normalize(plan: Plan, shas: string[]): string | undefined {
  const used = new Set<string>();
  for (const c of plan.commits) {
    for (let i = 0; i < c.shas.length; i++) {
      const given = c.shas[i].trim();
      const match = given.length >= 7 ? shas.filter((sha) => sha.startsWith(given)) : [];
      if (match.length !== 1) return `${given} is not one of the listed commits`;
      if (used.has(match[0])) return `${given} is used more than once`;
      used.add(match[0]);
      c.shas[i] = match[0];
    }
  }
  const missing = shas.filter((sha) => !used.has(sha));
  return missing.length ? `these commits are missing: ${missing.map((m) => m.slice(0, 12)).join(", ")}` : undefined;
}

/** Replay the plan on a detached HEAD at the base. On success HEAD is the new history; call restore() or adopt(). */
function replay(s: RunState, plan: Plan): { made: string[] } | { problem: string } {
  const wt = s.target.worktree;
  const tree = git(wt, ["rev-parse", "HEAD^{tree}"]).trim();
  git(wt, ["checkout", "-q", "--detach", s.target.base]);
  const made: string[] = [];
  for (const c of plan.commits) {
    for (const sha of c.shas) {
      if (spawnSync("git", ["cherry-pick", "--no-commit", sha], { cwd: wt }).status !== 0) {
        return { problem: `${sha.slice(0, 12)} does not apply on top of the commits planned before it` };
      }
    }
    const sha = commitAll(wt, `${c.subject.trim()}\n\n${c.body.trim()}\n`);
    if (sha) made.push(sha);
  }
  if (git(wt, ["rev-parse", "HEAD^{tree}"]).trim() !== tree) return { problem: "the rebuilt history does not end at the same tree" };
  return { made };
}

/** Back to the branch as it was. */
function restore(s: RunState): void {
  spawnSync("git", ["cherry-pick", "--abort"], { cwd: s.target.worktree });
  discard(s.target.worktree);
  git(s.target.worktree, ["checkout", "-q", "-f", s.target.branch]);
}

/** Dry run: the problem with a plan, if any. The branch is left as it was. */
function tryPlan(s: RunState, plan: Plan): string | undefined {
  const r = replay(s, plan);
  restore(s);
  return "problem" in r ? r.problem : undefined;
}

/** Replay the plan and move the branch to the result, keeping the old history on "<branch>-raw". */
function rebuild(s: RunState, plan: Plan, o: OrganizeOptions): Organized | string {
  const original = head(s.target.worktree);
  const r = replay(s, plan);
  try {
    if ("problem" in r) throw new Error(r.problem);
    if (o.checkEachCommit && o.check) checkEach(s, r.made, o);
  } catch (err) {
    restore(s);
    return err instanceof Error ? err.message : String(err);
  }
  const raw = `${s.target.branch}-raw`;
  git(s.target.worktree, ["branch", "-f", raw, original]);
  git(s.target.worktree, ["checkout", "-q", "-B", s.target.branch]);
  return { from: plan.commits.reduce((n, c) => n + c.shas.length, 0), to: r.made.length, raw, head: head(s.target.worktree) };
}

/** Run the check on each new commit in a scratch worktree, so every commit builds on its own. */
function checkEach(s: RunState, commits: string[], o: OrganizeOptions): void {
  const dir = mkdtempSync(join(tmpdir(), "magi-check-"));
  git(s.target.worktree, ["worktree", "add", "-q", "--detach", dir, s.target.base]);
  try {
    for (const sha of commits) {
      git(dir, ["checkout", "-q", "--detach", sha]);
      const r = runShell(join(dir, s.target.sub), o.check, o.checkTimeoutSec);
      if (!r.ok) throw new Error(`commit ${sha.slice(0, 12)} fails the check on its own: ${r.output.split("\n").slice(-5).join(" ")}`);
    }
  } finally {
    git(s.target.worktree, ["worktree", "remove", "--force", dir]);
  }
}
