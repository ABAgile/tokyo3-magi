// Settings in <magi>/config.json: defaults for new runs. The file is optional, and only `magi config init`
// writes it. A run reads it once, when it starts, and keeps the result in its state, so editing the file does
// not change a run already under way. Command-line flags come on top.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { drivers } from "./drivers/index.ts";
import type { Workflow } from "./engine/types.ts";

export const DEFAULT_DRIVER = "pi-sdk";
/** Relative to magi's own folder, like the other paths in config.json. */
export const DEFAULT_RUNS_DIR = "runs";
const TOP_LEVEL = ["driver", "runsDir"];

export type Settings = Record<string, any>;

export function loadSettings(file: string): Settings {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** A workflow's configuration for targetDir: its built-in defaults, with the file's values on top. */
export function workflowConfig(w: Workflow<any, any>, targetDir: string, settings: Settings): any {
  const config = w.defaults(resolve(targetDir));
  const over = settings[w.name] ?? {};
  return Object.assign(config, over, { models: { ...config.models, ...over.models } });
}

/** Where runs live: --runs-dir, else $MAGI_RUNS, else runsDir in the file, else the built-in folder. */
export function resolveRunsRoot(settings: Settings, home: string, env: NodeJS.ProcessEnv, flag?: string): { path: string; source: string } {
  if (flag) return { path: resolve(flag), source: "--runs-dir" };
  if (env.MAGI_RUNS) return { path: resolve(env.MAGI_RUNS), source: "$MAGI_RUNS" };
  if (settings.runsDir) return { path: resolve(home, settings.runsDir), source: "config.json" };
  return { path: join(home, DEFAULT_RUNS_DIR), source: "built-in" };
}

/** Entries that would otherwise be silently ignored: unknown keys, model roles, and drivers. */
export function settingsProblems(settings: Settings, workflows: Workflow<any, any>[]): string[] {
  const out: string[] = [];
  const byName = new Map(workflows.map((w) => [w.name, w]));
  if (settings.driver !== undefined && !(settings.driver in drivers)) out.push(`unknown driver "${settings.driver}"`);
  for (const key of Object.keys(settings)) {
    if (TOP_LEVEL.includes(key)) continue;
    const w = byName.get(key);
    if (!w) {
      out.push(`unknown key "${key}": not a setting and not a workflow name`);
      continue;
    }
    const defaults = w.defaults(".");
    for (const sub of Object.keys(settings[key] ?? {})) {
      if (!(sub in defaults)) out.push(`unknown ${key} setting "${sub}"`);
      if (sub === "models") {
        for (const role of Object.keys(settings[key].models ?? {})) {
          if (!(role in (defaults.models ?? {}))) out.push(`unknown model role "${role}" in ${key}`);
        }
      }
    }
  }
  return out;
}

/**
 * Write a starter config.json with the built-in defaults; refuses to overwrite one. The check command is left
 * out on purpose: its default depends on each target repository, and a global value would override that.
 */
export function initSettings(file: string, workflows: Workflow<any, any>[]): void {
  if (existsSync(file)) throw new Error(`${file} already exists; edit it, or remove it to start over`);
  const out: Settings = { driver: DEFAULT_DRIVER, runsDir: DEFAULT_RUNS_DIR };
  for (const w of workflows) out[w.name] = { ...w.defaults("."), check: undefined };
  writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
}

/** Every value that applies to cwd, each with where it comes from, and any problems with the file. */
export function describeSettings(o: {
  file: string;
  settings: Settings;
  home: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  runsFlag?: string;
  workflows: Workflow<any, any>[];
}): string {
  const s = o.settings;
  const from = (given: boolean) => (given ? "config.json" : "built-in");
  const runs = resolveRunsRoot(s, o.home, o.env, o.runsFlag);
  const out = [
    existsSync(o.file) ? `config file: ${o.file}` : `config file: ${o.file} (not present: built-in values apply; create it with \`magi config init\`)`,
    "",
    `driver: ${s.driver ?? DEFAULT_DRIVER} (${from(s.driver !== undefined)})`,
    `runsDir: ${runs.path} (${runs.source})`,
  ];
  for (const w of o.workflows) {
    const defaults = w.defaults(o.cwd);
    const over = s[w.name] ?? {};
    out.push("", `${w.name} (values for ${o.cwd}):`);
    for (const [key, value] of Object.entries(defaults)) {
      if (key === "models") {
        for (const [role, list] of Object.entries(value as Record<string, string[]>)) {
          const given = over.models?.[role] !== undefined;
          out.push(`  models.${role}: ${JSON.stringify(given ? over.models[role] : list)} (${from(given)})`);
        }
        continue;
      }
      const given = over[key] !== undefined;
      const source = key === "check" && !given ? "built-in, detected per target" : from(given);
      out.push(`  ${key}: ${JSON.stringify(given ? over[key] : value)} (${source})`);
    }
  }
  const problems = settingsProblems(s, o.workflows);
  if (problems.length) out.push("", "warnings:", ...problems.map((p) => `  ${p}`));
  return out.join("\n");
}
