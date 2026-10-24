// Command line. Run it through bin/magi, which sets NODE_USE_ENV_PROXY so the pi SDK honors HTTPS_PROXY.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { createDriver, drivers } from "./drivers/index.ts";
import { answerInteractively, applyInbox, queueAnswer, queueRequest } from "./engine/inbox.ts";
import { writeHtmlReport } from "./engine/html.ts";
import { writeReports } from "./engine/report.ts";
import { loadState, Run, saveState } from "./engine/run.ts";
import { cleanRun, findRunDir, formatRuns, runsOfRepo, runsUnder, summarize } from "./engine/runs.ts";
import type { RunState, Workflow } from "./engine/types.ts";
import { createRunState, lock, tryLock } from "./engine/workspace.ts";
import { describeSettings, DEFAULT_DRIVER, initSettings, loadSettings, resolveRunsRoot, workflowConfig } from "./settings.ts";
import { workflows } from "./workflows/index.ts";

const HOME = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(HOME, "bin", "magi");
const SETTINGS = join(HOME, "config.json");

const USAGE = `magi: agent loops that iterate until the work converges.

  magi run <workflow> <dir> [options]   start a run on the git repository (or subdirectory) at <dir>
  magi resume <run dir> [options]       continue: after an interruption, answers, or requests
  magi decide <run dir>                 answer open questions interactively
  magi decide <run dir> <ID> <answer>   answer one: an option number, an instruction, or "skip: <reason>"
  magi request <run dir> <text>         ask for a change; resume the run to apply it
  magi status <run dir>                 print the summary
  magi report <run dir> [--no-sessions] write report/index.html: timeline, findings, commits, and a
                                        transcript of each agent session (--no-sessions skips transcripts)
  magi list [<dir>]                     list runs: all of them, or those on the repository at <dir>
  magi clean <run dir>... [--force]     remove runs: worktree, run directory, and their branches if merged;
                                        --force also deletes unmerged branches and uncommitted changes
  magi config [init]                    show the settings in effect, with where each comes from;
                                        "init" writes config.json with the built-in defaults
  magi help [workflow]                  this text, or a workflow's options

A <run dir> is a path, or a name relative to the runs directory as shown by magi list.

Options for every workflow:
  --driver NAME     agent harness: ${Object.keys(drivers).join(", ")} (default pi-sdk)
  --runs-dir DIR    where runs live: runs/<repo>/<workflow>-<stamp>/ (default: $MAGI_RUNS,
                    else runsDir in config.json, else ${join(HOME, "runs")})

Workflows:
${Object.values(workflows).map((w) => `  ${w.name.padEnd(16)}${w.summary}`).join("\n")}

Defaults can be overridden in ${SETTINGS}:
  { "driver": "...", "runsDir": "...", "<workflow>": { ...settings } }
Run "magi config" to see the values in effect.
Exit status: 0 converged, 1 stopped at the round limit, 2 error, 130 interrupted.`;

const COMMON = {
  driver: { type: "string" },
  "runs-dir": { type: "string" },
  force: { type: "boolean" },
  "no-sessions": { type: "boolean" },
  help: { type: "boolean", short: "h" },
} satisfies ParseArgsOptionsConfig;

function workflowHelp(w: Workflow<any, any>): string {
  return `magi run ${w.name} <dir>: ${w.summary}\n\nOptions:\n${Object.entries(w.options).map(([k, o]) => `  --${k.padEnd(20)}${o.help}`).join("\n")}`;
}

function getWorkflow(name: string): Workflow<any, any> {
  const w = workflows[name];
  if (!w) throw new Error(`unknown workflow ${name}; known: ${Object.keys(workflows).join(", ")}`);
  return w;
}

function runsRoot(values: Record<string, unknown>): string {
  return resolveRunsRoot(loadSettings(SETTINGS), HOME, process.env, values["runs-dir"] as string | undefined).path;
}

/** Every option of every workflow, so the command line parses strictly before the workflow is known. */
function optionSpec(): ParseArgsOptionsConfig {
  const spec: ParseArgsOptionsConfig = { ...COMMON };
  for (const w of Object.values(workflows)) for (const [k, o] of Object.entries(w.options)) spec[k] = { type: o.type, multiple: o.multiple ?? false };
  return spec;
}

/** Apply the given options to a workflow's config; options of other workflows are an error. */
function applyOptions(w: Workflow<any, any>, values: Record<string, unknown>, config: any): void {
  for (const k of Object.keys(values)) {
    if (k === "force" || (!(k in COMMON) && !(k in w.options))) throw new Error(`--${k} is not an option of ${w.name}`);
  }
  for (const [k, o] of Object.entries(w.options)) if (values[k] !== undefined) o.apply(config, values[k] as never);
}

function open(arg: string, values: Record<string, unknown>) {
  const state = loadState(findRunDir(arg, runsRoot(values)));
  return { state, workflow: getWorkflow(state.workflow) };
}

/**
 * Apply queued answers and requests now, when no loop is running on the run. A running loop takes them in itself,
 * so the state file is never written by two processes. Returns whether the run was stopped.
 */
function applyWhenIdle(runDir: string, workflow: Workflow<any, any>): boolean {
  const unlock = tryLock(runDir);
  if (!unlock) return false;
  try {
    const state = loadState(runDir);
    if (applyInbox(runDir, state)) saveState(state);
    writeReports(state, workflow, CLI);
    return true;
  } finally {
    unlock();
  }
}

async function drive(state: RunState, workflow: Workflow<any, any>): Promise<number> {
  const unlock = lock(state.runDir);
  const driver = createDriver(state.driver);
  const run = new Run(state, { driver, onSave: (s) => writeReports(s, workflow, CLI) });
  let stopping = false;
  process.on("SIGINT", () => {
    if (stopping) process.exit(130);
    stopping = true;
    run.log(`interrupted; resume with: ${CLI} resume ${state.runDir}`);
    void driver.abortAll().finally(() => {
      unlock();
      process.exit(130);
    });
  });
  try {
    run.log(`${workflow.name} run ${state.runDir}`);
    run.log(`branch ${state.target.branch} in ${state.target.worktree}; driver ${state.driver}`);
    const outcome = await run.execute(workflow);
    const open = state.questions.filter((q) => !q.answer).length;
    run.log(`${outcome}; summary: ${join(state.runDir, "summary.md")}`);
    if (open) run.log(`${open} question(s) await your decision: ${CLI} decide ${state.runDir}, then ${CLI} resume ${state.runDir}`);
    return outcome === "converged" ? 0 : 1;
  } catch (err) {
    state.status = "failed";
    run.save();
    run.log(`error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    run.log(`resume with: ${CLI} resume ${state.runDir}`);
    return 2;
  } finally {
    unlock();
  }
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, options: optionSpec(), allowPositionals: true });
  const [command, arg, ...rest] = positionals;
  if (!command || command === "help" || values.help) {
    console.log(arg && workflows[arg] ? workflowHelp(workflows[arg]) : USAGE);
    return command ? 0 : 2;
  }
  if (values.force && command !== "clean") throw new Error("--force is only for magi clean");
  if (values["no-sessions"] && command !== "report") throw new Error("--no-sessions is only for magi report");
  if (command === "list") {
    const root = runsRoot(values);
    console.log(formatRuns((arg ? runsOfRepo(arg, root) : runsUnder(root)).map(summarize), root));
    return 0;
  }
  if (command === "config") {
    if (arg === "init") {
      initSettings(SETTINGS, Object.values(workflows));
      console.log(`wrote ${SETTINGS} with the built-in defaults; edit it to change them.`);
      console.log("The check command is left out: it is detected from each target repository (e.g. Go projects).");
      return 0;
    }
    if (arg) throw new Error(`unknown config command ${arg}; use "magi config" or "magi config init"`);
    console.log(describeSettings({
      file: SETTINGS, settings: loadSettings(SETTINGS), home: HOME, env: process.env, cwd: process.cwd(),
      runsFlag: values["runs-dir"] as string | undefined, workflows: Object.values(workflows),
    }));
    return 0;
  }
  if (!arg) throw new Error(`${command} needs an argument\n\n${USAGE}`);
  switch (command) {
    case "run": {
      const workflow = getWorkflow(arg);
      const dir = rest[0];
      if (!dir) throw new Error(`run needs a directory: magi run ${workflow.name} <dir>`);
      const settings = loadSettings(SETTINGS);
      const config = workflowConfig(workflow, dir, settings);
      applyOptions(workflow, values, config);
      const state = createRunState({
        workflow, config, targetDir: dir,
        runsRoot: runsRoot(values),
        driver: (values.driver as string) ?? settings.driver ?? DEFAULT_DRIVER,
      });
      createDriver(state.driver);
      saveState(state);
      return drive(state, workflow);
    }
    case "resume": {
      const { state, workflow } = open(arg, values);
      applyOptions(workflow, values, state.config);
      if (values.driver) state.driver = values.driver as string;
      return drive(state, workflow);
    }
    case "decide": {
      const r = open(arg, values);
      if (rest.length >= 2) console.log(queueAnswer(r.state.runDir, r.state, rest[0], rest.slice(1).join(" ")));
      else await answerInteractively(r.state.runDir, r.state);
      console.log(applyWhenIdle(r.state.runDir, r.workflow)
        ? `The run is stopped, so the answer${rest.length >= 2 ? "" : "s"} took effect now; resume the run to act on ${rest.length >= 2 ? "it" : "them"}.`
        : "The run is active: it takes answers in after its current fix.");
      return 0;
    }
    case "request": {
      const r = open(arg, values);
      const text = rest.join(" ").trim();
      if (!text) throw new Error("request needs the change to make");
      const id = queueRequest(r.state.runDir, text);
      console.log(`recorded ${id}; ${applyWhenIdle(r.state.runDir, r.workflow) ? "the run is stopped: resume it to apply the request" : "the active run takes it in after its current fix"}`);
      return 0;
    }
    case "report": {
      const r = open(arg, values);
      console.log(writeHtmlReport(r.state, r.workflow, { sessions: values["no-sessions"] !== true, pi: process.env.MAGI_PI_BIN ?? "pi" }));
      return 0;
    }
    case "status": {
      const r = open(arg, values);
      writeReports(r.state, r.workflow, CLI);
      console.log(readFileSync(join(r.state.runDir, "summary.md"), "utf8"));
      return 0;
    }
    case "clean": {
      let failed = 0;
      for (const name of [arg, ...rest]) {
        try {
          for (const line of cleanRun(findRunDir(name, runsRoot(values)), values.force === true)) console.log(line);
        } catch (err) {
          failed++;
          console.error(`${name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return failed ? 2 : 0;
    }
    default:
      throw new Error(`unknown command ${command}\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  },
);
