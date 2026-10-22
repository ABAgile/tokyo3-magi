import assert from "node:assert/strict";
import { appendFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { branchState, cleanRun, findRunDir, formatRuns, runsOfRepo, runsUnder, summarize } from "../src/engine/runs.ts";
import type { Workflow } from "../src/engine/types.ts";
import { FakeDriver, newRun, scratchRepo, sh } from "./helpers.ts";

const noop: Workflow<object, object> = {
  name: "noop", summary: "", defaults: () => ({}), options: {}, init: () => ({}), run: async () => "converged", report: () => "",
};

function commitOnRunBranch(wt: string, text: string): void {
  appendFileSync(join(wt, "a.go"), `// ${text}\n`);
  sh(wt, "commit", "-qam", text);
}

test("list finds runs under the runs root and through the target repository's worktrees", () => {
  const repo = scratchRepo();
  const root = resolve(repo, "..", "runs");
  const a = newRun(noop, {}, repo, new FakeDriver(() => {}));
  a.save();
  assert.deepEqual(runsUnder(root), [a.state.runDir]);
  assert.deepEqual(runsOfRepo(join(repo, "c"), "/nonexistent"), [a.state.runDir], "found through git worktree list alone");
  assert.equal(findRunDir(`repo/${a.state.id}`, root), a.state.runDir);
  assert.throws(() => findRunDir("repo/nope", root), /not a magi run/);

  assert.equal(branchState(a.state), "no changes");
  commitOnRunBranch(a.state.target.worktree, "fix");
  assert.equal(branchState(a.state), "unmerged");
  const listing = formatRuns([summarize(a.state.runDir)], root);
  assert.match(listing, /^RUN\s+STATUS\s+QUESTIONS\s+COST\s+BRANCH STATE\s+BRANCH\n/);
  assert.match(listing, new RegExp(`repo/${a.state.id}\\s+running\\s+0\\s+\\$0\\.00\\s+unmerged\\s+${a.state.target.branch}`));
});

test("clean keeps unmerged branches unless forced, and deletes merged ones", () => {
  const repo = scratchRepo();
  const unmerged = newRun(noop, {}, repo, new FakeDriver(() => {}));
  unmerged.save();
  commitOnRunBranch(unmerged.state.target.worktree, "unmerged work");
  const merged = newRun(noop, {}, repo, new FakeDriver(() => {}));
  merged.save();
  assert.notEqual(merged.state.runDir, unmerged.state.runDir, "runs started in the same second get distinct names");
  commitOnRunBranch(merged.state.target.worktree, "merged work");
  sh(repo, "merge", "-q", "--ff-only", merged.state.target.branch);

  // Uncommitted changes stop a clean unless forced.
  appendFileSync(join(unmerged.state.target.worktree, "b.go"), "// uncommitted\n");
  assert.throws(() => cleanRun(unmerged.state.runDir, false), /uncommitted changes/);
  assert.equal(existsSync(unmerged.state.runDir), true);

  sh(unmerged.state.target.worktree, "checkout", "-q", "--", "b.go");
  const kept = cleanRun(unmerged.state.runDir, false);
  assert.match(kept.join("\n"), /kept unmerged branch/);
  assert.equal(existsSync(unmerged.state.runDir), false);
  assert.match(sh(repo, "branch", "--list", unmerged.state.target.branch), /magi-/);

  const deleted = cleanRun(merged.state.runDir, false);
  assert.match(deleted.join("\n"), /deleted branch .* \(merged\)/);
  assert.equal(sh(repo, "branch", "--list", merged.state.target.branch), "");
  assert.equal(sh(repo, "worktree", "list").split("\n").length, 1, "only the original checkout is left");
});
