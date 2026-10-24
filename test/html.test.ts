import assert from "node:assert/strict";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { writeHtmlReport } from "../src/engine/html.ts";
import { defaults } from "../src/workflows/code-review/config.ts";
import { codeReview } from "../src/workflows/code-review/workflow.ts";
import { FakeDriver, newRun, scratchRepo, sh } from "./helpers.ts";

test("html report: escapes content, shows timeline, commits, findings, and transcript links", () => {
  const repo = scratchRepo();
  const run = newRun(codeReview, defaults(repo), repo, new FakeDriver(() => {}));
  const s = run.state;
  const wt = s.target.worktree;

  appendFileSync(join(wt, "a.go"), "// fix\n");
  sh(wt, "commit", "-qam", "Fix <nil> & friends");
  const sha = sh(wt, "rev-parse", "HEAD");

  const session = join(s.runDir, "sessions", "r1", "review", "1", "2026-01-01T00-00-00-000Z_x.jsonl");
  mkdirSync(dirname(session), { recursive: true });
  writeFileSync(session, '{"type":"session"}\n');
  s.agents.push({
    key: "r1/review/1", model: "m/one", driver: "fake", startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:05:00.000Z", session, cost: 0.5, turns: 1,
  });
  s.data.findings.push({
    id: "R1", kind: "issue", round: 1, foundBy: "m/one", title: "<script>alert(1)</script>", severity: "critical",
    sites: [{ path: "a.go", line: 3 }], details: { impact: "x & y" }, status: "fixed", runs: 1,
    attempts: [{ round: 1, model: "m/fixer", outcome: "fixed", reason: "ok", commit: sha, session }],
  });

  // A stand-in for pi: writes the file named after --export's output argument.
  const fakePi = join(mkdtempSync(join(tmpdir(), "magi-pi-")), "pi");
  writeFileSync(fakePi, '#!/bin/sh\nprintf "<html>exported</html>" > "$3"\n');
  chmodSync(fakePi, 0o755);

  const file = writeHtmlReport(s, codeReview, { sessions: true, pi: fakePi });
  assert.equal(file, join(s.runDir, "report", "index.html"));
  const html = readFileSync(file, "utf8");

  assert.doesNotMatch(html, /<script>alert/, "titles are escaped");
  assert.match(html, /&lt;script&gt;alert\(1\)/);
  assert.match(html, /x &amp; y/);
  assert.match(html, /Fix &lt;nil&gt; &amp; friends/, "commit subjects come from git");
  assert.match(html, /class="bar review"/, "each agent call is a bar in the timeline");
  assert.match(html, /<a href="sessions\/r1__review__1__2026-01-01T00-00-00-000Z_x\.html">transcript<\/a>/);
  assert.equal(
    readFileSync(join(s.runDir, "report", "sessions", "r1__review__1__2026-01-01T00-00-00-000Z_x.html"), "utf8"),
    "<html>exported</html>",
  );
  assert.match(html, /id="R1"/);
});

test("html report draws a call still running up to now, marked as live", () => {
  const repo = scratchRepo();
  const run = newRun(codeReview, defaults(repo), repo, new FakeDriver(() => {}));
  run.state.agents.push({
    key: "r1/fix/R1/1", model: "m/fixer", driver: "fake", startedAt: new Date(Date.now() - 120_000).toISOString(),
    cost: 0, turns: 1,
  });
  const html = readFileSync(writeHtmlReport(run.state, codeReview, { sessions: false, pi: "/nonexistent" }), "utf8");
  assert.match(html, /class="bar fix live"/);
  assert.match(html, /2\.0 min so far|1\.9 min so far|2 min so far/);
  assert.match(html, /calls still running are drawn up to this time/);
});

test("html report without transcripts links nothing to sessions", () => {
  const repo = scratchRepo();
  const run = newRun(codeReview, defaults(repo), repo, new FakeDriver(() => {}));
  const file = writeHtmlReport(run.state, codeReview, { sessions: false, pi: "/nonexistent" });
  assert.doesNotMatch(readFileSync(file, "utf8"), /transcript/);
});
