// A static HTML page for one run, for a person to read: the timeline, agent calls, questions, commits, and the
// workflow's own sections. Each agent session is also exported to HTML by pi, so the page links to transcripts.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { git } from "./git.ts";
import type { RunState, SessionLink, Workflow } from "./types.ts";

const ENTITY: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (v: unknown): string => String(v ?? "").replace(/[&<>"']/g, (c) => ENTITY[c]);

export interface HtmlOptions {
  /** Export every agent session to HTML with pi, and link to it. */
  sessions: boolean;
  /** The pi executable. */
  pi: string;
}

/** Write <run>/report/index.html, with the session transcripts beside it. Returns the page's path. */
export function writeHtmlReport<D, C>(s: RunState<D, C>, workflow: Workflow<D, C>, o: HtmlOptions): string {
  const dir = join(s.runDir, "report");
  mkdirSync(join(dir, "sessions"), { recursive: true });
  const links = o.sessions ? exportSessions(s.runDir, dir, o.pi) : new Map<string, string>();
  const file = join(dir, "index.html");
  writeFileSync(file, renderPage(s, workflow, (session) => links.get(session)));
  return file;
}

function jsonlUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...jsonlUnder(p));
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

/** Session file (absolute path) to the page's relative link. A session that fails to export has no link. */
function exportSessions(runDir: string, dir: string, pi: string): Map<string, string> {
  const out = new Map<string, string>();
  const root = join(runDir, "sessions");
  try {
    for (const file of jsonlUnder(root)) {
      const name = relative(root, file).replace(/\.jsonl$/, "").replaceAll("/", "__") + ".html";
      try {
        execFileSync(pi, ["--export", file, join(dir, "sessions", name)], { stdio: "ignore", timeout: 120_000 });
        out.set(file, `sessions/${name}`);
      } catch {
        // Keep the page without this transcript.
      }
    }
  } catch {
    // No sessions were recorded yet.
  }
  return out;
}

const ROLES: [RegExp, string][] = [[/^audit/, "audit"], [/^organize/, "organize"], [/\/fix\//, "fix"], [/\/patterns$/, "patterns"], [/\/review\//, "review"]];
const roleOf = (key: string): string => ROLES.find(([re]) => re.test(key))?.[1] ?? "other";

export const badge = (cls: string, text: string): string => `<span class="badge ${esc(cls)}">${esc(text)}</span>`;

/** A duration: seconds below a minute, minutes above. */
export function minutes(ms: number): string {
  return ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : `${Math.round(ms / 1000)} s`;
}

function commitsOf<D, C>(s: RunState<D, C>): { sha: string; subject: string; stat: string; patch: string }[] {
  let log: string;
  try {
    log = git(s.target.repo, ["log", "--reverse", "--format=%H%x1f%s", `${s.target.base}..${s.target.branch}`]).trim();
  } catch {
    return [];
  }
  if (!log) return [];
  return log.split("\n").map((line) => {
    const [sha, subject] = line.split("\x1f");
    const patch = git(s.target.repo, ["show", "--format=", sha]);
    return {
      sha, subject,
      stat: git(s.target.repo, ["show", "--stat", "--format=", sha]).trim(),
      patch: patch.length > 300_000 ? `${patch.slice(0, 300_000)}\n… diff truncated; see git show ${sha}` : patch,
    };
  });
}

function renderPage<D, C>(s: RunState<D, C>, workflow: Workflow<D, C>, link: SessionLink): string {
  const t = s.target;
  const agents = [...s.agents].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  // A call still running is drawn up to the moment the page is generated.
  const now = Date.now();
  const endOf = (a: (typeof agents)[number]): number => (a.finishedAt ? Date.parse(a.finishedAt) : now);
  const t0 = Math.min(Date.parse(s.createdAt), ...agents.map((a) => Date.parse(a.startedAt)));
  const t1 = Math.max(t0 + 1, ...agents.map(endOf));
  const pos = (ms: number): number => ((ms - t0) / (t1 - t0)) * 100;
  const total = agents.reduce((n, a) => n + a.cost, 0);
  const spanOf = (a: (typeof agents)[number]): string =>
    (a.finishedAt ? minutes(endOf(a) - Date.parse(a.startedAt)) : `${minutes(now - Date.parse(a.startedAt))} so far`);

  const timeline = agents.map((a) => {
    const left = pos(Date.parse(a.startedAt));
    const width = Math.max(0.4, pos(endOf(a)) - left);
    const classes = `${roleOf(a.key)}${a.error ? " failed" : ""}${a.finishedAt ? "" : " live"}`;
    return `<div class="row"><div class="label">${esc(a.key)}</div><div class="track"><div class="bar ${classes}" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%" title="${esc(a.model)}"></div></div><div class="dur">${esc(spanOf(a))}</div></div>`;
  }).join("\n");

  const callRows = agents.map((a) => {
    const sessionLink = a.session && link(a.session);
    return `<tr><td>${esc(a.key)}</td><td>${esc(a.model)}</td><td>${a.turns}</td><td>${esc(spanOf(a))}</td><td>$${a.cost.toFixed(2)}</td><td>${a.error ? `${badge("failed", "failed")} ${esc(a.error)}` : badge("ok", "ok")}</td><td>${sessionLink ? `<a href="${esc(sessionLink)}">transcript</a>` : "-"}</td></tr>`;
  }).join("\n");

  const questions = s.questions.map((q) => {
    const state = q.answer ? (q.answer.skip ? "skipped" : "answered") : "open";
    const sessions = q.sessions.map((x) => link(x)).filter((x): x is string => !!x).map((x) => `<a href="${esc(x)}">transcript</a>`).join(" ");
    return `<article class="question" id="${esc(q.id)}"><h3>${esc(q.id)}: ${esc(q.title)} ${badge(state, state)}</h3>
<pre class="detail">${esc(q.detail)}</pre>
<p><b>Decision needed:</b> ${esc(q.question)}</p>
<ol>${q.options.map((o) => `<li>${esc(o.label)}: ${esc(o.consequences)}</li>`).join("")}</ol>
<p><b>Recommendation:</b> ${esc(q.recommendation)}</p>
${q.answer ? `<p><b>Answer:</b> ${esc(q.answer.text)}</p>` : `<p class="cmd"><code>magi decide ${esc(s.runDir)} ${esc(q.id)} "&lt;option or instruction&gt;"</code></p>`}
${sessions ? `<p>${sessions}</p>` : ""}</article>`;
  }).join("\n") || "<p>None.</p>";

  const commits = commitsOf(s).map((c) => `<details><summary><code>${esc(c.sha.slice(0, 9))}</code> ${esc(c.subject)}</summary>
<pre class="stat">${esc(c.stat)}</pre><pre class="patch">${esc(c.patch)}</pre></details>`).join("\n") || "<p>No commits on the run branch yet.</p>";

  const workflowHtml = workflow.html?.(s, link) ?? "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(`magi ${s.workflow} ${s.id}`)}</title><style>${CSS}</style></head><body>
<header>
<h1>magi ${esc(s.workflow)} <small>${esc(s.id)}</small></h1>
<p>${badge(s.status, s.status)} <span class="hint">Generated ${new Date(now).toISOString()}${agents.some((a) => !a.finishedAt) ? "; calls still running are drawn up to this time" : ""}.</span></p>
<dl class="meta">
<dt>Target</dt><dd><code>${esc(t.repo)}/${esc(t.sub)}</code></dd>
<dt>Branch</dt><dd><code>${esc(t.branch)}</code>, from ${esc(t.base.slice(0, 12))}</dd>
<dt>Driver</dt><dd>${esc(s.driver)}</dd>
<dt>Wall clock</dt><dd>${esc(minutes(t1 - t0))}</dd>
<dt>Agent cost</dt><dd>$${total.toFixed(2)}</dd>
</dl>
<nav><a href="#timeline">Timeline</a> <a href="#findings">Findings</a> <a href="#questions">Questions</a> <a href="#commits">Commits</a> <a href="#agents">Agent calls</a></nav>
</header>
<main>
<section id="timeline"><h2>Timeline</h2><p class="hint">Each bar is one agent call, from its start to its finish, on the run's clock.</p>${timeline || "<p>No agent calls yet.</p>"}</section>
${workflowHtml}
<section id="questions"><h2>Questions</h2>${questions}</section>
<section id="commits"><h2>Commits</h2>${commits}</section>
<section id="agents"><h2>Agent calls</h2>
<table><thead><tr><th>Step</th><th>Model</th><th>Turns</th><th>Duration</th><th>Cost</th><th>Result</th><th>Session</th></tr></thead>
<tbody>${callRows}</tbody></table></section>
</main></body></html>
`;
}

const CSS = `
body{font:14px/1.5 system-ui,sans-serif;margin:0;color:#1d1f21;background:#fafafa}
header,main{max-width:1100px;margin:0 auto;padding:0 24px}
header{padding-top:24px}
h1{font-size:22px;margin:0 0 8px} h1 small{color:#666;font-weight:normal;font-size:14px}
h2{font-size:18px;border-bottom:1px solid #ddd;padding-bottom:4px;margin-top:32px}
h3{font-size:15px;margin:16px 0 6px} h3 small{color:#666;font-weight:normal}
nav{margin:12px 0 0} nav a{margin-right:14px;color:#1a5fb4}
.meta{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:12px 0}
.meta dt{color:#666} .meta dd{margin:0}
code,pre{font-family:ui-monospace,monospace;font-size:12.5px}
pre{background:#f0f0f0;padding:8px;overflow:auto;white-space:pre-wrap;word-break:break-word}
pre.patch{max-height:420px} .hint{color:#666}
.badge{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px;background:#ddd;color:#222;vertical-align:middle}
.converged,.fixed,.answered,.ok,.pass{background:#cdeccd} .exhausted,.deferred,.important,.unaudited{background:#fbe3b3}
.failed,.critical,.rejected{background:#f5c2c0} .rejected{background:#e4e4e4} .duplicate,.skipped{background:#e4e4e4}
.running,.open,.incomplete{background:#d6e6fb}
.row{display:grid;grid-template-columns:260px 1fr 90px;gap:8px;align-items:center;margin:3px 0}
.label{font-family:ui-monospace,monospace;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.track{position:relative;height:14px;background:#eee;border-radius:3px}
.bar{position:absolute;top:0;bottom:0;border-radius:3px;background:#8aa4c8;min-width:3px}
.bar.review{background:#4d8fcc} .bar.patterns{background:#9b72cf} .bar.fix{background:#5aa35a}
.bar.audit{background:#d98c2b} .bar.organize{background:#888} .bar.failed{background:#d64541}
.bar.live{opacity:.65;background-image:repeating-linear-gradient(45deg,transparent 0 4px,rgba(255,255,255,.5) 4px 8px)}
.dur{color:#555;font-size:12px;text-align:right}
table{border-collapse:collapse;width:100%;font-size:13px} th,td{text-align:left;padding:4px 8px;border-bottom:1px solid #e3e3e3;vertical-align:top}
th{color:#555;font-weight:600}
article.question,article.finding{background:#fff;border:1px solid #e3e3e3;border-radius:6px;padding:8px 14px;margin:12px 0}
details{background:#fff;border:1px solid #e3e3e3;border-radius:6px;padding:6px 12px;margin:8px 0} summary{cursor:pointer}
ul.sites{margin:4px 0 8px;padding-left:18px} dl.details{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px}
dl.details dt{color:#555;font-weight:600} dl.details dd{margin:0}
.cmd{color:#444}
`;
