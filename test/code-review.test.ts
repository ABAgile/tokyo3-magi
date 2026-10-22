// The code-review workflow end to end on a scratch repository, with scripted agents.
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { answer } from "../src/engine/inbox.ts";
import { Run } from "../src/engine/run.ts";
import type { DriverTask } from "../src/engine/types.ts";
import { type Config, defaults } from "../src/workflows/code-review/config.ts";
import type { Data } from "../src/workflows/code-review/data.ts";
import { codeReview } from "../src/workflows/code-review/workflow.ts";
import { FakeDriver, type FakeTurn, newRun, scratchRepo, sh } from "./helpers.ts";

function config(repo: string, extra: Partial<Config> = {}): Config {
  return {
    ...defaults(repo),
    reviewers: 2, shardLines: 12, maxRounds: 4,
    check: "! git grep -q BROKEN -- '*.go'",
    models: { review: ["r/one", "r/two"], patterns: ["p/one"], fix: ["r/one", "f/one", "f/two"], organize: ["o/one"] },
    ...extra,
  };
}

const site = (path: string) => [{ path, line: 1 }];
const issue = (title: string, path: string) => ({ severity: "critical", title, sites: site(path), impact: "i", reasoning: "r", fix: "f" });
const pattern = (change: string, title: string, paths: string[], more = {}) => ({
  change, title, sites: paths.flatMap(site), pattern: "p", interface: "i", migration: "m", payoff: "y", ...more,
});
const fixed = (subject: string) => ({ status: "fixed", reason: "done", commit_subject: subject, commit_body: "Why." });

/** A reviewer that reads its assigned files and finds nothing; a scanner that finds nothing. */
function quiet(task: DriverTask, wt: string): FakeTurn | undefined {
  if (task.key.includes("/review/")) {
    const shard = task.prompt.split("\n").filter((l) => /\.go$/.test(l));
    return { submit: { findings: [] }, reads: shard.map((p) => join(wt, p)) };
  }
  if (task.key.endsWith("/patterns")) return { submit: { patterns: [] } };
  return undefined;
}

test("code-review: review, gated fixes, failover, deferral, organize, then a human decision on resume", async () => {
  const repo = scratchRepo();
  let wt = "";
  let run: Run<Data, Config> | undefined;
  const driver: FakeDriver = new FakeDriver((task, message, turn): FakeTurn | undefined => {
    switch (task.key) {
      case "r1/review/1":
        assert.match(task.prompt, /\na\.go\n/);
        return { submit: { findings: [issue("Nil deref in a", "a.go")] }, reads: [join(wt, "a.go")] };
      case "r1/review/2":
        writeFileSync(join(wt, "stray.txt"), "a read-only agent must not leave this");
        return { submit: { findings: [] }, commands: ["cat b.go"] };
      case "r1/patterns":
        if (turn === 1) return { submit: { patterns: [pattern("needs-decision", "Merge handlers", ["b.go", "c/d.go"])] } };
        assert.match(message, /two options and a recommendation/);
        return {
          submit: {
            patterns: [
              pattern("mechanical", "Shared env parsing", ["a.go", "b.go"]),
              pattern("needs-decision", "Merge handlers", ["b.go", "c/d.go"], {
                options: [{ label: "merge", consequences: "breaks API" }, { label: "keep", consequences: "duplication" }], recommendation: "merge",
              }),
            ],
          },
        };
      case "r2/fix/R1/1":
        assert.notEqual(task.model, "r/one", "the fixer is not the model that found the issue");
        if (turn === 1) {
          appendFileSync(join(wt, "a.go"), "// BROKEN\n");
          return { submit: fixed("Check for nil in a") };
        }
        assert.match(message, /failed/, "a failing check goes back to the same fixer");
        writeFileSync(join(wt, "a.go"), readFileSync(join(wt, "a.go"), "utf8").replace("// BROKEN\n", "// nil checked\n"));
        return { submit: fixed("Check for nil in a") };
      case "r2/fix/P1/1":
        if (task.model === "f/one") {
          appendFileSync(join(wt, "b.go"), "// half done\n");
          return { error: "model overloaded" };
        }
        appendFileSync(join(wt, "a.go"), "// uses Env\n");
        appendFileSync(join(wt, "b.go"), "// uses Env\n");
        return { submit: fixed("Share environment parsing") };
      case "r3/fix/P2/1":
        assert.match(task.prompt, /Decision: Option 1: merge/);
        appendFileSync(join(wt, "c/d.go"), "// merged\n");
        return { submit: fixed("Merge the handlers") };
    }
    if (task.key.startsWith("organize/")) {
      const shas: string[] = sh(wt, "rev-list", "--reverse", `${run!.state.target.base}..HEAD`).split("\n");
      if (turn === 1) return { submit: { commits: [{ shas: [shas[0]], subject: "x", body: "y" }] } };
      assert.match(message, /missing/);
      return { submit: { commits: [{ shas: shas.map((x) => x.slice(0, 10)), subject: "Harden a and share env parsing", body: "Why." }] } };
    }
    const q = quiet(task, wt);
    if (q) return q;
    throw new Error(`unexpected step ${task.key}`);
  });
  const lines: string[] = [];
  run = newRun(codeReview, config(repo), repo, driver, lines);
  wt = run.state.target.worktree;
  const d: Data = run.data;
  const byId = (id: string) => d.findings.find((f) => f.id === id)!;

  assert.equal(await run.execute(codeReview), "converged", lines.join("\n"));
  assert.equal(byId("R1").status, "fixed");
  assert.deepEqual(byId("P1").attempts.map((a) => [a.model, a.outcome]), [["f/one", "failed"], ["f/two", "fixed"]]);
  assert.equal(byId("P2").status, "deferred");
  assert.equal(run.state.questions[0].id, "P2");
  assert.equal(existsSync(join(wt, "stray.txt")), false);
  assert.deepEqual(d.coverage.visited, ["a.go", "b.go", "c/d.go"]);
  assert.equal(sh(wt, "rev-list", "--count", `${run.state.target.base}..HEAD`), "1", "organize squashed the two fixes");
  assert.equal(sh(wt, "rev-list", "--count", `${run.state.target.base}..${run.state.target.branch}-raw`), "2");

  // Resuming with nothing new does no work.
  const turnsBefore = driver.turns.length;
  assert.equal(await new Run(run.state, { driver, log: () => {} }).execute(codeReview), "converged");
  assert.equal(driver.turns.length, turnsBefore);

  // A human picks option 1: the next round fixes it, reviews the change, and converges again.
  answer(run.state, "P2", "1");
  assert.equal(await new Run(run.state, { driver, log: (l) => lines.push(l) }).execute(codeReview), "converged", lines.join("\n"));
  assert.equal(byId("P2").status, "fixed");
  assert.match(readFileSync(join(wt, "c/d.go"), "utf8"), /merged/);
  assert.equal(sh(wt, "status", "--porcelain"), "");
});

test("code-review: the round limit stops the loop, fixing the last findings without another review", async () => {
  const repo = scratchRepo();
  const driver = new FakeDriver((task) => {
    if (task.key === "r1/review/1") return { submit: { findings: [issue("Typo", "a.go")] } };
    if (task.key === "r2/fix/R1/1") return { submit: { status: "rejected", reason: "not a typo" } };
    throw new Error(`unexpected step ${task.key}`);
  });
  const run = newRun(codeReview, config(repo, { maxRounds: 1, reviewers: 1, patterns: false, organize: false }), repo, driver);
  assert.equal(await run.execute(codeReview), "exhausted");
  assert.equal(run.data.findings[0].status, "rejected");
});

test("code-review: a request is fixed in the next round, and a failing baseline becomes the first fix", async () => {
  const repo = scratchRepo();
  appendFileSync(join(repo, "b.go"), "// BROKEN\n");
  sh(repo, "commit", "-qam", "break");
  let wt = "";
  const driver = new FakeDriver((task) => {
    if (task.key === "r1/fix/Q1/1") {
      writeFileSync(join(wt, "b.go"), readFileSync(join(wt, "b.go"), "utf8").replace("// BROKEN\n", ""));
      return { submit: fixed("Repair b.go") };
    }
    if (task.key === "r2/fix/Q2/1") {
      writeFileSync(join(wt, "a.go"), "// header\n" + readFileSync(join(wt, "a.go"), "utf8"));
      return { submit: fixed("Add a header to a.go") };
    }
    const q = quiet(task, wt);
    if (q) return q;
    throw new Error(`unexpected step ${task.key}`);
  });
  const run = newRun(codeReview, config(repo, { reviewers: 1, shardLines: 1000, patterns: false, organize: false }), repo, driver);
  wt = run.state.target.worktree;
  assert.equal(await run.execute(codeReview), "converged");
  assert.equal(run.data.checkGate, true, "the gate opens once the check passes");
  run.state.requests.push({ id: "request-1", text: "Add a header to a.go", at: "" });
  assert.equal(await new Run(run.state, { driver, log: () => {} }).execute(codeReview), "converged");
  assert.equal(sh(wt, "log", "-1", "--format=%s"), "Add a header to a.go");
});

test("code-review: a review that failed with every model does not count as clean", async () => {
  const repo = scratchRepo();
  let wt = "";
  const driver = new FakeDriver((task) => {
    if (task.key === "r1/review/1") return { error: "provider down", reads: ["a.go", "b.go", "c/d.go"].map((p) => join(wt, p)) };
    return quiet(task, wt);
  });
  const run = newRun(codeReview, config(repo, { reviewers: 1, shardLines: 1000, maxRounds: 3, patterns: false, organize: false }), repo, driver);
  wt = run.state.target.worktree;
  assert.equal(await run.execute(codeReview), "converged");
  assert.deepEqual(run.data.rounds.map((r) => r.failed), [["r1/review/1"], []], "round 1 failed, so round 2 reviewed again");
});
