// The human side of a run: answering questions, adding requests, and the per-repository skip ledger.
// These work on a stopped run's state; the workflow picks the input up when the run resumes.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Question, RunState, SkipRecord } from "./types.ts";

const now = (): string => new Date().toISOString();

export function readLedger(file: string): SkipRecord[] {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as SkipRecord[]) : [];
}

function appendLedger(file: string, record: SkipRecord): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify([...readLedger(file), record], null, 2) + "\n");
}

/**
 * Answer a question: an option number, an instruction, or "skip[: reason]". A skip is also written to the
 * repository's ledger, so later runs do not raise it again. Returns what happened.
 */
export function answer(s: RunState, id: string, text: string): string {
  const q = s.questions.find((x) => x.id === id);
  if (!q) throw new Error(`no question ${id} in this run`);
  if (q.consumed) throw new Error(`${id} was already answered and acted on`);
  const skip = text.trim().match(/^skip\b:?\s*(.*)$/is);
  if (skip) {
    const reason = skip[1].trim() || "no reason given";
    q.answer = { text: reason, skip: true, at: now() };
    appendLedger(s.ledger, { title: q.title, detail: q.detail.split("\n").slice(0, 6).join("\n"), reason, run: s.id, id, at: now() });
    return `${id} skipped; later runs on this repository will not raise it again`;
  }
  if (/^\d+$/.test(text.trim())) {
    const option = q.options[Number(text) - 1];
    if (!option) throw new Error(`${id} has no option ${text}`);
    q.answer = { text: `Option ${text.trim()}: ${option.label}`, skip: false, at: now() };
  } else {
    q.answer = { text, skip: false, at: now() };
  }
  return `${id} answered; resume the run to act on it`;
}

export function addRequest(s: RunState, text: string): string {
  const id = `request-${s.requests.length + 1}`;
  s.requests.push({ id, text, at: now() });
  return id;
}

export const openQuestions = (s: RunState): Question[] => s.questions.filter((q) => !q.answer);

export function renderQuestion(q: Question): string {
  const lines = [`${q.id}: ${q.title}`, "", q.detail, "", `Decision needed: ${q.question}`];
  q.options.forEach((o, i) => lines.push(`  ${i + 1}. ${o.label}: ${o.consequences}`));
  lines.push(`Recommendation: ${q.recommendation}`);
  return lines.join("\n");
}

/** Walk through every open question; save is called after each answer. */
export async function answerInteractively(s: RunState, save: () => void): Promise<void> {
  const items = openQuestions(s);
  if (!items.length) {
    console.log("Nothing awaits a decision.");
    return;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const [i, q] of items.entries()) {
      console.log(`\n=== ${i + 1}/${items.length} ${renderQuestion(q)}`);
      for (;;) {
        const reply = (await rl.question("\nOption number, an instruction, 'skip: <reason>', or Enter to leave it: ")).trim();
        if (!reply) break;
        try {
          console.log(answer(s, q.id, reply));
          save();
          break;
        } catch (err) {
          console.log(err instanceof Error ? err.message : String(err));
        }
      }
    }
  } finally {
    rl.close();
  }
}
