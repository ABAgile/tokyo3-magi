// The contracts between the three layers:
//   engine    runs a workflow: state, journaled steps, agent calls, human questions, reports. Knows no workflow.
//   drivers   run one agent turn on some harness (pi SDK, pi CLI, ...). Know no workflow.
//   workflows decide what to do: prompts, result schemas, and the loop itself, written as a plain script.
import type { Static, TSchema } from "typebox";

// ---- drivers ----

/** One agent conversation. The driver must make the agent submit its result as JSON into resultFile. */
export interface DriverTask {
  key: string;
  /** Model spec in the driver's own format; for pi drivers "provider/id[:thinking]". */
  model: string;
  cwd: string;
  sessionDir: string;
  prompt: string;
  /** Allow file edits. Read-only agents may still have a shell, so the engine checks the tree afterwards. */
  write: boolean;
  resultFile: string;
  resultSchema: TSchema;
}

export interface Turn {
  /** Driver-specific reference that resume() accepts, e.g. a session file. */
  session?: string;
  /** Cost of this turn alone. */
  cost: number;
  /** Paths passed to read tools, and shell commands run, for coverage. */
  reads: string[];
  commands: string[];
  /** The model call or harness failed. */
  error?: string;
}

export interface Driver {
  readonly name: string;
  /** How the agent submits its result in this harness; the engine appends it to prompts. */
  submitHint(task: DriverTask): string;
  start(task: DriverTask): Promise<Turn>;
  /** Continue the same conversation with a follow-up message. */
  resume(task: DriverTask, session: string, message: string): Promise<Turn>;
  /** Stop the turn running for a task key; that turn then returns with an error. */
  abort(key: string): Promise<void>;
  /** Release a conversation the engine is done with. */
  close(session: string): void;
  abortAll(): Promise<void>;
}

// ---- engine services used by workflows ----

export interface AgentCall<T extends TSchema> {
  /** Unique within the run; names the session directory and the agent records. */
  key: string;
  /** Models in order of preference; when one fails, the next takes over in a fresh conversation. */
  models: string[];
  /** The prompt; failures lists why earlier models failed this call. */
  prompt: (failures: string[]) => string;
  result: T;
  write: boolean;
  /**
   * Checks a schema-valid result beyond its shape. A returned problem is sent back into the same conversation,
   * up to maxRepairs times, before the model counts as failed.
   */
  verify?: (output: Static<T>) => string | undefined;
  maxRepairs?: number;
  /** Wall-clock limit for one attempt, repairs included. When it passes, the attempt is aborted and counts as failed. */
  timeoutMin?: number;
}

export interface AgentOutcome<T> {
  /** Undefined when every model failed. */
  output?: T;
  model?: string;
  session?: string;
  /** Each model that failed, and why. */
  failures: { model: string; reason: string }[];
  sessions: string[];
  /** Files read and commands run by the model that succeeded. */
  reads: string[];
  commands: string[];
  /** Cost of all attempts. */
  cost: number;
}

/** The transcript page of an agent session, relative to the report page; undefined when there is none. */
export type SessionLink = (session: string) => string | undefined;

export interface Option { label: string; consequences: string }

/** A decision only a human can make. Answered with `magi decide`. */
export interface Question {
  id: string;
  title: string;
  /** Markdown context: what was found, where. */
  detail: string;
  question: string;
  options: Option[];
  recommendation: string;
  sessions: string[];
  askedAt: string;
  answer?: { text: string; skip: boolean; at: string };
  /** The workflow has acted on the answer. */
  consumed?: boolean;
}

/** A change a human asked for with `magi request`. */
export interface Request { id: string; text: string; at: string; consumed?: boolean }

/** Something a human chose to skip; kept per repository so later runs do not raise it again. */
export interface SkipRecord { title: string; detail: string; reason: string; run: string; id: string; at: string }

export interface Ctx<D, C> {
  readonly state: RunState<D, C>;
  /** The workflow's own persisted data. */
  readonly data: D;
  readonly config: C;
  /** The target directory inside the run's worktree. */
  readonly cwd: string;
  log(message: string): void;
  save(): void;
  /**
   * Run a step once per run. The value of run() is journaled under key, then apply() folds it into the data;
   * both land in one save. After an interruption, a journaled step is not run again: its value is applied
   * if that had not happened yet. Worktree changes left by an interrupted step are discarded on resume.
   */
  step<T>(key: string, run: () => Promise<T>, apply?: (value: T) => void): Promise<T>;
  agent<T extends TSchema>(call: AgentCall<T>): Promise<AgentOutcome<Static<T>>>;
  ask(question: Omit<Question, "askedAt">): void;
  /** Answered questions the workflow has not consumed yet. */
  answers(): Question[];
  /** Requests the workflow has not consumed yet. */
  requests(): Request[];
  consume(id: string): void;
  skipped(): SkipRecord[];
}

export interface OptionSpec<C> {
  type: "string" | "boolean";
  multiple?: boolean;
  help: string;
  apply: (config: C, value: string | boolean | string[]) => void;
}

/** converged: a clean review and a clean audit. unaudited: clean reviews, but the audit could not read everything. */
export type Outcome = "converged" | "exhausted" | "unaudited";

export interface Workflow<D, C> {
  name: string;
  summary: string;
  /** Default settings for a target directory. */
  defaults(targetDir: string): C;
  /** Command-line options that adjust the settings. */
  options: Record<string, OptionSpec<C>>;
  init(config: C): D;
  /** The loop. It is re-entered from the top on resume, so it must rely on ctx.step for work already done. */
  run(ctx: Ctx<D, C>): Promise<Outcome>;
  /** Workflow-specific sections for summary.md. */
  report(state: RunState<D, C>): string;
  /** Workflow-specific HTML for the run page: a fragment of <section>s. link() gives a session's transcript, if exported. */
  html?(state: RunState<D, C>, link: SessionLink): string;
}

// ---- persisted run state ----

/** Where a run works: its own branch, checked out in its own worktree of the target repository. */
export interface Target {
  repo: string;
  /** Target directory relative to the repository root: "" or ending in "/". */
  sub: string;
  base: string;
  branch: string;
  worktree: string;
}

export interface AgentRecord {
  key: string;
  model: string;
  driver: string;
  startedAt: string;
  finishedAt?: string;
  session?: string;
  cost: number;
  turns: number;
  error?: string;
}

export interface RunState<D = unknown, C = unknown> {
  version: 2;
  workflow: string;
  id: string;
  runDir: string;
  /** Skip ledger shared by the runs on this repository. */
  ledger: string;
  createdAt: string;
  target: Target;
  driver: string;
  config: C;
  status: "running" | Outcome | "failed";
  journal: Record<string, { value: unknown; applied: boolean; at: string }>;
  /** Steps in progress, with HEAD when each started. */
  pending: Record<string, string>;
  agents: AgentRecord[];
  questions: Question[];
  requests: Request[];
  /** Inbox entries already applied to this state. */
  inboxRead: number;
  data: D;
}
