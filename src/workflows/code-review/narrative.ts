// The report's summary prose. An agent writes where the project stands and groups the fixed findings by kind of
// defect, from the run's facts. Figures and lists on the page come from the data, never from this text.
import type { Static } from "typebox";
import { fingerprint, NARRATIVE_KEY, readNarrative, writeNarrative } from "../../engine/narrative.ts";
import type { Ctx, Narrative, RunState } from "../../engine/types.ts";
import { type Config, SUMMARY_MODELS } from "./config.ts";
import { type Data, type Finding } from "./data.ts";
import { narrativePrompt } from "./prompts.ts";
import { type NarrativeResult, NarrativeSchema } from "./schemas.ts";

type C = Ctx<Data, Config>;

/** The summary for the run as it stands: the cached one when the facts have not changed, else a new one. */
export async function narrate(ctx: C): Promise<Narrative | undefined> {
  const prompt = narrativePrompt(runFacts(ctx.state as RunState<Data, Config>));
  const key = fingerprint(prompt);
  const cached = readNarrative(ctx.state.runDir);
  if (cached?.fingerprint === key) return cached.narrative;

  const fixed = ctx.data.findings.filter((f) => f.status === "fixed");
  const o = await ctx.agent({
    key: NARRATIVE_KEY, models: ctx.config.models.summary ?? SUMMARY_MODELS, write: false, result: NarrativeSchema, maxRepairs: 3,
    prompt: () => prompt,
    verify: (r) => coverage(r, fixed),
  });
  if (!o.output) return undefined;
  const narrative: Narrative = { ...o.output, model: o.model ?? "", at: new Date().toISOString() };
  writeNarrative(ctx.state.runDir, { fingerprint: key, narrative });
  return narrative;
}

/** Only fixed findings are grouped, each in exactly one category. */
function coverage(r: NarrativeResult, fixed: Finding[]): string | undefined {
  const known = new Set(fixed.map((f) => f.id));
  const seen = new Set<string>();
  for (const c of r.categories) {
    for (const id of c.ids) {
      if (!known.has(id)) return `${id} is not a fixed finding of this run; list only fixed IDs`;
      if (seen.has(id)) return `${id} is in more than one category`;
      seen.add(id);
    }
  }
  const missing = fixed.map((f) => f.id).filter((id) => !seen.has(id));
  return missing.length ? `these fixed findings are in no category: ${missing.join(", ")}` : undefined;
}

/** What the summary is written from: the run's outcome, its rounds and audits, and every finding with its status. */
function runFacts(s: RunState<Data, Config>): string {
  const d = s.data;
  const reviewRounds = d.rounds.filter((r) => r.n <= s.config.maxRounds).length;
  const audits = d.audits.length
    ? d.audits.map((a) => `audit ${a.id} after round ${a.after}: ${a.verdict ?? "running"}, ${a.reported.length} finding(s)`).join("; ")
    : "none ran";
  const rounds = d.rounds.map((r) => {
    const fixOnly = r.n > s.config.maxRounds ? " (fixes only; not reviewed again)" : "";
    const failed = r.failed.length ? `; failed steps: ${r.failed.join(", ")}` : "";
    return `- round ${r.n}${fixOnly}: ${r.reported.length} new finding(s), ${r.commits.length} commit(s)${failed}`;
  });
  const waiting = d.findings.filter((f) => f.status === "deferred").map((f) => `${f.id} ${f.title}`);
  return [
    `Run status: ${s.status}.`,
    `Review rounds: ${reviewRounds} of at most ${s.config.maxRounds}.`,
    `Project check before any change: ${d.baseline ? (d.baseline.ok ? "passed" : "failed") : "not run"}.`,
    `Fixes were gated on the project check: ${d.checkGate ? "yes" : "no, it failed before any change"}.`,
    `Audits: ${audits}.`,
    "Rounds:",
    ...rounds,
    `Waiting for a decision: ${waiting.length ? waiting.join("; ") : "none"}.`,
    "Findings (ID | kind | severity | status | title):",
    ...d.findings.map((f) => `${f.id} | ${f.kind} | ${f.severity} | ${f.status} | ${f.title}`),
  ].join("\n");
}
