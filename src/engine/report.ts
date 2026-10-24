// summary.md and outstanding.md, rewritten on every save. The workflow adds its own sections to the summary.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openQuestions } from "./inbox.ts";
import type { RunState, Workflow } from "./types.ts";

const usd = (n: number): string => `$${n.toFixed(2)}`;

export function writeReports(s: RunState, workflow: Workflow<any, any>, cli: string): void {
  writeFileSync(join(s.runDir, "summary.md"), summary(s, workflow, cli));
  writeFileSync(join(s.runDir, "outstanding.md"), outstanding(s, cli));
}

function summary(s: RunState, workflow: Workflow<any, any>, cli: string): string {
  const t = s.target;
  const total = s.agents.reduce((n, a) => n + a.cost, 0);
  const out = [
    `# magi ${s.workflow} ${s.id}: ${s.status}`,
    "",
    `Target: ${t.repo}/${t.sub}  `,
    `Branch: \`${t.branch}\` in ${t.worktree}, from ${t.base.slice(0, 12)}  `,
    `Driver: ${s.driver}. Agent cost so far: ${usd(total)}.`,
    "",
    workflow.report(s).trim(),
    "",
    "## Agent calls",
    "",
    "| Step | Model | Turns | Cost | Result |",
    "|---|---|---|---|---|",
    ...s.agents.map((a) => `| ${a.key} | ${a.model} | ${a.turns} | ${usd(a.cost)} | ${a.error ? `failed: ${a.error.split("\n")[0].slice(0, 80).replace(/\|/g, "/")}` : a.finishedAt ? "ok" : "running"} |`),
    "",
  ];
  const open = openQuestions(s).length;
  out.push(open ? `${open} question(s) await your decision: \`${cli} decide ${s.runDir}\`, then \`${cli} resume ${s.runDir}\`.` : "Nothing awaits a decision.");
  out.push(`Inspect the result: \`git -C ${t.repo} log --stat ${t.base.slice(0, 12)}..${t.branch}\``);
  return out.join("\n") + "\n";
}

function outstanding(s: RunState, cli: string): string {
  const items = openQuestions(s);
  const out = [`# Outstanding decisions (${items.length})`, ""];
  if (items.length) {
    out.push(
      "Answer interactively or one at a time. An active run takes answers in after its current fix; a stopped run\nrecords them at once, and `resume` acts on them:",
      "",
      `    ${cli} decide ${s.runDir}`,
      `    ${cli} decide ${s.runDir} <ID> "<option number or instruction>"`,
      `    ${cli} decide ${s.runDir} <ID> "skip: <reason>"`,
      `    ${cli} resume ${s.runDir}`,
      "",
    );
  }
  for (const q of items) {
    out.push(`## ${q.id}: ${q.title}`, "", q.detail, "", `**Decision needed:** ${q.question}`, "", "**Options:**");
    q.options.forEach((o, i) => out.push(`${i + 1}. ${o.label}: ${o.consequences}`));
    out.push("", `**Recommendation:** ${q.recommendation}`, "");
    if (q.sessions.length) out.push("Agent sessions (open with `pi --session <file>`):", ...q.sessions.map((x) => `- ${x}`), "");
  }
  return out.join("\n") + "\n";
}
