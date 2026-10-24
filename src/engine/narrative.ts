// The agent-written summary of a run's report, cached in the report folder. The cache holds a fingerprint of the
// prompt the summary was written from, so a summary is written again only when the run's facts or the prompt change.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Narrative } from "./types.ts";

export interface CachedNarrative { fingerprint: string; narrative: Narrative }

const fileOf = (runDir: string): string => join(runDir, "report", "narrative.json");

export const fingerprint = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The last written summary, whatever the run has done since; undefined when none was written or the file is damaged. */
export function readNarrative(runDir: string): CachedNarrative | undefined {
  const file = fileOf(runDir);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as CachedNarrative;
  } catch {
    return undefined;
  }
}

export function writeNarrative(runDir: string, cached: CachedNarrative): void {
  const file = fileOf(runDir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cached, null, 2) + "\n");
}
