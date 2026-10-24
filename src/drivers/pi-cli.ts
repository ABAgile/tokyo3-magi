// Driver: the pi command line, one process per turn (`pi -p --mode json`), resumed with `--session <file>`.
// Slower than the SDK driver, but it shows the shape of any subprocess harness: build the command, read the
// JSON event stream for cost and tool calls, find the session to resume.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { Driver, DriverTask, Turn } from "../engine/types.ts";
import { READ_TOOLS, WRITE_TOOLS } from "./pi-sdk.ts";
import { SUBMIT_HINT, SUBMIT_TOOL } from "./pi-submit.ts";

const EXTENSION = fileURLToPath(new URL("./pi-submit.ts", import.meta.url));

export class PiCliDriver implements Driver {
  readonly name = "pi-cli";
  readonly #bin: string;
  readonly #running = new Map<string, ChildProcess>();

  constructor(bin = process.env.MAGI_PI_BIN ?? "pi") {
    this.#bin = bin;
  }

  submitHint(): string {
    return SUBMIT_HINT;
  }

  start(task: DriverTask): Promise<Turn> {
    mkdirSync(task.sessionDir, { recursive: true });
    return this.#exec(task, ["--session-dir", task.sessionDir], task.prompt);
  }

  resume(task: DriverTask, session: string, message: string): Promise<Turn> {
    return this.#exec(task, ["--session", session], message);
  }

  close(): void {}

  async abort(key: string): Promise<void> {
    this.#running.get(key)?.kill("SIGTERM");
  }

  async abortAll(): Promise<void> {
    for (const child of this.#running.values()) child.kill("SIGTERM");
  }

  #exec(task: DriverTask, sessionArgs: string[], message: string): Promise<Turn> {
    const schemaFile = `${task.resultFile}.schema.json`;
    writeFileSync(schemaFile, JSON.stringify(task.resultSchema));
    const tools = [...(task.write ? WRITE_TOOLS : READ_TOOLS), SUBMIT_TOOL].join(",");
    const args = ["-p", "--mode", "json", ...sessionArgs, "--model", task.model, "--tools", tools, "-e", EXTENSION, "--", message];
    const child = spawn(this.#bin, args, {
      cwd: task.cwd,
      env: { ...process.env, MAGI_RESULT_FILE: task.resultFile, MAGI_RESULT_SCHEMA: schemaFile },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.#running.set(task.key, child);
    const turn: Turn = { cost: 0, reads: [], commands: [] };
    let sessionId = "";
    let lastAssistant: { stopReason?: string; errorMessage?: string } | undefined;
    let stderr = "";
    child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
    createInterface({ input: child.stdout }).on("line", (line) => {
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        return;
      }
      if (e.type === "session") sessionId = e.id;
      if (e.type === "tool_execution_start" && e.toolName === "read" && typeof e.args?.path === "string") turn.reads.push(e.args.path);
      if (e.type === "tool_execution_start" && e.toolName === "bash" && typeof e.args?.command === "string") turn.commands.push(e.args.command);
      if (e.type === "message_end" && e.message?.role === "assistant") {
        turn.cost += e.message.usage?.cost?.total ?? 0;
        lastAssistant = e.message;
      }
    });
    return new Promise((done) => {
      child.on("close", (code) => {
        this.#running.delete(task.key);
        turn.session = sessionArgs[0] === "--session" ? sessionArgs[1] : findSession(task.sessionDir, sessionId);
        if (code !== 0) turn.error = `pi exited with ${code}: ${stderr.trim().split("\n").slice(-3).join(" ")}`;
        else if (!lastAssistant) turn.error = "the model produced no reply";
        else if (lastAssistant.stopReason === "error" || lastAssistant.stopReason === "aborted") {
          turn.error = lastAssistant.errorMessage ?? lastAssistant.stopReason;
        }
        done(turn);
      });
    });
  }
}

function findSession(dir: string, id: string): string | undefined {
  const file = id ? readdirSync(dir).find((f) => f.endsWith(".jsonl") && f.includes(id)) : undefined;
  return file ? join(dir, file) : undefined;
}
