// The code-review sections of the run page: the outcome, rounds, audits, and every finding with its attempts.
import { badge, esc } from "../../engine/html.ts";
import type { RunState, SessionLink } from "../../engine/types.ts";
import type { Config } from "./config.ts";
import type { Data, Finding } from "./data.ts";

const cap = (k: string): string => k.charAt(0).toUpperCase() + k.slice(1);

function findingHtml(f: Finding, link: SessionLink): string {
  const kind = f.kind === "pattern" ? `pattern, ${f.change}` : f.kind === "request" ? "request" : f.severity;
  const sites = f.sites.map((x) => `<li><code>${esc(x.path)}${x.line ? `:${x.line}` : ""}</code>${x.note ? ` ${esc(x.note)}` : ""}</li>`).join("");
  const details = Object.entries(f.details).map(([k, v]) => `<dt>${esc(cap(k))}</dt><dd>${esc(v)}</dd>`).join("");
  const attempts = f.attempts.map((a) => {
    const sessionLink = a.session && link(a.session);
    return `<li>${esc(a.model)} ${badge(a.outcome, a.outcome)} ${esc(a.reason)}${a.commit ? ` <code>${esc(a.commit.slice(0, 9))}</code>` : ""}${sessionLink ? ` <a href="${esc(sessionLink)}">transcript</a>` : ""}</li>`;
  }).join("");
  const deferral = f.deferral
    ? `<div class="deferral"><b>Question:</b> ${esc(f.deferral.question)}<ol>${f.deferral.options.map((o) => `<li>${esc(o.label)}: ${esc(o.consequences)}</li>`).join("")}</ol><b>Recommendation:</b> ${esc(f.deferral.recommendation)}</div>`
    : "";
  return `<article class="finding" id="${esc(f.id)}"><h3>${esc(f.id)}: ${esc(f.title)} ${badge(f.status, f.status)} <small>${esc(kind)}</small></h3>
${sites ? `<ul class="sites">${sites}</ul>` : ""}
${details ? `<dl class="details">${details}</dl>` : ""}
${attempts ? `<h4>Attempts</h4><ul>${attempts}</ul>` : ""}
${deferral}
${f.decision ? `<p><b>Decision:</b> ${esc(f.decision)}</p>` : ""}
${f.fixedBy ? `<p>Fixed as part of ${esc(f.fixedBy)}.</p>` : ""}</article>`;
}

export function reportHtml(s: RunState<Data, Config>, link: SessionLink): string {
  const d = s.data;
  const count = (st: string) => d.findings.filter((f) => f.status === st).length;
  const statuses = ["fixed", "rejected", "duplicate", "deferred", "skipped", "open"];
  const rounds = d.rounds.map((r) => `<tr><td>${r.n}${r.n > s.config.maxRounds ? " (fix only)" : ""}</td><td>${esc(r.reported.join(" ") || "-")}</td><td>${r.commits.map((c) => `<code>${esc(c.slice(0, 9))}</code>`).join(" ") || "-"}</td><td>${esc(r.failed.join(" ") || "-")}</td></tr>`).join("");
  const audits = d.audits.map((a) => `<tr><td>${a.id}</td><td>${a.after}</td><td>${badge(a.verdict ?? "running", a.verdict ?? "running")}</td><td>${esc(a.reported.join(" ") || "-")}</td><td>${a.unread.length || "-"}</td></tr>`).join("");
  return `<section id="findings"><h2>Findings</h2>
<p class="cards">${statuses.map((st) => `${badge(st, st)} ${count(st)}`).join(" &nbsp; ")}</p>
<p>Coverage: ${d.coverage.visited.length} files read by an agent.</p>
${d.baseline && !d.baseline.ok ? "<p><b>The check failed before any change</b>, so fixes were not gated on it until it passed.</p>" : ""}
${d.organized ? `<p>History organized: ${d.organized.from} commits into ${d.organized.to}. The per-finding history is on <code>${esc(d.organized.raw)}</code>.</p>` : ""}
<h3>Rounds</h3>
<table><thead><tr><th>Round</th><th>Reported</th><th>Commits</th><th>Failed steps</th></tr></thead><tbody>${rounds}</tbody></table>
${d.audits.length ? `<h3>Audits</h3><table><thead><tr><th>Audit</th><th>After round</th><th>Verdict</th><th>Findings</th><th>Not read</th></tr></thead><tbody>${audits}</tbody></table>` : ""}
<h3>Each finding</h3>
${d.findings.map((f) => findingHtml(f, link)).join("\n") || "<p>None.</p>"}
</section>`;
}
