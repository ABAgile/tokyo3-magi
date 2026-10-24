// A static report for one run, for a person to read. The page opens with an executive summary, then the workflow's
// sections (rounds and findings, filterable), the decisions, the commits, and the mechanics: timing and cost of the
// agent calls. Transcripts and commits open in their own windows. Each commit also has its own page with a coloured diff.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { git } from "./git.ts";
import { CSS } from "./html-style.ts";
import { NARRATIVE_KEY } from "./narrative.ts";
import { toPoints } from "./points.ts";
import type { AgentRecord, Narrative, Question, RunState, RunSummary, SessionLink, SummaryMetric, SummaryPoint, Workflow } from "./types.ts";

/** Applies the saved light or dark choice before the page paints; without one, the system setting applies. */
const THEME_EARLY = `<script>(function(){try{var t=localStorage.getItem('magi-theme');if(t==='light'||t==='dark'){document.documentElement.dataset.theme=t;}}catch(e){}})();</script>`;

/** The switch in the top bar. Its label names the mode it switches to; the choice is kept in this browser. */
const THEME_BUTTON = `<button type="button" class="theme-btn" data-theme-toggle>Dark</button>`;

const THEME_TOGGLE = `<script>
(function () {
  var root = document.documentElement;
  function isDark() {
    return (root.dataset.theme || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark';
  }
  function paint() {
    document.querySelectorAll('[data-theme-toggle]').forEach(function (b) {
      b.textContent = isDark() ? 'Light' : 'Dark';
      b.setAttribute('aria-label', isDark() ? 'Switch to light mode' : 'Switch to dark mode');
    });
  }
  document.querySelectorAll('[data-theme-toggle]').forEach(function (b) {
    b.addEventListener('click', function () {
      var next = isDark() ? 'light' : 'dark';
      root.dataset.theme = next;
      try { localStorage.setItem('magi-theme', next); } catch (e) {}
      paint();
    });
  });
  paint();
})();
</script>`;

const ENTITY: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (v: unknown): string => String(v ?? "").replace(/[&<>"']/g, (c) => ENTITY[c]);

/** Escaped text in which `code spans` are shown as code. */
export const inline = (v: unknown): string => esc(v).replace(/`([^`\n]+)`/g, "<code>$1</code>");

/** Numbers in running text are highlighted; numbers inside words or versions are left alone. */
const FIGURE = /(?<![\w.-])\d+(?:\s*\/\s*\d+)*(?![\w-])/g;
export const figures = (html: string): string =>
  html.split(/(<[^>]+>|&#?\w+;)/).map((part) => (part.startsWith("<") || part.startsWith("&") ? part : part.replace(FIGURE, (m) => `<span class="fig">${m}</span>`))).join("");

export interface HtmlOptions {
  /** Export every agent session to HTML with pi, and link to it. */
  sessions: boolean;
  /** The pi executable. */
  pi: string;
  /** The agent-written summary, when there is one. */
  narrative?: Narrative;
}

/** The page of a commit, relative to the report page. */
export const commitHref = (sha: string): string => `commits/${sha.slice(0, 9)}.html`;

/** A link that opens in its own window. */
export const newWindow = (href: string, inner: string): string => `<a href="${esc(href)}" target="_blank" rel="noopener">${inner}</a>`;

/** A transcript link, which opens in its own window. */
export const transcriptLink = (href: string, text = "transcript"): string => newWindow(href, esc(text));

/** A status tag. The tone is chosen from the status; unknown statuses stay quiet. */
const TONE: Record<string, string> = {
  converged: "good", fixed: "good", answered: "good", ok: "good", pass: "good",
  critical: "bad", failed: "bad",
  deferred: "warn", exhausted: "warn", unaudited: "warn", findings: "warn", incomplete: "warn", important: "warn",
  open: "info", running: "info",
};
export const toneOf = (status: string): string => TONE[status] ?? "quiet";
export const badge = (status: string, text: string = status): string => `<span class="pill tone-${toneOf(status)}">${esc(text)}</span>`;
export const pill = (text: string, tone = "quiet", extra = ""): string => `<span class="pill tone-${tone}"${extra}>${inline(text)}</span>`;

/** A transcript link styled as a pill; it opens in its own window. */
export const transcriptPill = (href: string, label = "transcript"): string => newWindow(href, pill(label, "info"));

/** A filter button: clicking it filters the items that carry the same key and value. */
export const filterPill = (key: string, value: string, text: string, tone = "quiet"): string =>
  `<button type="button" class="pill tone-${tone}" data-key="${esc(key)}" data-value="${esc(value)}" aria-pressed="false">${inline(text)}</button>`;

/** A duration: seconds below a minute, minutes above. */
export function minutes(ms: number): string {
  if (ms >= 3_600_000) {
    const total = Math.round(ms / 60_000);
    return `${Math.floor(total / 60)} h ${total % 60} min`;
  }
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)} min`;
  return `${Math.round(ms / 1000)} s`;
}

/** A section of the page. The number is generated by CSS, so sections can be added or removed freely. */
export function section(id: string, kind: string, title: string, body: string, lead = ""): string {
  return `<section class="sec" id="${esc(id)}"><a class="sec-side" href="#${esc(id)}"><span class="sec-no" aria-hidden="true"></span><span class="sec-kind">${esc(kind)}</span></a>
<div class="sec-main"><h2>${esc(title)}</h2>${lead ? `<p class="lead">${esc(lead)}</p>` : ""}${body}</div></section>`;
}

/** A numbered list of points; a point with an href links to what it is about. */
function reasons(points: SummaryPoint[]): string {
  return `<ol class="reasons">${points.map((p) => `<li><span class="pt-text">${p.html ?? (p.href ? `<a href="${esc(p.href)}">${figures(inline(p.text))}</a>` : figures(inline(p.text)))}</span></li>`).join("")}</ol>`;
}

/** Long text as a list of short points. */
export function pointList(text: string): string {
  const points = toPoints(text);
  return points.length ? `<ul class="pts">${points.map((p) => `<li>${inline(p)}</li>`).join("")}</ul>` : "";
}

/** Rows of figures. Each row is a group of related figures; a figure shows its label above its value. */
export function figs(rows: SummaryMetric[][]): string {
  return rows.map((row) => `<div class="figs">${row.map((m) => `<div class="fig-cell ${m.tone ?? ""}"><span class="l">${esc(m.label)}</span><span class="v">${esc(m.value)}</span>${m.note ? `<span class="n">${esc(m.note)}</span>` : ""}</div>`).join("")}</div>`).join("\n");
}

/** Sites as the findings list them: the location as code, then its note. A site is written "path:line (note)". */
function sitesList(lines: string[]): string {
  return `<ul class="sites">${lines.map((l) => {
    const [, where, note] = l.match(/^(.*?)(?: \((.*)\))?$/)!;
    return `<li><code>${esc(where)}</code>${note ? ` — ${inline(note)}` : ""}</li>`;
  }).join("")}</ul>`;
}

/** Text blocks of a question's detail. A line "Label: text" starts a labelled block; further lines become points. */
export function detailBlocks(text: string): string {
  return text.split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean).map((block) => {
    const [first, ...rest] = block.split("\n");
    const m = first.match(/^([A-Za-z][A-Za-z ]{1,30}):\s*(.*)$/);
    const label = m ? m[1] : "";
    const lines = [m ? m[2] : first, ...rest].map((l) => l.replace(/^\s*[-*]\s+/, "").trim()).filter(Boolean);
    const body = label === "Sites" ? sitesList(lines)
      : lines.length > 1 ? `<ul class="pts">${lines.map((l) => `<li>${inline(l)}</li>`).join("")}</ul>` : pointList(lines.join(" "));
    return `<div class="block">${label ? `<h4>${esc(label)}</h4>` : ""}${body}</div>`;
  }).join("");
}

/** Diff text with the lines coloured: additions, removals, hunks, and file headers. */
export function diffHtml(patch: string): string {
  return patch.split("\n").map((line) => {
    const cls = /^(\+\+\+|---|diff |index )/.test(line) ? "meta-line"
      : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : line.startsWith("@@") ? "hunk" : "";
    return `<span class="ln ${cls}">${esc(line)}</span>`;
  }).join("\n");
}

/** `git show --stat` lines with the +/- bars coloured. */
function statHtml(stat: string): string {
  return stat.split("\n").map((line) => {
    const i = line.indexOf("|");
    if (i < 0) return esc(line);
    return esc(line.slice(0, i + 1)) + esc(line.slice(i + 1)).replace(/\+/g, '<span class="add">+</span>').replace(/-/g, '<span class="del">-</span>');
  }).join("\n");
}

export interface CommitInfo { sha: string; subject: string; author: string; date: string; body: string; stat: string; patch: string; files: number; add: number; del: number }

/** The commits of a branch since the run's base, oldest first. */
function commitsOf<D, C>(s: RunState<D, C>, branch: string): CommitInfo[] {
  let log: string;
  try {
    log = git(s.target.repo, ["log", "--reverse", "--format=%H%x1f%s", `${s.target.base}..${branch}`]).trim();
  } catch {
    return [];
  }
  if (!log) return [];
  return log.split("\n").map((line) => {
    const [sha, subject] = line.split("\x1f");
    const show = (args: string[]) => git(s.target.repo, ["show", "--format=", ...args, sha]);
    let add = 0, del = 0, files = 0;
    for (const row of show(["--numstat"]).split("\n").filter(Boolean)) {
      const [a, d] = row.split("\t");
      files++;
      add += Number(a) || 0;
      del += Number(d) || 0;
    }
    const patch = show([]);
    const [author, date] = git(s.target.repo, ["show", "-s", "--format=%an <%ae>%x1f%ad", "--date=format:%a %b %e %H:%M:%S %Y %z", sha]).trim().split("\x1f");
    const message = git(s.target.repo, ["show", "-s", "--format=%B", sha]).replace(/\s+$/, "").split("\n").slice(1).join("\n").replace(/^\n+/, "");
    return {
      sha, subject, author, date,
      body: message,
      stat: show(["--stat"]).trim(),
      patch: patch.length > 300_000 ? `${patch.slice(0, 300_000)}\n… diff truncated; see git show ${sha}` : patch,
      files, add, del,
    };
  });
}

/** One line of a diff, coloured the way git and tig colour it. */
function diffLine(l: string): string {
  const cls = l.startsWith("diff --git") ? "fhdr"
    : /^(index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(l) ? "hdr"
    : l.startsWith("@@") ? "hunk" : l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : "";
  return cls ? `<span class="${cls}">${esc(l)}</span>` : esc(l);
}

/** One line of `git show --stat`, with the +/- bars coloured. */
function statLine(l: string): string {
  const i = l.indexOf("|");
  if (i < 0) return esc(l);
  return esc(l.slice(0, i + 1)) + esc(l.slice(i + 1)).replace(/\+/g, '<span class="add">+</span>').replace(/-/g, '<span class="del">-</span>');
}

/** The commit as `git show` prints it: header, message, stat, and the coloured diff, in one block. */
function gitShow(c: CommitInfo): string {
  const out: string[] = [
    `<span class="sha">commit ${esc(c.sha)}</span>`,
    `<span class="author">Author: ${esc(c.author)}</span>`,
    `<span class="date">Date:   ${esc(c.date)}</span>`,
    "",
    `    <span class="subject">${esc(c.subject)}</span>`,
  ];
  if (c.body) out.push("", ...c.body.split("\n").map((l) => `    ${esc(l)}`));
  out.push("", ...c.stat.split("\n").map(statLine), "", ...c.patch.split("\n").map(diffLine));
  return out.join("\n");
}

function renderCommitPage(c: CommitInfo): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(`commit ${c.sha.slice(0, 9)}: ${c.subject}`)}</title>${THEME_EARLY}<style>${CSS}</style></head><body>
<header class="bar"><div class="bar-in"><span class="mark"><i></i>magi</span><nav aria-label="Pages"><ol><li><a href="../index.html#commits">Back to the report</a></li></ol></nav>${THEME_BUTTON}</div></header>
<div class="page">
<header class="mast">
<p class="kicker">commit <b>${esc(c.sha.slice(0, 9))}</b></p>
<h1 class="subject">${inline(c.subject)}</h1>
<div class="figs">
<div class="fig-cell"><span class="l">Files changed</span><span class="v">${c.files}</span></div>
<div class="fig-cell good"><span class="l">Lines added</span><span class="v">+${c.add}</span></div>
<div class="fig-cell bad"><span class="l">Lines removed</span><span class="v">−${c.del}</span></div>
</div>
</header>
<section class="sec"><div class="sec-side"><span class="sec-kind">Commit</span></div><div class="sec-main"><pre class="git">${gitShow(c)}</pre></div></section>
</div>
${THEME_TOGGLE}
</body></html>
`;
}

/** The agent's summary: where the project stands, and the fixes grouped by kind of defect. */
function narrativeBlock(n: Narrative | undefined): string {
  if (!n) return "";
  const state = n.state.length
    ? `<div class="pt-group"><h3 class="list-title">Where the project stands</h3>${reasons(n.state.map((text) => ({ text })))}</div>`
    : "";
  const groups = n.categories.length
    ? `<div class="pt-group"><h3 class="list-title">Fixing categories</h3>${n.categories.map((c) => `<div class="block"><h4>${inline(c.title)}</h4><p>${inline(c.summary)}</p><p>${c.ids.map((id) => `<a href="#${esc(id)}">${esc(id)}</a>`).join(", ")}</p></div>`).join("")}</div>`
    : "";
  return `${state}${groups}<p class="hint">Written by ${esc(n.model)} on ${esc(n.at.slice(0, 10))} from the run's facts; the figures and lists above are from the run data.</p>`;
}

/** Write <run>/report/index.html, with transcripts and commit pages beside it. Returns the page's path. */
export function writeHtmlReport<D, C>(s: RunState<D, C>, workflow: Workflow<D, C>, o: HtmlOptions): string {
  const dir = join(s.runDir, "report");
  mkdirSync(join(dir, "sessions"), { recursive: true });
  mkdirSync(join(dir, "commits"), { recursive: true });
  const links = o.sessions ? exportSessions(s.runDir, dir, o.pi) : new Map<string, string>();
  // The run branch holds the organized history; the per-finding history, kept on "<branch>-raw" when the history was
  // organized, is linked from the rounds and findings. Both get a page for every commit.
  const commits = commitsOf(s, s.target.branch);
  const raw = hasBranch(s, `${s.target.branch}-raw`) ? commitsOf(s, `${s.target.branch}-raw`) : [];
  for (const c of [...commits, ...raw]) writeFileSync(join(dir, commitHref(c.sha)), renderCommitPage(c));
  const file = join(dir, "index.html");
  writeFileSync(file, renderPage(s, workflow, (session) => links.get(session), commits, raw, o.narrative));
  return file;
}

function hasBranch<D, C>(s: RunState<D, C>, branch: string): boolean {
  try {
    git(s.target.repo, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
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

const ROLE_ORDER = ["review", "patterns", "fix", "audit", "organize", "other"];
export const roleOf = (key: string): string =>
  key.startsWith("audit") ? "audit" : key.startsWith("organize") ? "organize" : key.includes("/fix/") ? "fix"
    : key.endsWith("/patterns") ? "patterns" : key.includes("/review/") ? "review" : "other";

function questionCard(q: Question, runDir: string, link: SessionLink): string {
  const state = q.answer ? (q.answer.skip ? "skipped" : "answered") : "open";
  const accent = q.answer ? (q.answer.skip ? "quiet" : "good") : "warn";
  const kind = q.id.startsWith("P") ? "pattern" : q.id.startsWith("R") ? "defect" : q.id.startsWith("Q") ? "request" : "question";
  // The detail often opens with the item's own id and title, which the card already shows.
  const detail = q.detail.replace(new RegExp(`^${q.id}\\b[^\\n]*\\n+`), "");
  const hrefs = q.sessions.map((x) => link(x)).filter((x): x is string => !!x);
  const transcripts = hrefs.map((href, i) => transcriptPill(href, hrefs.length > 1 ? `transcript ${i + 1}` : "transcript"));
  const answer = q.answer
    ? `<div class="block"><h4>Answer</h4><p>${inline(q.answer.text)}</p></div>`
    : `<div class="block"><h4>Answer</h4><p>Not answered yet. Answer it with <code>magi decide ${esc(runDir)} ${esc(q.id)} "&lt;option or instruction&gt;"</code>, or answer every open question with <code>magi decide ${esc(runDir)}</code>.</p></div>`;
  return `<details class="item box accent-${accent}" id="${esc(q.id)}">
<summary><span class="item-pills"><span class="pill id">${esc(q.id)}</span> ${badge(state)} ${pill(kind)} ${transcripts.join(" ")}</span><h3>${inline(q.title)}</h3></summary>
<div class="f-body">
${detailBlocks(detail)}
<div class="block"><h4>Decision needed</h4><p>${inline(q.question)}</p>
<ol class="pts">${q.options.map((o) => `<li>${inline(o.label)}: ${inline(o.consequences)}</li>`).join("")}</ol>
<p><b>Recommendation:</b> ${inline(q.recommendation)}</p></div>
${answer}
</div>
</details>`;
}

/** The model without its provider and thinking level: "anthropic/claude-haiku-5-5:high" is "claude-haiku-5-5". */
export const modelType = (model: string): string => model.split("/").pop()!.replace(/:[a-z]+$/, "");

/** The figures and tables of the agent calls: by everything, by model type, and by role. */
function callsSection(agents: AgentRecord[]): string {
  const dur = (a: AgentRecord) => Date.parse(a.finishedAt!) - Date.parse(a.startedAt);
  const durations = agents.filter((a) => a.finishedAt).map(dur);
  const sum = durations.reduce((n, x) => n + x, 0);
  const cost = agents.reduce((n, a) => n + a.cost, 0);
  const failed = agents.filter((a) => a.error).length;
  const longest = durations.length ? Math.max(...durations) : undefined;

  const summarize = (rows: AgentRecord[]) => {
    const done = rows.filter((a) => a.finishedAt).map(dur);
    const total = done.reduce((n, x) => n + x, 0);
    const spent = rows.reduce((n, a) => n + a.cost, 0);
    return {
      calls: rows.length, failed: rows.filter((a) => a.error).length, total, spent,
      min: done.length ? Math.min(...done) : undefined, max: done.length ? Math.max(...done) : undefined,
      avg: done.length ? total / done.length : undefined,
    };
  };
  const cell = (ms: number | undefined) => (ms === undefined ? "-" : minutes(ms));
  const table = (head: string, groups: [string, AgentRecord[]][]): string => {
    const rowOf = (label: string, rows: AgentRecord[], total = false) => {
      const x = summarize(rows);
      return `<tr${total ? ' class="total"' : ""}><td>${esc(label)}</td><td>${x.calls}</td><td>${x.failed || "-"}</td><td>${x.total ? minutes(x.total) : "-"}</td>
<td>${cell(x.min)}</td><td>${cell(x.avg)}</td><td>${cell(x.max)}</td><td>$${x.spent.toFixed(2)}</td><td>${x.calls ? `$${(x.spent / x.calls).toFixed(3)}` : "-"}</td></tr>`;
    };
    return `<div class="scroll"><table class="t"><thead><tr><th>${esc(head)}</th><th>Calls</th><th>Failed</th><th>Total time</th><th>Min</th><th>Avg</th><th>Max</th><th>Cost</th><th>Cost per call</th></tr></thead><tbody>
${groups.map(([label, rows]) => rowOf(label, rows)).join("\n")}
${rowOf("All calls", agents, true)}
</tbody></table></div>`;
  };

  const tiles = figs([[
    { label: "Agent calls", value: `${agents.length}` },
    { label: "Failed calls", value: `${failed}`, tone: failed ? "bad" : "good" },
    { label: "Total call time", value: minutes(sum) },
    { label: "Longest call", value: cell(longest) },
    { label: "Average call", value: durations.length ? minutes(sum / durations.length) : "-" },
  ]]);
  const types = [...new Set(agents.map((a) => modelType(a.model)))];
  const perType = figs([[
    ...types.map((t) => {
      const rows = agents.filter((a) => modelType(a.model) === t);
      const x = summarize(rows);
      return {
        label: t, value: `$${x.spent.toFixed(2)}`,
        note: `${x.calls} call${x.calls === 1 ? "" : "s"} · ${minutes(x.total)}${x.failed ? ` · ${x.failed} failed` : ""}`,
        tone: x.failed ? ("bad" as const) : undefined,
      };
    }),
    { label: "Total", value: `$${cost.toFixed(2)}`, note: `${agents.length} call${agents.length === 1 ? "" : "s"} · ${minutes(sum)}` },
  ]]);
  const roles = ROLE_ORDER.map((r) => [r, agents.filter((a) => roleOf(a.key) === r)] as [string, AgentRecord[]]).filter(([, rows]) => rows.length);
  const byType = types.map((t) => [t, agents.filter((a) => modelType(a.model) === t)] as [string, AgentRecord[]]);
  return `${tiles}
${perType}
${table("Role", roles)}
${table("Model type", byType)}
<p class="hint">Calls run in parallel, so the total call time can be longer than the wall clock.</p>`;
}

function renderPage<D, C>(s: RunState<D, C>, workflow: Workflow<D, C>, link: SessionLink, commits: CommitInfo[], raw: CommitInfo[], narrative?: Narrative): string {
  const t = s.target;
  // The summary's own call is left out: the figures describe the run, not the writing of its report.
  const agents = s.agents.filter((a) => a.key !== NARRATIVE_KEY).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const now = Date.now();
  const endOf = (a: AgentRecord): number => (a.finishedAt ? Date.parse(a.finishedAt) : now);
  const t0 = Math.min(Date.parse(s.createdAt), ...agents.map((a) => Date.parse(a.startedAt)));
  const t1 = Math.max(t0 + 1, ...agents.map(endOf));
  const pos = (ms: number): number => ((ms - t0) / (t1 - t0)) * 100;
  const spanOf = (a: AgentRecord): string => (a.finishedAt ? minutes(endOf(a) - Date.parse(a.startedAt)) : `${minutes(now - Date.parse(a.startedAt))} so far`);
  const total = agents.reduce((n, a) => n + a.cost, 0);
  const failedCalls = agents.filter((a) => a.error).length;
  const openQuestions = s.questions.filter((q) => !q.answer);
  const running = agents.some((a) => !a.finishedAt);
  const commitOf = (a: AgentRecord): string | undefined => workflow.callCommit?.(s, a);

  // Summary: the workflow's figures first, then the run's own figures.
  const summary: RunSummary = workflow.executive?.(s) ?? { headline: `Run ${s.status}.`, metrics: [], points: [] };
  const rows: SummaryMetric[][] = summary.metrics.map((row) => [...row]);
  rows.push([
    { label: "Wall clock", value: minutes(t1 - t0) },
    { label: "Agent cost", value: `$${total.toFixed(2)}` },
    { label: "Agent calls", value: failedCalls ? `${agents.length}, ${failedCalls} failed` : `${agents.length}`, tone: failedCalls ? "bad" : undefined },
  ]);
  const needsYou = openQuestions.length
    ? `<div class="item"><h3>${openQuestions.length} decision${openQuestions.length === 1 ? "" : "s"} need${openQuestions.length === 1 ? "s" : ""} you</h3>
<p><a href="#questions">Review ${openQuestions.length === 1 ? "it" : "them"} below</a>, or answer from the terminal: <code>magi decide ${esc(s.runDir)}</code>.</p></div>`
    : "";
  const summarySection = section("summary", "Summary", "What happened", `
<div class="rulebox"><span class="k">Executive summary</span><b>${figures(inline(summary.headline))}</b></div>
${figs(rows)}
${summary.points.length ? reasons(summary.points) : ""}
${narrativeBlock(narrative)}
${(summary.lists ?? []).map((l) => `<div class="pt-group"><h3 class="list-title">${esc(l.title)}</h3>${reasons(l.points)}</div>`).join("")}
${needsYou}`);

  const workflowSections = workflow.html?.(s, link) ?? "";

  const questions = section("questions", "Decisions", `${s.questions.length} decision${s.questions.length === 1 ? "" : "s"}`,
    `<div class="items">${s.questions.map((q) => questionCard(q, s.runDir, link)).join("\n") || "<p>No decisions were needed.</p>"}</div>`,
    "Questions the loop could not settle alone, with their options and a recommendation. Answer them with the command shown.");

  const commitRows = commits.map((c) => `<div class="commit-row">
<span class="pill id">${esc(c.sha.slice(0, 9))}</span>
<span class="subject">${inline(c.subject)}</span>
<span class="stats">${c.files} file${c.files === 1 ? "" : "s"} <span class="add">+${c.add}</span> <span class="del">−${c.del}</span> ${newWindow(commitHref(c.sha), "diff")}</span>
</div>`).join("\n");
  const rawRows = raw.map((c) => `<div class="commit-row">
<span class="pill id">${esc(c.sha.slice(0, 9))}</span>
<span class="subject">${inline(c.subject)}</span>
<span class="stats">${c.files} file${c.files === 1 ? "" : "s"} <span class="add">+${c.add}</span> <span class="del">−${c.del}</span> ${newWindow(commitHref(c.sha), "diff")}</span>
</div>`).join("\n");
  const organized = raw.length ? `<details class="layer"><summary>Per-finding history before organizing (${raw.length} commit${raw.length === 1 ? "" : "s"})</summary>
<p class="hint">The commits as each finding made them. The organized history above is what the branch now holds.</p>
${rawRows}</details>` : "";
  const commitsSection = section("commits", "Commits", `${commits.length} commit${commits.length === 1 ? "" : "s"} on the run branch`,
    (commitRows || "<p>No commits on the run branch yet.</p>") + organized,
    "Each commit is one fix, in the order it was made. A diff opens in its own window, coloured.");

  const timeline = agents.map((a) => {
    const left = pos(Date.parse(a.startedAt));
    const width = Math.max(0.4, pos(endOf(a)) - left);
    const classes = `${roleOf(a.key)}${a.error ? " failed" : ""}${a.finishedAt ? "" : " live"}`;
    const sessionLink = a.session && link(a.session);
    const sha = commitOf(a);
    const name = sessionLink ? newWindow(sessionLink, esc(a.key)) : esc(a.key);
    return `<div class="row"><div class="label">${name}</div><div class="track"><div class="bar-run ${classes}" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%" title="${esc(a.model)}"></div></div><div class="dur"><span class="t">${esc(spanOf(a))}</span><span class="c">${sha ? newWindow(commitHref(sha), `<code>${esc(sha.slice(0, 9))}</code>`) : "-"}</span></div></div>`;
  }).join("\n");
  const callRows = agents.map((a) => {
    const sessionLink = a.session && link(a.session);
    const sha = commitOf(a);
    return `<tr><td class="code">${sessionLink ? newWindow(sessionLink, esc(a.key)) : esc(a.key)}</td><td class="code">${esc(a.model)}</td><td>${a.turns}</td><td>${esc(spanOf(a))}</td><td>$${a.cost.toFixed(2)}</td><td>${a.error ? `${badge("failed", "failed")} ${esc(a.error)}` : badge("ok")}</td><td>${sha ? newWindow(commitHref(sha), `<code>${esc(sha.slice(0, 9))}</code>`) : "-"}</td></tr>`;
  }).join("\n");
  const mechanics = section("mechanics", "Mechanics", "Agent calls and timing", `
${callsSection(agents)}
<details class="layer"><summary>Timeline of agent calls</summary>
${running ? '<p class="hint">Calls still running are drawn up to the time this page was generated.</p>' : ""}
${timeline || "<p>No agent calls yet.</p>"}</details>
<details class="layer"><summary>Every agent call (${agents.length})</summary><div class="scroll"><table class="t">
<thead><tr><th>Step</th><th>Model</th><th>Turns</th><th>Duration</th><th>Cost</th><th>Result</th><th>Commit</th></tr></thead>
<tbody>${callRows}</tbody></table></div></details>`, "How long the agent calls took, what they cost, and where each one's transcript and commit are.");

  const navItems: [string, string][] = [["summary", "Summary"], ["rounds", "Rounds"], ["findings", "Findings"], ["questions", "Decisions"], ["commits", "Commits"], ["mechanics", "Mechanics"]];
  const nav = navItems.map(([id, label]) => `<li><a href="#${id}">${label}</a></li>`).join("");
  const repoName = t.repo.split("/").filter(Boolean).pop() ?? t.repo;
  const title = `${s.workflow.replace(/-/g, " ")} · ${repoName}`;

  // Filtering: a button with data-key and data-value filters the .item cards of its own section; clicking the active
  // value again, or "all", clears that key. Links to another window open it with window.open, and fall back to this
  // window when the browser refuses. A link to an anchor first clears the section's filters, so the anchor is visible.
  const script = `<script>
(function () {
  var state = new Map();
  function apply(scope) {
    var f = state.get(scope) || {};
    var items = scope.querySelectorAll('[data-filterable] .item');
    var shown = 0;
    items.forEach(function (el) {
      var ok = Object.keys(f).every(function (k) { return !f[k] || el.dataset[k] === f[k]; });
      el.hidden = !ok;
      if (ok) shown++;
    });
    var count = scope.querySelector('[data-count]');
    if (count) count.textContent = shown + ' of ' + items.length + ' shown';
  }
  function resetScope(scope) {
    state.set(scope, {});
    scope.querySelectorAll('button[data-key]').forEach(function (x) {
      x.setAttribute('aria-pressed', String(x.dataset.value === 'all'));
    });
    apply(scope);
  }
  function reveal(id) {
    var el = id && document.getElementById(id);
    // A section is never filtered away, so jumping to its head keeps the filters the reader set.
    if (!el || el.tagName === 'SECTION') return;
    var scope = el.closest('section');
    if (scope && state.has(scope) && Object.keys(state.get(scope)).some(function (k) { return state.get(scope)[k]; })) {
      resetScope(scope);
    }
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-key]');
    if (b) {
      var scope = b.closest('section');
      if (!scope) return;
      var f = state.get(scope) || {};
      var k = b.dataset.key, v = b.dataset.value;
      f[k] = (v === 'all' || f[k] === v) ? null : v;
      state.set(scope, f);
      scope.querySelectorAll('button[data-key="' + k + '"]').forEach(function (x) {
        var on = x.dataset.value === 'all' ? !f[k] : f[k] === x.dataset.value;
        x.setAttribute('aria-pressed', String(on));
      });
      apply(scope);
      return;
    }
    var ext = e.target.closest('a[target="_blank"]');
    if (ext) {
      e.preventDefault();
      var w = window.open(ext.href, '_blank');
      if (w) { try { w.opener = null; } catch (err) {} } else { window.location.href = ext.href; }
      return;
    }
    var anchor = e.target.closest('a[href^="#"]');
    if (anchor) reveal(anchor.getAttribute('href').slice(1));
  });
  window.addEventListener('hashchange', function () { reveal(location.hash.slice(1)); });
  document.querySelectorAll('section').forEach(function (scope) {
    if (scope.querySelector('[data-filterable]')) apply(scope);
  });
  if (location.hash) reveal(location.hash.slice(1));
})();
</script>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(`magi ${s.workflow} ${s.id}`)}</title>${THEME_EARLY}<style>${CSS}</style></head><body>
<header class="bar"><div class="bar-in"><span class="mark"><i></i>magi</span><nav aria-label="Sections"><ol>${nav}</ol></nav>${THEME_BUTTON}</div></header>
<div class="page">
<header class="mast">
<p class="kicker">${esc(s.workflow)} ${badge(s.status)}</p>
<h1>${esc(repoName)}<span class="sq" aria-hidden="true"></span></h1>
<p class="stand">${esc(title)}. Run <code>${esc(s.id)}</code>.</p>
<dl class="meta">
<div><dt>Target</dt><dd><code>${esc(t.repo)}${t.sub ? `/${esc(t.sub)}` : ""}</code></dd></div>
<div><dt>Branch</dt><dd><code>${esc(t.branch)}</code>, from ${esc(t.base.slice(0, 12))}</dd></div>
<div><dt>Driver</dt><dd>${esc(s.driver)}</dd></div>
<div><dt>Generated</dt><dd>${esc(new Date(now).toISOString())}</dd></div>
</dl>
</header>
${summarySection}
${workflowSections}
${questions}
${commitsSection}
${mechanics}
</div>
${script}
${THEME_TOGGLE}
</body></html>
`;
}
