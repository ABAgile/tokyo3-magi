// Driver: pi in-process through its SDK. Conversations stay open between turns, so repairs keep full context.
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { Driver, DriverTask, Turn } from "../engine/types.ts";
import { SUBMIT_HINT, SUBMIT_TOOL, submitTool } from "./pi-submit.ts";

export const READ_TOOLS = ["read", "bash", "grep", "find", "ls"];
export const WRITE_TOOLS = [...READ_TOOLS, "edit", "write"];

interface Conversation {
  session: AgentSession;
  /** Cumulative cost already reported in earlier turns. */
  reported: number;
  reads: string[];
  commands: string[];
}

export class PiSdkDriver implements Driver {
  readonly name = "pi-sdk";
  #runtime?: ModelRuntime;
  readonly #open = new Map<string, Conversation>();

  submitHint(): string {
    return SUBMIT_HINT;
  }

  async start(task: DriverTask): Promise<Turn> {
    this.#runtime ??= await ModelRuntime.create();
    const resolved = resolveCliModel({ cliModel: task.model, modelRuntime: this.#runtime });
    if (!resolved.model) return { cost: 0, reads: [], commands: [], error: resolved.error ?? `unknown model ${task.model}` };
    const resourceLoader = new DefaultResourceLoader({ cwd: task.cwd, agentDir: getAgentDir() });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: task.cwd,
      modelRuntime: this.#runtime,
      model: resolved.model,
      thinkingLevel: resolved.thinkingLevel,
      resourceLoader,
      tools: [...(task.write ? WRITE_TOOLS : READ_TOOLS), SUBMIT_TOOL],
      customTools: [submitTool(task.resultFile, task.resultSchema)],
      sessionManager: SessionManager.create(task.cwd, task.sessionDir),
    });
    const conv: Conversation = { session, reported: 0, reads: [], commands: [] };
    session.subscribe((e) => {
      if (e.type !== "tool_execution_start") return;
      if (e.toolName === "read" && typeof e.args?.path === "string") conv.reads.push(e.args.path);
      if (e.toolName === "bash" && typeof e.args?.command === "string") conv.commands.push(e.args.command);
    });
    const ref = session.sessionFile ?? `memory:${task.key}:${Date.now()}`;
    this.#open.set(ref, conv);
    return this.#turn(ref, conv, task.prompt);
  }

  async resume(_task: DriverTask, ref: string, message: string): Promise<Turn> {
    const conv = this.#open.get(ref);
    if (!conv) return { cost: 0, reads: [], commands: [], error: `conversation ${ref} is closed` };
    return this.#turn(ref, conv, message);
  }

  async #turn(ref: string, conv: Conversation, message: string): Promise<Turn> {
    conv.reads = [];
    conv.commands = [];
    let error: string | undefined;
    try {
      await conv.session.prompt(message);
      error = lastFailure(conv.session);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const total = conv.session.getSessionStats().cost;
    const cost = total - conv.reported;
    conv.reported = total;
    return { session: ref, cost, reads: conv.reads, commands: conv.commands, error };
  }

  close(ref: string): void {
    this.#open.get(ref)?.session.dispose();
    this.#open.delete(ref);
  }

  async abortAll(): Promise<void> {
    await Promise.all([...this.#open.values()].map((c) => c.session.abort()));
  }
}

function lastFailure(session: AgentSession): string | undefined {
  const last = session.messages.findLast((m) => m.role === "assistant");
  if (!last || last.role !== "assistant") return "the model produced no reply";
  if (last.stopReason === "error" || last.stopReason === "aborted") return last.errorMessage ?? last.stopReason;
  return undefined;
}
