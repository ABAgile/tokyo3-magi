// The code-review part of the run page: the executive summary, the rounds, and the findings. Each layer links to the
// next: the summary to findings, rounds to their findings, commits and transcripts, findings to their attempts.
import { git } from "../../engine/git.ts";
import { badge, commitHref, esc, figures, filterPill, inline, newWindow, pill, pointList, section, toneOf, transcriptLink, transcriptPill } from "../../engine/html.ts";

/** The commit now holding the change a per-finding commit made: the same commit until the history is organized. */
const finalOf = (s: RunState<Data, Config>, sha: string): string => s.data.organized?.map?.[sha] ?? sha;

/** A commit as the report shows it: the commit on the branch, and the per-finding commit it came from, when different. */
function commitRef(s: RunState<Data, Config>, raw: string): string {
  const fin = finalOf(s, raw);
  const now = newWindow(commitHref(fin), `<code>${sha9(fin)}</code>`);
  return fin === raw ? now : `${now} <span class="hint">(from ${newWindow(commitHref(raw), `<code>${sha9(raw)}</code>`)})</span>`;
}

/** The accent colour of a box, from a status or verdict tone. */
const accent = (tone: string): string => `accent-${tone}`;
import type { AgentRecord, RunState, RunSummary, SessionLink, SummaryMetric, SummaryPoint } from "../../engine/types.ts";
import type { Config } from "./config.ts";
import { type Data, type Finding, openFindings } from "./data.ts";

const cap = (k: string): string => k.charAt(0).toUpperCase() + k.slice(1);
const sha9 = (sha: string): string => sha.slice(0, 9);

/** Files, added and removed lines of the run branch against its base; undefined when git cannot tell. */
function changeNumbers(s: RunState<Data, Config>): { files: number; add: number; del: number } | undefined {
  try {
    const stat = git(s.target.repo, ["diff", "--shortstat", s.target.base, s.target.branch]).trim();
    const m = stat.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
    if (!m) return undefined;
    return { files: Number(m[1]), add: Number(m[2] ?? 0), del: Number(m[3] ?? 0) };
  } catch {
    return undefined;
  }
}

/** The directories where most findings are, counted once per finding. */
function hotspots(findings: Finding[]): string {
  const count = new Map<string, number>();
  for (const f of findings) {
    const dirs = new Set(f.sites.map((x) => x.path.split("/").slice(0, 2).join("/")));
    for (const d of dirs) count.set(d, (count.get(d) ?? 0) + 1);
  }
  const top = [...count].sort((a, b) => b[1] - a[1]).slice(0, 3);
  return top.length ? top.map(([d, n]) => `${d} (${n})`).join(", ") : "";
}

/** The executive summary of a code-review run. */
export function executive(s: RunState<Data, Config>): RunSummary {
  const d = s.data;
  const count = (st: string) => d.findings.filter((f) => f.status === st).length;
  const total = d.findings.length;
  const fixed = count("fixed");
  const open = count("open");
  const deferred = count("deferred");
  const settled = count("rejected") + count("duplicate") + count("skipped");
  const reviewRounds = d.rounds.filter((r) => r.n <= s.config.maxRounds).length;
  const commits = d.rounds.reduce((n, r) => n + r.commits.length, 0);
  const lastAudit = d.audits.at(-1);
  const failedSteps = d.rounds.reduce((n, r) => n + r.failed.length, 0);
  const rounds = `${reviewRounds} review round${reviewRounds === 1 ? "" : "s"}`;

  const headline = (() => {
    switch (s.status) {
      case "converged":
        return lastAudit?.verdict === "pass"
          ? `Converged after ${rounds}: every finding is settled, and the final audit passed.`
          : `Converged after ${rounds}: every finding is settled.`;
      case "exhausted":
        return open + deferred === 0
          ? `Stopped at the round limit after ${rounds}; every finding it reported is settled.`
          : `Stopped at the round limit after ${rounds}, with ${open} open and ${deferred} waiting for a decision.`;
      case "unaudited":
        return `The reviews came back clean after ${rounds}, but the audit could not read every file, so the project is not declared clean.`;
      case "failed":
        return `The run stopped on an error after ${rounds}. Resume it once the cause is fixed.`;
      default:
        return `Still running: round ${d.round}, with ${total} finding${total === 1 ? "" : "s"} so far.`;
    }
  })();

  const change = changeNumbers(s);
  const decisions = s.questions.filter((q) => !q.answer).length;
  const outcome: SummaryMetric[] = [
    { label: "Findings fixed", value: `${fixed} / ${total}`, tone: total && fixed === total ? "good" : undefined },
    { label: "Rejected or duplicate", value: `${settled}` },
    { label: "Decisions open", value: `${decisions}`, tone: decisions ? "warn" : "good" },
    { label: "Commits", value: `${commits}` },
    { label: "Files read", value: `${d.coverage.visited.length}` },
    { label: "Final audit", value: lastAudit ? (lastAudit.verdict ?? "running") : "not run", tone: !lastAudit ? undefined : lastAudit.verdict === "pass" ? "good" : "warn" },
  ];

  // The change size is a point, coloured as the commits are: additions green, removals red.
  const points: SummaryPoint[] = [];
  if (change) {
    points.push({
      text: "",
      html: `The branch changes ${change.files} file${change.files === 1 ? "" : "s"}: <span class="add">+${change.add}</span> / <span class="del">−${change.del}</span> lines.`,
    });
  }
  const critical = d.findings.filter((f) => f.severity === "critical").length;
  const important = d.findings.filter((f) => f.severity === "important").length;
  const patterns = d.findings.filter((f) => f.kind === "pattern").length;
  if (total) points.push({ text: `${critical} critical and ${important} important defects; ${patterns} shared-abstraction pattern${patterns === 1 ? "" : "s"} proposed.` });
  const spots = hotspots(d.findings);
  if (spots) points.push({ text: `Most findings are in ${spots}.` });
  if (d.baseline && !d.baseline.ok) points.push({ text: "The project check failed before any change, so fixes were gated only once it passed." });
  if (failedSteps) points.push({ text: `${failedSteps} review step${failedSteps === 1 ? "" : "s"} failed with every model; those files were not reviewed in that round.` });
  if (lastAudit?.verdict === "incomplete") points.push({ text: `The audit could not read ${lastAudit.unread.length || "some"} file(s).` });
  const item = (f: Finding): SummaryPoint => ({ text: `${f.id}: ${f.title}`, href: `#${f.id}` });
  const lists = [
    { title: "Important findings", points: d.findings.filter((x) => x.severity === "critical" && x.kind === "issue").slice(0, 5).map(item) },
    { title: "Waiting for decision", points: d.findings.filter((x) => x.status === "deferred").map(item) },
  ].filter((l) => l.points.length);
  return { headline, metrics: [outcome], points, lists };
}

/** The commit a model call's changes became: the commit of the attempt that ran in the same session. */
export function callCommit(s: RunState<Data, Config>, call: AgentRecord): string | undefined {
  if (!call.session) return undefined;
  for (const f of s.data.findings) {
    for (const a of f.attempts) if (a.session === call.session && a.commit) return finalOf(s, a.commit);
  }
  return undefined;
}

/** The rounds: what each one reported, committed, and audited, each linked to where it is shown. */
function roundsSection(s: RunState<Data, Config>, link: SessionLink): string {
  const d = s.data;
  const byId = new Map(d.findings.map((f) => [f.id, f]));
  const titleOfCommit = (sha: string) => d.findings.find((f) => f.attempts.some((a) => a.commit === sha))?.title ?? sha9(sha);
  const transcripts = (prefix: string) =>
    s.agents.filter((a) => a.key.startsWith(prefix) && a.session && link(a.session))
      .map((a) => transcriptLink(link(a.session!)!, a.key));
  const rounds = d.rounds.map((r) => {
    const reported = r.reported.map((id) => byId.get(id)).filter((f): f is Finding => !!f)
      .map((f) => `<li><a href="#${esc(f.id)}">${esc(f.id)}</a> ${inline(f.title)}</li>`);
    const commits = r.commits.map((c) => `<li>${commitRef(s, c)} ${inline(titleOfCommit(c))}</li>`);
    const audits = d.audits.filter((a) => a.after === r.n).map((a) => `<li><a href="#audit-${a.id}">audit ${a.id}: ${esc(a.verdict ?? "running")}</a></li>`);
    const seen = transcripts(`r${r.n}/`);
    return `<details class="round box ${accent("quiet")}"><summary>Round ${r.n}${r.n > s.config.maxRounds ? " (fix only)" : ""}
<span class="hint">${r.reported.length} reported · ${r.commits.length} commit${r.commits.length === 1 ? "" : "s"}${r.failed.length ? ` · ${r.failed.length} failed` : ""}</span></summary>
<ul class="links">
<li><b>Reported</b>${reported.length ? `<ul class="items-sub">${reported.join("")}</ul>` : " — nothing"}</li>
<li><b>Commits</b>${commits.length ? `<ul class="items-sub">${commits.join("")}</ul>` : " — none"}</li>
${audits.length ? `<li><b>Audit</b><ul class="items-sub">${audits.join("")}</ul></li>` : ""}
${r.failed.length ? `<li><b>Failed steps</b>: ${esc(r.failed.join(", "))}</li>` : ""}
<li><b>Transcripts</b>: ${seen.join(" · ") || "none"}</li>
</ul></details>`;
  });
  const audits = d.audits.map((a) => {
    const found = a.reported.map((id) => `<li><a href="#${esc(id)}">${esc(id)}</a></li>`);
    const seen = transcripts(`audit${a.id}/`);
    return `<details class="round box ${accent(a.verdict === "pass" ? "good" : a.verdict ? "warn" : "info")}" id="audit-${a.id}"><summary>Audit ${a.id}, after round ${a.after}: ${badge(a.verdict ?? "running", a.verdict ?? "running")}</summary>
<ul class="links">
<li><b>Findings</b>${found.length ? `<ul class="items-sub">${found.join("")}</ul>` : " — none"}</li>
${a.unread.length ? `<li><b>Not read</b>: ${esc(a.unread.join(", "))}</li>` : ""}
${a.failed.length ? `<li><b>Failed slices</b>: ${esc(a.failed.join(", "))}</li>` : ""}
<li><b>Transcripts</b>: ${seen.join(" · ") || "none"}</li>
</ul></details>`;
  });
  const body = `${rounds.join("\n") || "<p>No rounds yet.</p>"}${audits.length ? `\n<h3>Audits</h3>\n${audits.join("\n")}` : ""}`;
  return section("rounds", "Rounds", "Rounds", body, "Each round fixes the open findings, then reviews. Expand a round to see what it reported and committed, and its transcripts.");
}

/** One finding as a card: pills for its metadata, and its details collapsed underneath. */
/** The agent call that reported a finding: its step, or for runs from before steps were recorded, the same round and model. */
function reporterCall(s: RunState<Data, Config>, f: Finding): AgentRecord | undefined {
  if (f.step) {
    const exact = s.agents.find((a) => a.key === f.step && a.model === f.foundBy);
    if (exact) return exact;
    const byStep = s.agents.find((a) => a.key === f.step);
    if (byStep) return byStep;
  }
  return s.agents.find((a) => a.model === f.foundBy && a.key.startsWith(`r${f.round}/`) && (a.key.includes("/review/") || a.key.endsWith("/patterns")));
}

function findingCard(s: RunState<Data, Config>, f: Finding, link: SessionLink): string {
  const kind = f.kind === "pattern" ? `pattern, ${f.change}` : f.kind === "request" ? "request" : "issue";
  const reporter = reporterCall(s, f);
  const reporterHref = reporter?.session && link(reporter.session);
  const pills = [
    `<span class="pill id">${esc(f.id)}</span>`,
    filterPill("status", f.status, f.status, toneOf(f.status)),
    filterPill("severity", f.severity, f.severity, f.severity === "critical" ? "bad" : "warn"),
    pill(kind),
    pill(`round ${f.round}`),
    pill(`${f.sites.length} site${f.sites.length === 1 ? "" : "s"}`),
    reporterHref ? transcriptPill(reporterHref) : "",
    f.fixedBy ? pill(`fixed with ${f.fixedBy}`) : "",
  ].filter(Boolean).join(" ");
  const sites = f.sites.map((x) => `<li><code>${esc(x.path)}${x.line ? `:${x.line}` : ""}</code>${x.note ? ` — ${inline(x.note)}` : ""}</li>`).join("");
  const details = Object.entries(f.details).map(([k, v]) => `<div class="block"><h4>${esc(cap(k))}</h4>${pointList(v)}</div>`).join("");
  const attempts = f.attempts.map((a) => {
    const sessionLink = a.session && link(a.session);
    const commit = a.commit ? commitRef(s, a.commit) : "";
    return `<li><div class="a-head">${badge(a.outcome)} ${pill(a.model)} ${commit} ${sessionLink ? transcriptLink(sessionLink) : ""}</div>${pointList(a.reason)}</li>`;
  }).join("");
  const deferral = f.deferral
    ? `<div class="block"><h4>Question</h4><p>${inline(f.deferral.question)}</p><ol class="pts">${f.deferral.options.map((o) => `<li>${inline(o.label)}: ${inline(o.consequences)}</li>`).join("")}</ol><p><b>Recommendation:</b> ${inline(f.deferral.recommendation)}</p></div>`
    : "";
  const decision = f.decision ? `<div class="block"><h4>Decision</h4><p>${inline(f.decision)}</p></div>` : "";
  return `<article class="item finding box ${accent(toneOf(f.status))}" id="${esc(f.id)}" data-status="${esc(f.status)}" data-severity="${esc(f.severity)}" data-kind="${esc(f.kind)}" data-change="${esc(f.change ?? "")}">
<div class="item-pills">${pills}</div>
<h3>${inline(f.title)}</h3>
<details class="layer"><summary>Impact, reasoning, fix and attempts ${pill(f.foundBy)}</summary><div class="f-body">
${sites ? `<div class="block"><h4>Sites</h4><ul class="sites">${sites}</ul></div>` : ""}
${details}${deferral}${decision}
${attempts ? `<div class="block"><h4>Attempts (${f.attempts.length})</h4><ol class="attempts">${attempts}</ol></div>` : ""}
</div></details>
</article>`;
}

function findingsSection(s: RunState<Data, Config>, link: SessionLink): string {
  const d = s.data;
  const statuses = ["fixed", "open", "deferred", "rejected", "duplicate", "skipped"]
    .filter((st) => d.findings.some((f) => f.status === st));
  const severities = ["critical", "important"].filter((sv) => d.findings.some((f) => f.severity === sv));
  const kinds = [["issue", "issue"], ["pattern", "pattern"], ["request", "requests"]]
    .filter(([k]) => d.findings.some((f) => f.kind === k));
  const changes = [["mechanical", "mechanical"]]
    .filter(([c]) => d.findings.some((f) => f.change === c));
  const count = (pred: (f: Finding) => boolean) => d.findings.filter(pred).length;
  const filters = `<div class="filters" role="group" aria-label="Filter findings">
${filterPill("status", "all", `all ${d.findings.length}`)}
${statuses.map((st) => filterPill("status", st, `${st} ${count((f) => f.status === st)}`, toneOf(st))).join("\n")}
<span class="sep" aria-hidden="true"></span>
${severities.map((sv) => filterPill("severity", sv, `${sv} ${count((f) => f.severity === sv)}`, sv === "critical" ? "bad" : "warn")).join("\n")}
${kinds.length > 1 || changes.length ? '<span class="sep" aria-hidden="true"></span>' : ""}
${kinds.length > 1 ? kinds.map(([k, label]) => filterPill("kind", k, `${label} ${count((f) => f.kind === k)}`)).join("\n") : ""}
${changes.map(([c, label]) => filterPill("change", c, `${label} ${count((f) => f.change === c)}`, c === "mechanical" ? "good" : "warn")).join("\n")}
<span class="count" data-count aria-live="polite"></span>
</div>`;
  const body = `${filters}
<div class="items" data-filterable>
${d.findings.map((f) => findingCard(s, f, link)).join("\n") || "<p>No findings.</p>"}
</div>`;
  return section("findings", "Findings", `${d.findings.length} finding${d.findings.length === 1 ? "" : "s"}`, body,
    `${openFindings(d).length} still open. Click a status, severity, or kind to filter; patterns can also be filtered by whether they are mechanical. Expand a finding for its impact, reasoning, fix, and attempts.`);
}

/** The workflow's sections of the run page. */
export function reportHtml(s: RunState<Data, Config>, link: SessionLink): string {
  return roundsSection(s, link) + findingsSection(s, link);
}
