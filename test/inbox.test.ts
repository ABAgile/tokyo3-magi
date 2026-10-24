import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { applyInbox, inboxFile, queueAnswer, queueRequest } from "../src/engine/inbox.ts";
import { loadState } from "../src/engine/run.ts";
import { tryLock } from "../src/engine/workspace.ts";
import type { Workflow } from "../src/engine/types.ts";
import { FakeDriver, newRun, scratchRepo } from "./helpers.ts";

const noop: Workflow<object, object> = {
  name: "noop", summary: "", defaults: () => ({}), options: {}, init: () => ({}), run: async () => "converged", report: () => "",
};
const question = {
  title: "Merge handlers", detail: "b.go and d.go", question: "Merge?",
  options: [{ label: "merge", consequences: "c" }, { label: "keep", consequences: "c" }], recommendation: "merge", sessions: [],
};

test("a save by the running loop does not erase an answer queued from another process", async () => {
  const run = newRun(noop, {}, scratchRepo(), new FakeDriver(() => {}));
  const dir = run.state.runDir;
  run.ask({ id: "P1", ...question });
  // `magi decide` in another process queues an answer; the running loop then saves its own copy of the state.
  queueAnswer(dir, loadState(dir), "P1", "1");
  await run.step("next-step", async () => 1);
  assert.deepEqual(run.answers().map((q) => [q.id, q.answer?.text]), [["P1", "Option 1: merge"]]);
  assert.equal(loadState(dir).questions[0].answer?.text, "Option 1: merge", "the answer is kept on disk too");
});

test("inbox entries are applied once, in order; a partly written line waits for its newline", () => {
  const run = newRun(noop, {}, scratchRepo(), new FakeDriver(() => {}));
  const dir = run.state.runDir;
  const s = run.state;
  queueRequest(dir, "first");
  appendFileSync(inboxFile(dir), '{"type":"request","id":"request-x","text":"second","at":"2026-01-01T00:00:00.000Z"}');
  assert.equal(applyInbox(dir, s), 1, "the incomplete line is not read yet");
  appendFileSync(inboxFile(dir), "\n");
  assert.equal(applyInbox(dir, s), 1);
  assert.deepEqual(s.requests.map((r) => r.text), ["first", "second"]);
  assert.equal(applyInbox(dir, s), 0, "nothing is applied twice");
});

test("a run held by a live loop keeps the lock; a run without one can be applied at once", () => {
  const run = newRun(noop, {}, scratchRepo(), new FakeDriver(() => {}));
  const dir = run.state.runDir;
  const child = spawn("sleep", ["30"]);
  try {
    writeFileSync(join(dir, "lock"), String(child.pid));
    assert.equal(tryLock(dir), undefined, "a live loop is running on the run");
  } finally {
    child.kill();
  }
  writeFileSync(join(dir, "lock"), "999999");
  const unlock = tryLock(dir);
  assert.ok(unlock, "no live process holds the lock");
  unlock();
});
