import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { writeHtmlReport } from "../src/engine/html.ts";
import { defaults } from "../src/workflows/code-review/config.ts";
import type { Finding } from "../src/workflows/code-review/data.ts";
import { narrate } from "../src/workflows/code-review/narrative.ts";
import { codeReview } from "../src/workflows/code-review/workflow.ts";
import { FakeDriver, newRun, scratchRepo } from "./helpers.ts";

const finding = (id: string, status: Finding["status"], title: string): Finding => ({
  id, kind: id.startsWith("P") ? "pattern" : "issue", round: 1, foundBy: "m/one", title, severity: "important",
  sites: [{ path: "a.go", line: 1 }], details: {}, status, runs: 1, attempts: [],
});

test("summary: a category that names an unfixed finding is repaired in the same conversation", async () => {
  const repo = scratchRepo();
  const driver = new FakeDriver((_task, _message, turn) => ({
    submit: turn === 1
      ? { state: ["Settled."], categories: [{ title: "Sessions", summary: "Sessions kept.", ids: ["R1", "R2"] }] }
      : { state: ["Settled."], categories: [{ title: "Sessions", summary: "Sessions kept.", ids: ["R1"] }, { title: "Helpers", summary: "Shared helper.", ids: ["P1"] }] },
  }));
  const run = newRun(codeReview, defaults(repo), repo, driver);
  run.state.data.findings.push(finding("R1", "fixed", "Deactivated users keep sessions"), finding("R2", "deferred", "Pending choice"), finding("P1", "fixed", "Shared helper"));

  const n = await narrate(run);
  assert.ok(n, "a summary is returned");
  assert.equal(n.categories.length, 2);
  assert.equal(driver.turns.length, 2, "the rejected result is repaired in the same conversation");
  assert.match(driver.turns[1].message, /R2 is not a fixed finding/);

  // The same facts and prompt: the cached summary is used, and no agent is called.
  const again = await narrate(run);
  assert.deepEqual(again?.categories, n.categories);
  assert.equal(driver.turns.length, 2);

  const html = readFileSync(writeHtmlReport(run.state, codeReview, { sessions: false, pi: "/nonexistent", narrative: n }), "utf8");
  assert.match(html, /Where the project stands/);
  assert.match(html, /Fixing categories/);
  assert.match(html, /<a href="#R1">R1<\/a>/, "each category links to its findings");
  assert.match(html, /Written by .* on \d{4}-\d{2}-\d{2}/);
  assert.match(html, /Findings fixed/, "the figures stay on the page");
  assert.ok(readFileSync(join(run.state.runDir, "report", "narrative.json"), "utf8").includes('"fingerprint"'));
});

test("summary: a fixed finding left out of every category is reported to the agent", async () => {
  const repo = scratchRepo();
  const driver = new FakeDriver((_task, _message, turn) => ({
    submit: turn === 1
      ? { state: ["Settled."], categories: [{ title: "Sessions", summary: "Sessions kept.", ids: ["R1"] }] }
      : { state: ["Settled."], categories: [{ title: "Sessions", summary: "Sessions kept.", ids: ["R1"] }, { title: "Helpers", summary: "Shared helper.", ids: ["P1"] }] },
  }));
  const run = newRun(codeReview, defaults(repo), repo, driver);
  run.state.data.findings.push(finding("R1", "fixed", "Sessions"), finding("P1", "fixed", "Helpers"));

  const n = await narrate(run);
  assert.equal(n?.categories.length, 2);
  assert.match(driver.turns[1].message, /these fixed findings are in no category: P1/);
});
