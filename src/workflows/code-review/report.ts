// The code-review sections of summary.md: rounds, coverage, and every finding with its outcome.
import type { RunState } from "../../engine/types.ts";
import type { Config } from "./config.ts";
import type { Data } from "./data.ts";

export function report(s: RunState<Data, Config>): string {
  const d = s.data;
  const by = (st: string) => d.findings.filter((f) => f.status === st).length;
  const out = [
    "## Rounds",
    "",
    "| Round | Reported | Commits | Failed steps |",
    "|---|---|---|---|",
    ...d.rounds.map((r) => `| ${r.n}${r.n > s.config.maxRounds ? " (fix only)" : ""} | ${r.reported.join(" ") || "-"} | ${r.commits.length} | ${r.failed?.join(" ") || "-"} |`),
    "",
    `Findings: ${d.findings.length}; ${by("fixed")} fixed, ${by("rejected")} rejected, ${by("duplicate")} duplicate, ${by("deferred")} deferred, ${by("skipped")} skipped, ${by("open")} open.  `,
    `Coverage: ${d.coverage.visited.length} files read by an agent.`,
  ];
  if (d.baseline && !d.baseline.ok) out.push("The check failed before any change, so fixes were not gated on it until it passed.");
  if (d.organized) out.push(`History organized: ${d.organized.from} commits into ${d.organized.to}; the per-finding history is on \`${d.organized.raw}\`.`);
  if (d.audits.length) {
    out.push("", "## Audits", "", "| Audit | After round | Verdict | Findings | Not read |", "|---|---|---|---|---|");
    for (const a of d.audits) out.push(`| ${a.id} | ${a.after} | ${a.verdict ?? "running"} | ${a.reported.join(" ") || "-"} | ${a.unread.length || "-"} |`);
  }
  out.push("", "## Findings", "", "| ID | Kind | Status | Title | Commit |", "|---|---|---|---|---|");
  for (const f of d.findings) {
    const kind = f.kind === "pattern" ? `pattern (${f.change})` : f.kind === "request" ? "request" : f.severity;
    const commit = f.attempts.findLast((a) => a.commit)?.commit?.slice(0, 9) ?? (f.fixedBy ? `via ${f.fixedBy}` : "");
    out.push(`| ${f.id} | ${kind} | ${f.status} | ${f.title.replace(/\|/g, "/")} | ${commit} |`);
  }
  return out.join("\n");
}
