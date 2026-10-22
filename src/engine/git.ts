// Git and shell helpers. The engine owns the run's worktree; workflows that change code use these too.
import { execFileSync, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function git(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", args, { cwd, input, encoding: "utf8", maxBuffer: 512 << 20, stdio: ["pipe", "pipe", "pipe"] });
}

export const head = (cwd: string): string => git(cwd, ["rev-parse", "HEAD"]).trim();
export const isDirty = (cwd: string): boolean => git(cwd, ["status", "--porcelain"]).trim() !== "";

/** Drop every uncommitted change, untracked files included (ignored files stay). */
export function discard(cwd: string): void {
  git(cwd, ["reset", "-q", "--hard"]);
  git(cwd, ["clean", "-fdq"]);
}

/** Put the worktree back at commit, dropping later commits and uncommitted changes. */
export function resetTo(cwd: string, commit: string): void {
  git(cwd, ["reset", "-q", "--hard", commit]);
  git(cwd, ["clean", "-fdq"]);
}

/** Uncommitted changed paths, relative to the repository root. */
export function changedFiles(wt: string): string[] {
  const out = git(wt, ["ls-files", "-z", "--modified", "--others", "--deleted", "--exclude-standard", "--full-name"]);
  return [...new Set(out.split("\0").filter(Boolean))].sort();
}

/** Paths changed between two commits, relative to the repository root. */
export function diffFiles(wt: string, from: string, to: string): string[] {
  return git(wt, ["diff", "--name-only", "-z", "--no-renames", from, to]).split("\0").filter(Boolean);
}

/** The tree object of the working tree as it is now, untracked files included, without touching the index. */
export function treeOf(wt: string): string {
  const index = join(tmpdir(), `magi-index-${process.pid}-${Date.now()}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    execFileSync("git", ["read-tree", "HEAD"], { cwd: wt, env });
    execFileSync("git", ["add", "-A"], { cwd: wt, env });
    return execFileSync("git", ["write-tree"], { cwd: wt, env, encoding: "utf8" }).trim();
  } finally {
    rmSync(index, { force: true });
  }
}

/** Commit every change; undefined when there is nothing to commit. */
export function commitAll(wt: string, message: string): string | undefined {
  git(wt, ["add", "-A"]);
  if (spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: wt }).status === 0) return undefined;
  git(wt, ["commit", "-q", "--no-verify", "-F", "-"], message);
  return head(wt);
}

export interface ShellResult { ok: boolean; output: string }

/** Run a shell command; output keeps the last 80 lines. */
export function runShell(cwd: string, command: string, timeoutSec: number): ShellResult {
  const r = spawnSync("bash", ["-c", command], { cwd, encoding: "utf8", timeout: timeoutSec * 1000, maxBuffer: 256 << 20 });
  const all = `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? `\n${r.error.message}` : ""}`;
  return { ok: r.status === 0, output: all.trimEnd().split("\n").slice(-80).join("\n") };
}
