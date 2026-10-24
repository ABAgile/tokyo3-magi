// Human input for a run: answers to questions, and requests for changes. Both are appended to inbox.jsonl, which
// only ever grows, so `magi decide` and `magi request` never write the state file the running loop owns. The
// loop applies the inbox when a workflow asks for input: between fixes, and at the start of each round. When no
// loop is running, the CLI applies it directly.
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Question, RunState, SkipRecord } from "./types.ts";

const now = (): string => new Date().toISOString();

export type InboxEntry =
  | { type: "answer"; id: string; text: string; at: string }
  | { type: "request"; id: string; text: string; at: string }
  | { type: "invalid"; raw: string };

export const inboxFile = (runDir: string): string => join(runDir, "inbox.jsonl");

/** The entries written so far. A last line still being written is left for a later read. */
export function readInbox(runDir: string): InboxEntry[] {
  const file = inboxFile(runDir);
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  const end = text.lastIndexOf("\n");
  if (end < 0) return [];
  return text.slice(0, end).split("\n").map((raw): InboxEntry => {
    try {
      return JSON.parse(raw) as InboxEntry;
    } catch {
      return { type: "invalid", raw };
    }
  });
}

function appendInbox(runDir: string, entry: InboxEntry): void {
  mkdirSync(dirname(inboxFile(runDir)), { recursive: true });
  appendFileSync(inboxFile(runDir), JSON.stringify(entry) + "\n");
}

export function readLedger(file: string): SkipRecord[] {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as SkipRecord[]) : [];
}

function appendLedger(file: string, record: SkipRecord): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify([...readLedger(file), record], null, 2) + "\n");
}

/**
 * Queue an answer: an option number, an instruction, or "skip[: reason]". It takes effect when the run next reads
 * its inbox. Validated against the state as the caller last saw it, and against answers already queued.
 */
export function queueAnswer(runDir: string, s: RunState, id: string, text: string): string {
  const q = s.questions.find((x) => x.id === id);
  if (!q) throw new Error(`no question ${id} in this run`);
  if (q.consumed || q.answer) throw new Error(`${id} was already answered`);
  if (readInbox(runDir).some((e) => e.type === "answer" && e.id === id)) {
    throw new Error(`${id} already has an answer waiting to be applied`);
  }
  const trimmed = text.trim();
  if (/^\d+$/.test(trimmed) && !q.options[Number(trimmed) - 1]) throw new Error(`${id} has no option ${trimmed}`);
  appendInbox(runDir, { type: "answer", id, text: trimmed, at: now() });
  return `${id} answered`;
}

/** Queue a request for a change. Returns its id. */
export function queueRequest(runDir: string, text: string): string {
  const id = `request-${randomBytes(3).toString("hex")}`;
  appendInbox(runDir, { type: "request", id, text, at: now() });
  return id;
}

/**
 * Fold the inbox entries not yet read into the state: answers to questions, requests, and the ledger of skips.
 * Returns how many entries were new. The caller saves the state when it changed.
 */
export function applyInbox(runDir: string, s: RunState): number {
  const entries = readInbox(runDir);
  const fresh = entries.slice(s.inboxRead ?? 0);
  for (const e of fresh) {
    if (e.type === "answer") applyAnswer(s, e);
    else if (e.type === "request" && !s.requests.some((r) => r.id === e.id)) s.requests.push({ id: e.id, text: e.text, at: e.at });
  }
  s.inboxRead = entries.length;
  return fresh.length;
}

function applyAnswer(s: RunState, e: { id: string; text: string; at: string }): void {
  const q = s.questions.find((x) => x.id === e.id);
  if (!q || q.answer) return;
  const skip = e.text.match(/^skip\b:?\s*(.*)$/is);
  if (skip) {
    const reason = skip[1].trim() || "no reason given";
    q.answer = { text: reason, skip: true, at: e.at };
    appendLedger(s.ledger, { title: q.title, detail: q.detail.split("\n").slice(0, 6).join("\n"), reason, run: s.id, id: e.id, at: e.at });
  } else if (/^\d+$/.test(e.text) && q.options[Number(e.text) - 1]) {
    q.answer = { text: `Option ${e.text}: ${q.options[Number(e.text) - 1].label}`, skip: false, at: e.at };
  } else {
    q.answer = { text: e.text, skip: false, at: e.at };
  }
}

export const openQuestions = (s: RunState): Question[] => s.questions.filter((q) => !q.answer);

export function renderQuestion(q: Question): string {
  const lines = [`${q.id}: ${q.title}`, "", q.detail, "", `Decision needed: ${q.question}`];
  q.options.forEach((o, i) => lines.push(`  ${i + 1}. ${o.label}: ${o.consequences}`));
  lines.push(`Recommendation: ${q.recommendation}`);
  return lines.join("\n");
}

/** Walk through every open question and queue an answer for each one the user gives. */
export async function answerInteractively(runDir: string, s: RunState): Promise<void> {
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
          console.log(queueAnswer(runDir, s, q.id, reply));
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
