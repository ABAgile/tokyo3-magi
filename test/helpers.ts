// Test helpers: a scratch git repository, and a scripted driver standing in for real models.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Run } from "../src/engine/run.ts";
import type { Driver, DriverTask, RunState, Turn, Workflow } from "../src/engine/types.ts";
import { createRunState } from "../src/engine/workspace.ts";

export const sh = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A repository with a.go, b.go, c/d.go (10 lines each) and a vendored file, committed. */
export function scratchRepo(): string {
  const repo = join(mkdtempSync(join(tmpdir(), "magi-test-")), "repo");
  mkdirSync(join(repo, "c"), { recursive: true });
  mkdirSync(join(repo, "vendor"));
  for (const f of ["a.go", "b.go", "c/d.go"]) writeFileSync(join(repo, f), Array.from({ length: 10 }, (_, i) => `// ${f} ${i}`).join("\n") + "\n");
  writeFileSync(join(repo, "vendor/v.go"), "// vendored\n");
  sh(repo, "init", "-q");
  sh(repo, "config", "user.email", "t@t");
  sh(repo, "config", "user.name", "t");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-qm", "files");
  return repo;
}

/** What a scripted agent does in one turn. */
export interface FakeTurn {
  /** Written to the result file, as a submit tool would. */
  submit?: unknown;
  /** Never answers; the turn ends only when the engine aborts it. */
  hang?: boolean;
  error?: string;
  reads?: string[];
  commands?: string[];
}

export type Script = (task: DriverTask, message: string, turn: number) => Promise<FakeTurn | void> | FakeTurn | void;

export class FakeDriver implements Driver {
  readonly name = "fake";
  /** Every turn: key, model, turn number within its conversation, and the message sent. */
  readonly turns: { key: string; model: string; turn: number; message: string }[] = [];
  readonly closed: string[] = [];
  readonly #script: Script;
  readonly #stops = new Map<string, () => void>();
  #next = 0;
  readonly #conversations = new Map<string, number>();

  constructor(script: Script) {
    this.#script = script;
  }

  submitHint(): string {
    return "Submit your result.";
  }

  start(task: DriverTask): Promise<Turn> {
    const session = `session-${++this.#next}`;
    this.#conversations.set(session, 0);
    return this.#turn(task, session, task.prompt);
  }

  resume(task: DriverTask, session: string, message: string): Promise<Turn> {
    return this.#turn(task, session, message);
  }

  async #turn(task: DriverTask, session: string, message: string): Promise<Turn> {
    const turn = (this.#conversations.get(session) ?? 0) + 1;
    this.#conversations.set(session, turn);
    this.turns.push({ key: task.key, model: task.model, turn, message });
    const r = (await this.#script(task, message, turn)) ?? {};
    if (r.hang) {
      // Stands in for a model that never answers, until the engine aborts it.
      await new Promise<void>((resolve) => this.#stops.set(task.key, resolve));
      return { session, cost: 0, reads: [], commands: [], error: "aborted" };
    }
    if (r.submit !== undefined) writeFileSync(task.resultFile, JSON.stringify(r.submit));
    return { session, cost: 0.01, reads: r.reads ?? [], commands: r.commands ?? [], error: r.error };
  }

  close(session: string): void {
    this.closed.push(session);
  }

  async abort(key: string): Promise<void> {
    this.#stops.get(key)?.();
    this.#stops.delete(key);
  }

  async abortAll(): Promise<void> {}
}

/** A new run of workflow on repo, driven by driver, logging into lines. */
export function newRun<D, C>(workflow: Workflow<D, C>, config: C, repo: string, driver: Driver, lines: string[] = []): Run<D, C> {
  const state = createRunState({ workflow, config, targetDir: repo, runsRoot: join(repo, "..", "runs"), driver: driver.name });
  return new Run(state as RunState<D, C>, { driver, log: (l) => lines.push(l) });
}
