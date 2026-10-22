import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { codeReview } from "../src/workflows/code-review/workflow.ts";
import { describeSettings, initSettings, loadSettings, resolveRunsRoot, settingsProblems, workflowConfig } from "../src/settings.ts";

const dir = () => mkdtempSync(join(tmpdir(), "magi-settings-"));
const workflows = [codeReview];

test("a missing file means no settings; a broken one names itself", () => {
  const root = dir();
  assert.deepEqual(loadSettings(join(root, "config.json")), {});
  const bad = join(root, "config.json");
  writeFileSync(bad, "{ nope");
  assert.throws(() => loadSettings(bad), new RegExp(`${bad} is not valid JSON`));
});

test("file values override the built-in defaults; model roles merge one by one", () => {
  const target = dir();
  const settings = { "code-review": { maxRounds: 9, models: { review: ["x/y:high"] } } };
  const config = workflowConfig(codeReview, target, settings);
  assert.equal(config.maxRounds, 9);
  assert.deepEqual(config.models.review, ["x/y:high"]);
  assert.deepEqual(config.models.fix, codeReview.defaults(target).models.fix, "unset roles keep their defaults");
  assert.equal(config.reviewers, codeReview.defaults(target).reviewers);
});

test("magi config init writes defaults that reproduce the built-in configuration, and never overwrites", () => {
  const root = dir();
  const file = join(root, "config.json");
  initSettings(file, workflows);
  const written = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(written.driver, "pi-sdk");
  assert.equal(written.runsDir, "runs");
  assert.equal("check" in written["code-review"], false, "the check is detected per target, not written");
  const target = dir(); // no go.mod, so the built-in check is empty
  assert.deepEqual(workflowConfig(codeReview, target, loadSettings(file)), codeReview.defaults(target));
  assert.throws(() => initSettings(file, workflows), /already exists/);
  assert.equal(existsSync(file), true);
});

test("problems: typos, unknown roles, and unknown drivers are reported, not silently ignored", () => {
  const problems = settingsProblems({
    driver: "nope",
    drivr: "pi-sdk",
    "code-review": { maxRound: 3, models: { reviewer: ["a"], fix: ["b"] } },
  }, workflows);
  assert.deepEqual(problems.sort(), [
    'unknown driver "nope"',
    'unknown key "drivr": not a setting and not a workflow name',
    'unknown code-review setting "maxRound"',
    'unknown model role "reviewer" in code-review',
  ].sort());
  assert.deepEqual(settingsProblems({ driver: "pi-cli", "code-review": { maxRounds: 2 } }, workflows), []);
});

test("runs directory: the flag wins, then $MAGI_RUNS, then config.json, then the built-in folder", () => {
  const home = "/magi";
  assert.deepEqual(resolveRunsRoot({ runsDir: "r" }, home, { MAGI_RUNS: "/env" }, "/flag"), { path: "/flag", source: "--runs-dir" });
  assert.deepEqual(resolveRunsRoot({ runsDir: "r" }, home, { MAGI_RUNS: "/env" }), { path: "/env", source: "$MAGI_RUNS" });
  assert.deepEqual(resolveRunsRoot({ runsDir: "r" }, home, {}), { path: "/magi/r", source: "config.json" });
  assert.deepEqual(resolveRunsRoot({}, home, {}), { path: "/magi/runs", source: "built-in" });
});

test("describe lists each value with its source, and the problems with the file", () => {
  const target = dir();
  const text = describeSettings({
    file: join(target, "config.json"), settings: { "code-review": { maxRounds: 9 }, bogus: 1 }, home: "/magi",
    env: {}, cwd: target, workflows,
  });
  assert.match(text, /not present: built-in values apply/);
  assert.match(text, /driver: pi-sdk \(built-in\)/);
  assert.match(text, /runsDir: \/magi\/runs \(built-in\)/);
  assert.match(text, /maxRounds: 9 \(config.json\)/);
  assert.match(text, /reviewers: 2 \(built-in\)/);
  assert.match(text, /check: "" \(built-in, detected per target\)/);
  assert.match(text, /warnings:\n {2}unknown key "bogus"/);
});
