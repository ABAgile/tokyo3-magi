// A run: persisted state plus the services a workflow uses (journaled steps, agent calls, human questions).
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import { git, head, isDirty, resetTo } from "./git.ts";
import { applyInbox, readLedger } from "./inbox.ts";
import type {
  AgentCall, AgentOutcome, AgentRecord, Ctx, Driver, DriverTask, Outcome, Question, RunState, SkipRecord, Turn, Workflow,
} from "./types.ts";

export const now = (): string => new Date().toISOString();

/** When an attempt must end: its deadline, and the limit it was given, for the message. */
type Limit = { deadline: number; minutes: number };
export const stateFile = (runDir: string): string => join(runDir, "state.json");
const firstLine = (s: string): string => s.split("\n")[0];

export function loadState(runDir: string): RunState {
  const file = stateFile(runDir);
  if (!existsSync(file)) throw new Error(`not a magi run: ${runDir}`);
  return JSON.parse(readFileSync(file, "utf8")) as RunState;
}

/** Write state atomically. */
export function saveState(s: RunState): void {
  const file = stateFile(s.runDir);
  writeFileSync(`${file}.tmp`, JSON.stringify(s, null, 2) + "\n");
  renameSync(`${file}.tmp`, file);
}

export interface RunOptions {
  driver: Driver;
  /** Called after every save, e.g. to rewrite reports. */
  onSave?: (s: RunState) => void;
  /** Where log lines go; default stdout plus progress.log in the run directory. */
  log?: (line: string) => void;
}

export class Run<D, C> implements Ctx<D, C> {
  readonly state: RunState<D, C>;
  readonly #driver: Driver;
  readonly #onSave: (s: RunState) => void;
  readonly #log: (line: string) => void;

  constructor(state: RunState<D, C>, options: RunOptions) {
    this.state = state;
    this.#driver = options.driver;
    this.#onSave = options.onSave ?? (() => {});
    this.#log = options.log ?? ((line) => {
      console.log(line);
      appendFileSync(join(state.runDir, "progress.log"), line + "\n");
    });
  }

  get data(): D {
    return this.state.data;
  }

  get config(): C {
    return this.state.config;
  }

  get cwd(): string {
    return join(this.state.target.worktree, this.state.target.sub);
  }

  get #wt(): string {
    return this.state.target.worktree;
  }

  log(message: string): void {
    this.#log(`${new Date().toTimeString().slice(0, 8)} ${message}`);
  }

  save(): void {
    saveState(this.state as RunState);
    this.#onSave(this.state as RunState);
  }

  /** Run the workflow to its outcome. */
  async execute(workflow: Workflow<D, C>): Promise<Outcome> {
    this.state.status = "running";
    this.#recover();
    this.save();
    const outcome = await workflow.run(this);
    this.state.status = outcome;
    this.save();
    return outcome;
  }

  /** Discard what interrupted steps left behind. Other uncommitted changes are the operator's: stop. */
  #recover(): void {
    const keys = Object.keys(this.state.pending);
    if (keys.length) {
      git(this.#wt, ["checkout", "-q", "-f", this.state.target.branch]);
      resetTo(this.#wt, this.state.pending[keys[0]]);
      this.state.pending = {};
      this.log(`discarded the work of interrupted step(s) ${keys.join(", ")}; they will run again`);
    } else if (isDirty(this.#wt)) {
      throw new Error(`${this.#wt} has uncommitted changes: commit them (they will be reviewed) or discard them, then resume`);
    }
  }

  async step<T>(key: string, run: () => Promise<T>, apply?: (value: T) => void): Promise<T> {
    if (!this.state.journal[key]) {
      this.state.pending[key] = head(this.#wt);
      this.save();
      const value = await run();
      this.state.journal[key] = { value, applied: false, at: now() };
      delete this.state.pending[key];
    }
    const entry = this.state.journal[key];
    if (!entry.applied) {
      apply?.(entry.value as T);
      entry.applied = true;
      this.save();
    }
    return entry.value as T;
  }

  async agent<T extends TSchema>(call: AgentCall<T>): Promise<AgentOutcome<Static<T>>> {
    const out: AgentOutcome<Static<T>> = { failures: [], sessions: [], reads: [], commands: [], cost: 0 };
    for (const [i, model] of call.models.entries()) {
      const before = head(this.#wt);
      const task: DriverTask = {
        key: call.key, model, cwd: this.cwd, write: call.write, prompt: "", resultSchema: call.result,
        sessionDir: join(this.state.runDir, "sessions", call.key),
        resultFile: join(this.state.runDir, "results", `${call.key}.${i + 1}.json`),
      };
      task.prompt = `${call.prompt(out.failures.map((f) => `${f.model}: ${f.reason}`))}\n\n${this.#driver.submitHint(task)}`;
      mkdirSync(dirname(task.resultFile), { recursive: true });
      rmSync(task.resultFile, { force: true });
      const record: AgentRecord = { key: call.key, model, driver: this.#driver.name, startedAt: now(), cost: 0, turns: 0 };
      this.state.agents.push(record);
      this.save();
      this.log(`start ${call.key} (${model})`);

      const limit = call.timeoutMin ? { deadline: Date.now() + call.timeoutMin * 60_000, minutes: call.timeoutMin } : undefined;
      const attempt = await this.#converse(task, call, record, limit);
      out.cost += record.cost;
      if (record.session) out.sessions.push(record.session);
      record.finishedAt = now();
      record.error = attempt.error;
      this.save();
      if (!call.write && (head(this.#wt) !== before || isDirty(this.#wt))) {
        resetTo(this.#wt, before);
        this.log(`${call.key} changed the worktree although it is read-only; the changes were discarded`);
      }
      if (attempt.output !== undefined) {
        Object.assign(out, { output: attempt.output, model, session: record.session, reads: attempt.reads, commands: attempt.commands });
        this.log(`done ${call.key} (${model}): ${record.turns} turn(s), $${record.cost.toFixed(2)}`);
        return out;
      }
      if (call.write) resetTo(this.#wt, before);
      out.failures.push({ model, reason: attempt.error ?? "no result" });
      this.log(`${call.key} failed with ${model}: ${firstLine(attempt.error ?? "no result")}`);
    }
    return out;
  }

  /** Talk to one model until it submits an acceptable result, or gives up. */
  async #converse<T extends TSchema>(task: DriverTask, call: AgentCall<T>, record: AgentRecord, limit?: Limit) {
    const reads: string[] = [];
    const commands: string[] = [];
    let turn = await this.#turn(task, () => this.#driver.start(task), limit);
    try {
      for (let repairs = 0; ; repairs++) {
        record.turns++;
        record.cost += turn.cost;
        record.session ??= turn.session;
        reads.push(...turn.reads);
        commands.push(...turn.commands);
        if (turn.error) return { error: turn.error };
        const checked = this.#accept(task, call);
        if ("output" in checked) return { output: checked.output, reads, commands };
        if (repairs >= (call.maxRepairs ?? 3)) return { error: `not accepted after ${repairs} repairs: ${checked.problem}` };
        if (!turn.session) return { error: checked.problem };
        this.log(`${call.key}: result not accepted, asking ${task.model} to repair it: ${firstLine(checked.problem)}`);
        rmSync(task.resultFile, { force: true });
        const message = `Your result was not accepted: ${checked.problem}\n\n${this.#driver.submitHint(task)}`;
        const session = turn.session;
        turn = await this.#turn(task, () => this.#driver.resume(task, session, message), limit);
      }
    } finally {
      if (record.session) this.#driver.close(record.session);
    }
  }

  /** One driver turn. If the attempt's limit passes during it, the driver is told to abort and the turn fails. */
  async #turn(task: DriverTask, work: () => Promise<Turn>, limit?: Limit): Promise<Turn> {
    if (!limit) return work();
    const expired = (): Turn => ({ cost: 0, reads: [], commands: [], error: `timed out after ${limit.minutes} min` });
    const left = limit.deadline - Date.now();
    if (left <= 0) return expired();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), left);
    });
    const running = work();
    const first = await Promise.race([running, timeout]);
    clearTimeout(timer);
    if (first !== "timeout") return first;
    await this.#driver.abort(task.key).catch(() => {});
    return { ...(await running), error: expired().error };
  }

  #accept<T extends TSchema>(task: DriverTask, call: AgentCall<T>): { output: Static<T> } | { problem: string } {
    if (!existsSync(task.resultFile)) return { problem: "you have not submitted a result." };
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(task.resultFile, "utf8"));
    } catch (err) {
      return { problem: `the result is not valid JSON: ${err instanceof Error ? err.message : err}` };
    }
    if (!Value.Check(call.result, value)) {
      const errors = [...Value.Errors(call.result, value)].slice(0, 6).map((e) => `${e.instancePath || "(root)"} ${e.message}`);
      return { problem: `the result does not match the schema: ${errors.join("; ")}` };
    }
    const problem = call.verify?.(value as Static<T>);
    return problem ? { problem } : { output: value as Static<T> };
  }

  ask(question: Omit<Question, "askedAt">): void {
    this.state.questions = this.state.questions.filter((q) => q.id !== question.id);
    this.state.questions.push({ ...question, askedAt: now() });
    this.save();
  }

  /** Fold in the inbox first, so answers and requests queued by `magi decide` or `magi request` are seen. */
  #absorb(): void {
    if (applyInbox(this.state.runDir, this.state as RunState)) this.save();
  }

  answers(): Question[] {
    this.#absorb();
    return this.state.questions.filter((q) => q.answer && !q.consumed);
  }

  requests() {
    this.#absorb();
    return this.state.requests.filter((r) => !r.consumed);
  }

  consume(id: string): void {
    for (const item of [...this.state.questions, ...this.state.requests]) if (item.id === id) item.consumed = true;
    this.save();
  }

  skipped(): SkipRecord[] {
    return readLedger(this.state.ledger);
  }
}
