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
  assert.match(html, /class="bar-run review"/, "each agent call is a bar in the timeline");
  assert.match(html, /<a href="sessions\/r1__review__1__2026-01-01T00-00-00-000Z_x\.html" target="_blank" rel="noopener">transcript<\/a>/, "transcripts open in their own window");
  assert.equal(
    readFileSync(join(s.runDir, "report", "sessions", "r1__review__1__2026-01-01T00-00-00-000Z_x.html"), "utf8"),
    "<html>exported</html>",
  );
  assert.match(html, /id="R1"/);
  assert.match(html, /data-key="status" data-value="fixed"/, "status pills filter the findings");
  assert.match(html, /<div class="figs">/, "figures are shown in rows");

  const commitPage = readFileSync(join(s.runDir, "report", "commits", `${sha.slice(0, 9)}.html`), "utf8");
  assert.match(commitPage, /<span class="add">\+/, "added lines are coloured");
  assert.match(html, new RegExp(`href="commits/${sha.slice(0, 9)}\\.html" target="_blank"`), "commits open in their own window");
});

test("html report draws a call still running up to now, marked as live", () => {
  const repo = scratchRepo();
  const run = newRun(codeReview, defaults(repo), repo, new FakeDriver(() => {}));
  run.state.agents.push({
    key: "r1/fix/R1/1", model: "m/fixer", driver: "fake", startedAt: new Date(Date.now() - 120_000).toISOString(),
    cost: 0, turns: 1,
  });
  const html = readFileSync(writeHtmlReport(run.state, codeReview, { sessions: false, pi: "/nonexistent" }), "utf8");
  assert.match(html, /class="bar-run fix live"/);
  assert.match(html, /2\.0 min so far|1\.9 min so far|2 min so far/);
  assert.match(html, /Calls still running are drawn up to the time this page was generated/);
});

test("html report without transcripts links nothing to sessions", () => {
  const repo = scratchRepo();
  const run = newRun(codeReview, defaults(repo), repo, new FakeDriver(() => {}));
  const file = writeHtmlReport(run.state, codeReview, { sessions: false, pi: "/nonexistent" });
  assert.doesNotMatch(readFileSync(file, "utf8"), /href="sessions\//, "no link to a transcript");
});

test("html report: decision sites read like finding sites; calls without a commit show a dash", () => {
  const repo = scratchRepo();
  const run = newRun(codeReview, defaults(repo), repo, new FakeDriver(() => {}));
  const s = run.state;
  s.questions.push({
    id: "R2", title: "Merge handlers", detail: "Sites:\na.go:3 (note here)\nb.go\n\nImpact: x", question: "Merge?",
    options: [{ label: "A", consequences: "c" }, { label: "B", consequences: "d" }], recommendation: "A", sessions: [],
    askedAt: "2026-01-01T00:00:00.000Z",
  });
  s.agents.push({
    key: "r1/fix/R2/1", model: "m/fixer", driver: "fake", startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:01:00.000Z", cost: 0, turns: 1,
  });
  const html = readFileSync(writeHtmlReport(s, codeReview, { sessions: false, pi: "/nonexistent" }), "utf8");
  assert.match(html, /<ul class="sites"><li><code>a\.go:3<\/code> — note here<\/li><li><code>b\.go<\/code><\/li><\/ul>/);
  assert.match(html, /<span class="c">-<\/span>/, "a call without a commit shows a dash in the commit column");
});

test("html report: a section's side column links to its head", () => {
  const repo = scratchRepo();
  const run = newRun(codeReview, defaults(repo), repo, new FakeDriver(() => {}));
  const html = readFileSync(writeHtmlReport(run.state, codeReview, { sessions: false, pi: "/nonexistent" }), "utf8");
  assert.match(html, /<a class="sec-side" href="#mechanics"><span class="sec-no"/);
});

test("html report: the summary lists important findings and those waiting for a decision under their own titles", () => {
  const repo = scratchRepo();
  const run = newRun(codeReview, defaults(repo), repo, new FakeDriver(() => {}));
  const s = run.state;
  const base = { round: 1, foundBy: "m/one", severity: "critical" as const, sites: [], details: {}, runs: 0, attempts: [] };
  s.data.findings.push(
    { ...base, id: "R1", kind: "issue", title: "Crash on user's nil", status: "open" },
    { ...base, id: "R2", kind: "issue", title: "Merge handlers", status: "deferred", severity: "important",
      deferral: { question: "Merge?", options: [], recommendation: "" } },
  );
  const html = readFileSync(writeHtmlReport(s, codeReview, { sessions: false, pi: "/nonexistent" }), "utf8");
  assert.match(html, /<h3 class="list-title">Important findings<\/h3>/);
  assert.match(html, /<h3 class="list-title">Waiting for decision<\/h3>/);
  assert.match(html, /<a href="#R2">R2: Merge handlers<\/a>/);
  assert.match(html, /Crash on user&#39;s nil/, "entities are not taken for figures");
});

test("html report: the summary's first figures run fixed, rejected, decisions, commits, files read, audit", () => {
  const repo = scratchRepo();
  const run = newRun(codeReview, defaults(repo), repo, new FakeDriver(() => {}));
  const html = readFileSync(writeHtmlReport(run.state, codeReview, { sessions: false, pi: "/nonexistent" }), "utf8");
  assert.match(html, /Findings fixed[\s\S]*Rejected or duplicate[\s\S]*Decisions open[\s\S]*Commits[\s\S]*Files read[\s\S]*Final audit/);
});
