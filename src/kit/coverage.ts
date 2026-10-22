// Coverage: which text files exist, which ones agents actually read, and which to assign next.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";

/** Path (relative to the target directory) to line count. */
export type Inventory = Map<string, number>;

const EXCLUDES = [
  ":(exclude,glob)**/vendor/**",
  ":(exclude,glob)**/node_modules/**",
  ":(exclude,glob)**/testdata/**",
  ":(exclude,glob)**/*.sum",
  ":(exclude,glob)**/*-lock.json",
  ":(exclude,glob)**/*.min.*",
];

/** Tracked and untracked text files under cwd, minus vendored, generated, and lock files. */
export function inventory(cwd: string, extraExcludes: string[]): Inventory {
  const r = spawnSync("git", ["grep", "-I", "-z", "-l", "--untracked", "-e", "", "--", ".", ...EXCLUDES, ...extraExcludes], {
    cwd, encoding: "utf8", maxBuffer: 256 << 20,
  });
  if (r.status !== 0 && r.status !== 1) throw new Error(`git grep failed: ${r.stderr}`);
  const inv: Inventory = new Map();
  for (const p of r.stdout.split("\0").filter(Boolean).sort()) {
    const text = readFileSync(resolve(cwd, p), "utf8");
    inv.set(p, text.split("\n").length - (text.endsWith("\n") ? 1 : 0));
  }
  return inv;
}

// Commands whose file arguments print the file. Search tools (rg, grep) show matches only, so they do not count.
const PRINTERS = new Set(["cat", "sed", "head", "tail", "nl", "bat", "less", "more", "awk"]);

/** Inventory files that read-tool calls or file-printing shell commands touched. */
export function filesRead(cwd: string, reads: string[], commands: string[], inv: Inventory): string[] {
  const out = new Set<string>();
  const add = (p: string) => {
    const r = relative(cwd, resolve(cwd, p));
    if (!r.startsWith("..") && !isAbsolute(r) && inv.has(r)) out.add(r);
  };
  reads.forEach(add);
  for (const command of commands) {
    for (const segment of command.split(/[|;&\n]+/)) {
      const words = segment.match(/[^\s'"<>()`]+/g) ?? [];
      const [command, ...args] = words;
      if (command && PRINTERS.has(basename(command))) args.forEach(add);
    }
  }
  return [...out];
}

/** Files that stop counting toward coverage: assigned this many times and never read. */
export const MAX_MISSES = 3;

export function unread(inv: Inventory, visited: Set<string>, missed: Record<string, number>): string[] {
  return [...inv.keys()].filter((p) => !visited.has(p) && (missed[p] ?? 0) < MAX_MISSES);
}

/**
 * Split the work of one review round into `count` shards. Shard 0 gets the recently changed files, which do not
 * count toward the line budget; then unread files fill the shards in path order, so each shard stays within a
 * few directories, up to maxLines each. A shard always gets at least one unread file if any is left.
 */
export function makeShards(inv: Inventory, pending: string[], changed: string[], count: number, maxLines: number): string[][] {
  const shards: string[][] = Array.from({ length: count }, () => []);
  shards[0].push(...changed.filter((p) => inv.has(p)));
  let k = 0;
  let lines = 0;
  for (const p of pending) {
    if (shards[0].includes(p)) continue;
    const n = inv.get(p) ?? 0;
    if (lines > 0 && lines + n > maxLines) {
      if (++k === count) break;
      lines = 0;
    }
    shards[k].push(p);
    lines += n;
  }
  return shards;
}
