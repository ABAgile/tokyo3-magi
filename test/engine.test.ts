import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import { queueAnswer } from "../src/engine/inbox.ts";
import { Run } from "../src/engine/run.ts";
import type { Workflow } from "../src/engine/types.ts";
import { FakeDriver, newRun, scratchRepo, sh } from "./helpers.ts";

const noop: Workflow<{ applied: number }, object> = {
  name: "noop", summary: "", defaults: () => ({}), options: {}, init: () => ({ applied: 0 }),
  run: async () => "converged", report: () => "",
};
const Result = Type.Object({ answer: Type.Integer({ minimum: 1 }) });

test("step runs once and applies once, also across a restart", async () => {
  const run = newRun(noop, {}, scratchRepo(), new FakeDriver(() => {}));
  assert.match(run.state.target.branch, /^magi-noop-\d{8}-\d{6}(-\d+)?$/);
  assert.match(run.state.runDir, /\/runs\/repo\/noop-\d{8}-\d{6}(-\d+)?$/);
  assert.equal(run.state.id, run.state.runDir.split("/").at(-1));
  let calls = 0;
  const work = async () => ++calls;
  assert.equal(await run.step("s", work, (v) => (run.data.applied += v)), 1);
  assert.equal(await run.step("s", work, (v) => (run.data.applied += v)), 1);
  assert.equal(calls, 1);
  assert.equal(run.data.applied, 1);

  // A value journaled before a crash, but not applied, is applied on the next pass without running again.
  run.state.journal.t = { value: 5, applied: false, at: "" };
  await run.step("t", work, (v) => (run.data.applied += v));
  assert.equal(calls, 1);
  assert.equal(run.data.applied, 6);
});

test("agent: an invalid or unverified result is repaired in the same conversation", async () => {
  const driver = new FakeDriver((_task, _message, turn) => ({ submit: turn === 1 ? { answer: 0 } : { answer: turn } }));
  const run = newRun(noop, {}, scratchRepo(), driver);
  const out = await run.agent({
    key: "k", models: ["m/one"], write: false, result: Result, prompt: () => "go",
    verify: (r) => (r.answer < 3 ? "answer must be at least 3" : undefined),
  });
  assert.equal(out.output?.answer, 3);
  assert.deepEqual(driver.turns.map((t) => t.turn), [1, 2, 3]);
  assert.match(driver.turns[1].message, /does not match the schema: \/answer must be >= 1/);
  assert.match(driver.turns[2].message, /at least 3/);
  assert.deepEqual(driver.closed, ["session-1"]);
  assert.equal(run.state.agents[0].turns, 3);
});

test("agent: a failing model is replaced, and its edits are discarded", async () => {
  const repo = scratchRepo();
  let wt = "";
  const driver = new FakeDriver((task) => {
    appendFileSync(join(wt, "a.go"), `// ${task.model}\n`);
    return task.model === "m/bad" ? { error: "overloaded" } : { submit: { answer: 1 } };
  });
  const run = newRun(noop, {}, repo, driver);
  wt = run.state.target.worktree;
  const out = await run.agent({ key: "k", models: ["m/bad", "m/good"], write: true, result: Result, prompt: (f) => `go ${f.join(",")}` });
  assert.equal(out.model, "m/good");
  assert.deepEqual(out.failures, [{ model: "m/bad", reason: "overloaded" }]);
  assert.match(driver.turns[1].message, /go m\/bad: overloaded/);
  const a = readFileSync(join(wt, "a.go"), "utf8");
  assert.doesNotMatch(a, /m\/bad/);
  assert.match(a, /m\/good/);
});

test("agent: a read-only agent's changes are discarded", async () => {
  let wt = "";
  const run = newRun(noop, {}, scratchRepo(), new FakeDriver(() => {
    writeFileSync(join(wt, "stray.txt"), "x");
    return { submit: { answer: 1 } };
  }));
  wt = run.state.target.worktree;
  await run.agent({ key: "k", models: ["m"], write: false, result: Result, prompt: () => "go" });
  assert.equal(existsSync(join(wt, "stray.txt")), false);
});

test("resume discards what an interrupted step left, then runs it again", async () => {
  const run = newRun(noop, {}, scratchRepo(), new FakeDriver(() => {}));
  const wt = run.state.target.worktree;
  const base = sh(wt, "rev-parse", "HEAD");
  run.state.pending["r1/fix"] = base;
  appendFileSync(join(wt, "a.go"), "half done\n");
  sh(wt, "commit", "-qam", "orphan");
  run.save();
  const again = new Run(run.state, { driver: new FakeDriver(() => {}), log: () => {} });
  await again.execute(noop);
  assert.equal(sh(wt, "rev-parse", "HEAD"), base);
  assert.equal(sh(wt, "status", "--porcelain"), "");
});

test("answers: option numbers and skips are queued, then applied when the run reads its inbox", () => {
  const run = newRun(noop, {}, scratchRepo(), new FakeDriver(() => {}));
  const q = { title: "Merge handlers", detail: "b.go and d.go", question: "Merge?", options: [{ label: "merge", consequences: "c" }, { label: "keep", consequences: "c" }], recommendation: "merge", sessions: [] };
  run.ask({ id: "P1", ...q });
  run.ask({ id: "P2", ...q });
  run.ask({ id: "P3", ...q });
  assert.throws(() => queueAnswer(run.state.runDir, run.state, "P3", "7"), /no option 7/);
  queueAnswer(run.state.runDir, run.state, "P1", "1");
  queueAnswer(run.state.runDir, run.state, "P2", "skip: public API");
  assert.throws(() => queueAnswer(run.state.runDir, run.state, "P1", "2"), /waiting to be applied/);
  assert.deepEqual(run.answers().map((x) => [x.id, x.answer?.text, x.answer?.skip]), [["P1", "Option 1: merge", false], ["P2", "public API", true]]);
  assert.equal(run.skipped()[0].title, "Merge handlers");
  assert.throws(() => queueAnswer(run.state.runDir, run.state, "P1", "2"), /already answered/);
});

test("agent: an attempt that runs past its time limit is aborted, and the next model takes over", async () => {
  const driver = new FakeDriver((task) => (task.model === "m/hang" ? { hang: true } : { submit: { answer: 1 } }));
  const run = newRun(noop, {}, scratchRepo(), driver);
  const out = await run.agent({ key: "k", models: ["m/hang", "m/good"], write: false, result: Result, prompt: () => "go", timeoutMin: 0.001 });
  assert.equal(out.model, "m/good");
  assert.equal(out.output?.answer, 1);
  assert.match(out.failures[0].reason, /timed out after 0\.001 min/);
});
