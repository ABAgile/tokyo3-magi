// Driver registry. A new harness (Claude Code, Codex, ...) implements Driver from engine/types.ts and is added here.
import type { Driver } from "../engine/types.ts";
import { PiCliDriver } from "./pi-cli.ts";
import { PiSdkDriver } from "./pi-sdk.ts";

export const drivers: Record<string, () => Driver> = {
  "pi-sdk": () => new PiSdkDriver(),
  "pi-cli": () => new PiCliDriver(),
};

export function createDriver(name: string): Driver {
  const make = drivers[name];
  if (!make) throw new Error(`unknown driver ${name}; known: ${Object.keys(drivers).join(", ")}`);
  return make();
}
