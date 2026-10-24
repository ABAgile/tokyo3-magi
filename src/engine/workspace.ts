// Creating a run: a new branch from the target's HEAD, checked out in its own worktree under the run directory,
// so the original checkout is never touched. Plus a lock so only one process drives a run.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { git, isDirty } from "./git.ts";
import { now } from "./run.ts";
import type { RunState, Workflow } from "./types.ts";

export interface NewRun<C> {
  workflow: Workflow<any, C>;
  config: C;
  targetDir: string;
  runsRoot: string;
  driver: string;
}

export function createRunState<C>(o: NewRun<C>): RunState<unknown, C> {
  const target = resolve(o.targetDir);
  const repo = git(target, ["rev-parse", "--show-toplevel"]).trim();
  const sub = git(target, ["rev-parse", "--show-prefix"]).trim();
  if (isDirty(repo)) throw new Error(`${repo} has uncommitted changes: commit or stash them first (a run starts from HEAD)`);
  const name = basename(repo) + (sub ? `-${sub.replace(/\/$/, "").replaceAll("/", "-")}` : "");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  // Runs are grouped per repository: <runs>/<repo>/<workflow>-<stamp>, with -2, -3, ... for runs started in
  // the same second.
  const taken = (id: string) =>
    existsSync(join(resolve(o.runsRoot), name, id)) || git(repo, ["branch", "--list", `magi-${id}`]).trim() !== "";
  let id = `${o.workflow.name}-${stamp}`;
  for (let n = 2; taken(id); n++) id = `${o.workflow.name}-${stamp}-${n}`;
  const runDir = join(resolve(o.runsRoot), name, id);
  const worktree = join(runDir, "tree");
  // The branch lives in the target repository, so it needs no repository name: magi-<workflow>-<stamp>.
  const branch = `magi-${id}`;
  mkdirSync(runDir, { recursive: true });
  git(repo, ["worktree", "add", "-q", "-b", branch, worktree, "HEAD"]);
  return {
    version: 2, workflow: o.workflow.name, id, runDir, createdAt: now(), driver: o.driver, config: o.config, status: "running",
    ledger: join(resolve(o.runsRoot), basename(repo), "skipped.json"),
    target: { repo, sub, base: git(repo, ["rev-parse", "HEAD"]).trim(), branch, worktree },
    journal: {}, pending: {}, agents: [], questions: [], requests: [], inboxRead: 0, data: o.workflow.init(o.config),
  };
}

/** The live process holding the run's lock, other than this one. */
function holder(runDir: string): number | undefined {
  const file = join(runDir, "lock");
  if (!existsSync(file)) return undefined;
  const pid = Number(readFileSync(file, "utf8"));
  try {
    process.kill(pid, 0);
  } catch {
    return undefined;
  }
  return pid !== process.pid ? pid : undefined;
}

function take(runDir: string): () => void {
  writeFileSync(join(runDir, "lock"), String(process.pid));
  return () => rmSync(join(runDir, "lock"), { force: true });
}

/** Take the run's lock; returns the release function. Throws when another live process has it. */
export function lock(runDir: string): () => void {
  const pid = holder(runDir);
  if (pid !== undefined) throw new Error(`the run is in use by process ${pid}`);
  return take(runDir);
}

/** Take the run's lock if it is free; undefined while a loop is running on the run. */
export function tryLock(runDir: string): (() => void) | undefined {
  return holder(runDir) === undefined ? take(runDir) : undefined;
}
