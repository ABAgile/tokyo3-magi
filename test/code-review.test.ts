// The code-review workflow end to end on a scratch repository, with scripted agents.
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { queueAnswer, queueRequest } from "../src/engine/inbox.ts";
import { Run } from "../src/engine/run.ts";
import type { DriverTask } from "../src/engine/types.ts";
import { type Config, defaults } from "../src/workflows/code-review/config.ts";
import { addFinding, type Data } from "../src/workflows/code-review/data.ts";
import { codeReview } from "../src/workflows/code-review/workflow.ts";
import { FakeDriver, type FakeTurn, newRun, scratchRepo, sh } from "./helpers.ts";

function config(repo: string, extra: Partial<Config> = {}): Config {
  return {
    ...defaults(repo),
    reviewers: 2, shardLines: 12, maxRounds: 4, audits: 0,
    check: "! git grep -q BROKEN -- '*.go'",
    models: { review: ["r/one", "r/two"], patterns: ["p/one"], fix: ["f/one", "f/two", "f/three"], organize: ["o/one"], audit: ["a/one", "a/two"] },
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
        assert.equal(task.model, "f/one", "the cheapest model that did not find the issue goes first");
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
  queueAnswer(run.state.runDir, run.state, "P2", "1");
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

test("code-review: a clean review is followed by an audit of every file, which converges when clean", async () => {
  const repo = scratchRepo();
  let wt = "";
  const audited: string[] = [];
  const driver = new FakeDriver((task) => {
    if (task.key.startsWith("audit1/")) {
      const shard = task.prompt.split("\n").filter((l) => /\.go$/.test(l));
      audited.push(...shard);
      return { submit: { findings: [] }, reads: shard.map((p) => join(wt, p)) };
    }
    const q = quiet(task, wt);
    if (q) return q;
    throw new Error(`unexpected step ${task.key}`);
  });
  const run = newRun(codeReview, config(repo, { reviewers: 1, shardLines: 1000, patterns: false, organize: false, audits: 1 }), repo, driver);
  wt = run.state.target.worktree;
  assert.equal(await run.execute(codeReview), "converged");
  assert.deepEqual(audited.sort(), ["a.go", "b.go", "c/d.go"]);
  assert.deepEqual(run.data.audits.map((a) => [a.id, a.after, a.verdict]), [[1, 1, "pass"]]);
});

test("code-review: an audit finding is fixed and reviewed, and the loop converges without a second audit", async () => {
  const repo = scratchRepo();
  let wt = "";
  const driver = new FakeDriver((task) => {
    if (task.key === "audit1/1") return { submit: { findings: [issue("Off-by-one in b.go", "b.go")] } };
    if (task.key === "r2/fix/R1/1") {
      appendFileSync(join(wt, "b.go"), "// fixed after audit\n");
      return { submit: fixed("Fix off-by-one in b.go") };
    }
    const q = quiet(task, wt);
    if (q) return q;
    throw new Error(`unexpected step ${task.key}`);
  });
  const run = newRun(codeReview, config(repo, { reviewers: 1, shardLines: 1000, patterns: false, organize: false, audits: 1 }), repo, driver);
  wt = run.state.target.worktree;
  assert.equal(await run.execute(codeReview), "converged");
  assert.equal(run.data.findings[0].status, "fixed");
  assert.deepEqual(run.data.audits.map((a) => a.verdict), ["findings"]);
  assert.equal(driver.turns.some((t) => t.key.startsWith("audit2/")), false, "no second audit after the fix");
});

test("code-review: an audit that could not read every file is unaudited; resuming audits again", async () => {
  const repo = scratchRepo();
  let wt = "";
  let auditClean = false;
  const driver = new FakeDriver((task) => {
    if (task.key.startsWith("audit")) {
      return { submit: { findings: [], not_covered: auditClean ? [] : ["b.go"] }, reads: ["a.go", "c/d.go"].map((p) => join(wt, p)) };
    }
    const q = quiet(task, wt);
    if (q) return q;
    throw new Error(`unexpected step ${task.key}`);
  });
  const run = newRun(codeReview, config(repo, { reviewers: 1, shardLines: 1000, patterns: false, organize: false, audits: 1 }), repo, driver);
  wt = run.state.target.worktree;
  assert.equal(await run.execute(codeReview), "unaudited");
  assert.deepEqual(run.data.audits.map((a) => a.verdict), ["incomplete"]);
  assert.deepEqual(run.data.audits[0].unread, ["b.go"]);

  auditClean = true;
  assert.equal(await new Run(run.state, { driver, log: () => {} }).execute(codeReview), "converged");
  assert.deepEqual(run.data.audits.map((a) => a.verdict), ["incomplete", "pass"]);
});

test("code-review: an answer or request that arrives during a fix runs before the next fix", async () => {
  const repo = scratchRepo();
  let wt = "";
  let run: Run<Data, Config> | undefined;
  const driver: FakeDriver = new FakeDriver((task): FakeTurn | undefined => {
    if (task.key === "r1/fix/R1/1") {
      appendFileSync(join(wt, "a.go"), "// first\n");
      // Stands in for `magi request` run from another terminal while this fix is running.
      queueRequest(run!.state.runDir, "Add a header to b.go");
      return { submit: fixed("Fix the first finding") };
    }
    if (task.key === "r1/fix/Q1/1") {
      appendFileSync(join(wt, "b.go"), "// header\n");
      return { submit: fixed("Add a header to b.go") };
    }
    if (task.key === "r1/fix/R2/1") {
      appendFileSync(join(wt, "c/d.go"), "// second\n");
      return { submit: fixed("Fix the second finding") };
    }
    const q = quiet(task, wt);
    if (q) return q;
    throw new Error(`unexpected step ${task.key}`);
  });
  run = newRun(codeReview, config(repo, { reviewers: 1, shardLines: 1000, patterns: false, organize: false, audits: 0 }), repo, driver);
  wt = run.state.target.worktree;
  addFinding(run.data, { kind: "issue", round: 0, foundBy: "m/x", title: "First", severity: "important", sites: site("a.go"), details: {} });
  addFinding(run.data, { kind: "issue", round: 0, foundBy: "m/x", title: "Second", severity: "important", sites: site("c/d.go"), details: {} });
  assert.equal(await run.execute(codeReview), "converged");
  assert.deepEqual(driver.turns.filter((t) => t.key.includes("/fix/")).map((t) => t.key), ["r1/fix/R1/1", "r1/fix/Q1/1", "r1/fix/R2/1"]);
});
