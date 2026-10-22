// Finding, describing, and cleaning up runs. Runs live in <runs root>/<repo>/<workflow>-<stamp>/; the target
// repository also knows them, as worktrees, which finds runs kept under another runs root too.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { git, isDirty } from "./git.ts";
import { loadState, stateFile } from "./run.ts";
import type { RunState } from "./types.ts";
import { lock } from "./workspace.ts";

/** A run directory from a path, or from a name relative to the runs root such as "vault/code-review-<stamp>". */
export function findRunDir(arg: string, runsRoot: string): string {
  for (const dir of [resolve(arg), resolve(runsRoot, arg)]) if (existsSync(stateFile(dir))) return dir;
  throw new Error(`not a magi run: ${arg} (looked in . and ${runsRoot})`);
}

/** Every run under the runs root. */
export function runsUnder(runsRoot: string): string[] {
  if (!existsSync(runsRoot)) return [];
  const out: string[] = [];
  for (const repo of readdirSync(runsRoot, { withFileTypes: true })) {
    if (!repo.isDirectory()) continue;
    for (const run of readdirSync(join(runsRoot, repo.name), { withFileTypes: true })) {
      const dir = join(runsRoot, repo.name, run.name);
      if (run.isDirectory() && existsSync(stateFile(dir))) out.push(dir);
    }
  }
  return out;
}

/** The runs on the repository containing dir: its magi worktrees, plus runs under the runs root that target it. */
export function runsOfRepo(dir: string, runsRoot: string): string[] {
  const repo = git(resolve(dir), ["rev-parse", "--show-toplevel"]).trim();
  const found = new Set<string>();
  for (const line of git(repo, ["worktree", "list", "--porcelain"]).split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const runDir = dirname(line.slice("worktree ".length));
    if (existsSync(stateFile(runDir)) && loadState(runDir).target.repo === repo) found.add(runDir);
  }
  for (const runDir of runsUnder(runsRoot)) if (loadState(runDir).target.repo === repo) found.add(runDir);
  return [...found];
}

/** Where the run's branch stands against the target's current HEAD. */
export type BranchState = "no changes" | "merged" | "unmerged" | "gone";

export function branchState(s: RunState): BranchState {
  const { repo, branch, base } = s.target;
  if (!existsSync(repo)) return "gone";
  const tip = spawnSync("git", ["rev-parse", "--verify", "-q", `refs/heads/${branch}`], { cwd: repo, encoding: "utf8" });
  if (tip.status !== 0) return "gone";
  if (tip.stdout.trim() === base) return "no changes";
  return spawnSync("git", ["merge-base", "--is-ancestor", branch, "HEAD"], { cwd: repo }).status === 0 ? "merged" : "unmerged";
}

export interface RunSummary {
  dir: string;
  state: RunState;
  branch: BranchState;
  openQuestions: number;
  cost: number;
}

export function summarize(dir: string): RunSummary {
  const state = loadState(dir);
  return {
    dir, state, branch: branchState(state),
    openQuestions: state.questions.filter((q) => !q.answer).length,
    cost: state.agents.reduce((n, a) => n + a.cost, 0),
  };
}

/** One line per run, oldest first; names are relative to the runs root when they are under it. */
export function formatRuns(runs: RunSummary[], runsRoot: string): string {
  if (!runs.length) return "No runs.";
  const name = (dir: string) => (dir.startsWith(runsRoot + "/") ? relative(runsRoot, dir) : dir);
  const rows = runs
    .sort((a, b) => a.state.createdAt.localeCompare(b.state.createdAt))
    .map((r) => [name(r.dir), r.state.status, String(r.openQuestions), `$${r.cost.toFixed(2)}`, r.branch, r.state.target.branch]);
  const header = ["RUN", "STATUS", "QUESTIONS", "COST", "BRANCH STATE", "BRANCH"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  return [header, ...rows].map((row) => row.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd()).join("\n");
}

/**
 * Remove a run: its worktree and its directory. Its branches go too when the work is merged into the target's
 * HEAD, or there is none; otherwise they stay, unless force. Force also discards uncommitted worktree changes.
 * Returns what was done. Fails when another process is driving the run.
 */
export function cleanRun(dir: string, force: boolean): string[] {
  const s = loadState(dir);
  const unlock = lock(dir);
  const { repo, worktree, branch } = s.target;
  const done: string[] = [];
  if (existsSync(repo)) {
    if (existsSync(worktree)) {
      if (isDirty(worktree) && !force) {
        unlock();
        throw new Error(`${worktree} has uncommitted changes; use --force to discard them`);
      }
      git(repo, ["worktree", "remove", "--force", worktree]);
      done.push(`removed worktree ${worktree}`);
    }
    git(repo, ["worktree", "prune"]);
    const state = branchState(s);
    const branches = [branch, `${branch}-raw`].filter((b) => spawnSync("git", ["rev-parse", "--verify", "-q", `refs/heads/${b}`], { cwd: repo }).status === 0);
    if (state === "merged" || state === "no changes" || force) {
      for (const b of branches) git(repo, ["branch", "-D", b]);
      if (branches.length) done.push(`deleted branch${branches.length > 1 ? "es" : ""} ${branches.join(", ")} (${state})`);
    } else if (branches.length) {
      done.push(`kept unmerged branch${branches.length > 1 ? "es" : ""} ${branches.join(", ")} in ${repo}; use --force to delete`);
    }
  }
  rmSync(dir, { recursive: true, force: true });
  done.push(`removed ${dir}`);
  return done;
}
