// Every prompt of the code-review workflow. Edit this file to change what agents look for or how they fix.
import type { SkipRecord } from "../../engine/types.ts";
import type { Finding } from "./data.ts";

const siteText = (f: Finding): string =>
  f.sites.map((s) => `${s.path}${s.line ? `:${s.line}` : ""}${s.note ? ` (${s.note})` : ""}`).join("\n");

/** One line per known finding, so agents do not report it again. */
function known(findings: Finding[], skipped: SkipRecord[]): string {
  const lines = findings.map((f) => `- ${f.id} [${f.status}] ${f.title} (${f.sites[0]?.path ?? "no site"})`);
  lines.push(...skipped.map((s) => `- [skipped by a human: ${s.reason}] ${s.title}`));
  return lines.length ? lines.join("\n") : "(none yet)";
}

export function findingText(f: Finding): string {
  const kind = f.kind === "pattern" ? `pattern, ${f.change}` : f.kind === "request" ? "operator request" : f.severity;
  const sections = Object.entries(f.details).map(([k, v]) => `${k[0].toUpperCase()}${k.slice(1)}: ${v}`);
  return [`${f.id} (${kind}): ${f.title}`, `Sites:\n${siteText(f) || "(not given)"}`, ...sections].join("\n\n");
}

export function reviewPrompt(o: { focus: string; shard: string[]; findings: Finding[]; skipped: SkipRecord[] }): string {
  const scope = o.shard.length
    ? `These files are assigned to you. Earlier rounds have not read them, or they changed since the last review. Read every one in full, paging through long files with offset and limit:\n${o.shard.join("\n")}`
    : "Every file has been read by an earlier round. Look for defects that span files: contracts between packages, error and context propagation, shutdown and cleanup order, configuration parsed differently in two places.";
  return `Review this project for actionable defects. Focus: ${o.focus}.

Read-only: do not edit, write, stage, or commit anything. Work without asking questions.

${scope}

Be exhaustive:
- Follow callers and callees into any other file you need.
- For every defect, search the whole project with rg for the same mistake, and list all sites in one finding, so it gets fixed everywhere at once.
- Report only real, actionable defects (critical or important), each with evidence from the code. Skip style nits and speculation.

Already known; do not report again unless you have new evidence:
${known(o.findings, o.skipped)}

Your result lists every confirmed finding, and any assigned file you could not read.`;
}

export function auditPrompt(o: { focus: string; shard: string[]; findings: Finding[]; skipped: SkipRecord[] }): string {
  return `Final audit before this project is declared clean: the review rounds found nothing new in their last pass. Find what they missed. Focus: ${o.focus}.

Read-only: do not edit, write, stage, or commit anything. Work without asking questions.

These files are assigned to you. Read every one in full, paging through long files with offset and limit, and follow callers and callees into other files as needed:
${o.shard.join("\n")}

Be strict about evidence. Report a defect only when you can point to the code that causes it and describe an input or sequence that makes it fail. For each defect, search the whole project with rg and list every site. Skip style, naming, and speculation.

Already known; do not report again unless you have new evidence:
${known(o.findings, o.skipped)}

Your result lists every confirmed finding, and any assigned file you could not read.`;
}

export function patternPrompt(o: { files: number; findings: Finding[]; skipped: SkipRecord[] }): string {
  return `Search this whole project (${o.files} text files; list them with git ls-files) for recurring handling that should go through one shared abstraction, so that its variants interact through a minimal, necessary interface. This is not a bug review.

Read-only: do not edit, write, stage, or commit anything. Work without asking questions.

Method:
1. Map the layers first: entry points (main packages, HTTP and RPC handlers, CLI commands), domain logic, storage, external clients. Read the project AGENTS.md or CLAUDE.md and any shared library they name; you may read outside this repository, but only this repository can change.
2. Hunt for candidates with rg across all files, not a sample. Look for:
   - the same sequence of steps repeated with small variations: request decoding, validation, and responses; mapping errors to status codes; configuration and environment parsing; retries and timeouts; transactions; authentication and permission checks; audit and log emission; start/stop and open/close lifecycles; test setup;
   - parallel switch or if chains over the same set of kinds, which want one table or one interface;
   - types with the same method set and no shared interface, and wide interfaces whose callers use one or two methods;
   - layering leaks: handlers that reach storage or wire formats directly, domain code that knows transport details;
   - local copies of helpers that a shared library, or another package here, already provides.
3. Confirm each candidate by reading every occurrence, and count the sites.

Report a pattern only when the abstraction removes more code and branching than it adds, it has three or more sites (two when the duplication is security-relevant), and its interface serves every site without flags or modes that exist for one caller. Prefer extending an existing abstraction over adding one. Do not propose speculative layers, wrappers without behavior, or generic frameworks.

Already known; do not report again unless you have new evidence:
${known(o.findings, o.skipped)}

Mark a pattern mechanical only when it preserves behavior and is safe to apply now; otherwise mark it needs-decision and give the options and your recommendation.`;
}

export function fixPrompt(o: { finding: Finding; check: string; open: Finding[]; failures: string[] }): string {
  const f = o.finding;
  const parts = [`Resolve this finding in this project. Work without asking questions.\n\n${findingText(f)}`];
  if (f.decision) {
    const asked = f.deferral
      ? `The question was: ${f.deferral.question}\nOptions:\n${f.deferral.options.map((op, i) => `${i + 1}. ${op.label}: ${op.consequences}`).join("\n")}\n`
      : "";
    parts.push(`A human decided how to proceed. ${asked}Decision: ${f.decision}\nCarry out the decision.`);
  }
  const failed = [...f.attempts.filter((a) => a.outcome === "failed").map((a) => `${a.model}: ${a.reason}`), ...o.failures];
  if (failed.length) parts.push(`Earlier attempts failed; avoid repeating them:\n${failed.map((x) => `- ${x}`).join("\n")}`);
  const others = o.open.filter((x) => x.id !== f.id);
  if (others.length) {
    parts.push(`Other open findings, for also_resolves only when your change fully resolves one:\n${others.map((x) => `- ${x.id} ${x.title}`).join("\n")}`);
  }
  parts.push(`Steps:
1. Verify the finding against the code: read the surrounding code and tests, and reproduce it with a test or command when practical.
2. If it is real, make the smallest correct fix. Fix every listed site, then search the whole project with rg for sites the report missed, and fix those too. Preserve existing behavior and public APIs; no unrelated refactors.
   For a mechanical pattern: add the interface where the finding says, migrate every site to it, and delete the replaced code, so old and new paths never live side by side. Behavior must stay identical: existing tests pass unchanged, and the new abstraction gets its own tests.
   Put regression tests in the existing test file that covers the changed code, next to related tests and reusing their helpers. If none exists, create one named for the behavior it covers. Never name files or tests after findings, reviews, or rounds. Leave no scratch files in the project.
3. Run the verification the project AGENTS.md requires, and fix anything you broke.${o.check ? `\n   A fixed result is accepted only if \`${o.check}\` passes; you will be told if it does not.` : ""}
4. Submit the outcome:
   - fixed, with a commit subject and body. The loop commits your changes; do not stage or commit yourself.
   - rejected, when the finding is wrong, not worth its cost, or out of scope. Change nothing.
   - duplicate, with duplicate_of, when another known finding covers it. Change nothing.
   - deferred, only when a correct fix needs a judgment the code and docs cannot settle: it breaks a public API or behavior callers rely on, picks between real tradeoffs (security policy, compatibility, data migration, package layout), or needs changes outside this repository. Give the question, at least two options, and your recommendation. Size alone is never a reason to defer: do the work.
Only edit files inside the working directory; anything outside it is a read-only reference.`);
  return parts.join("\n\n");
}
