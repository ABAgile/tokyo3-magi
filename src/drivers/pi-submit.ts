// The submit_result tool through which pi agents hand in their result. Used two ways:
//   pi-sdk: submitTool() is passed to the in-process session as a custom tool.
//   pi-cli: this file is loaded with `pi -e`; the default export registers the tool from MAGI_RESULT_FILE and
//           MAGI_RESULT_SCHEMA. Keep it free of runtime imports other than node builtins.
import { readFileSync, writeFileSync } from "node:fs";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

export const SUBMIT_TOOL = "submit_result";
export const SUBMIT_HINT =
  "When your work is complete, call submit_result once with your result. If the reply says it was not accepted, fix what it says and call submit_result again.";

export function submitTool(resultFile: string, schema: object): ToolDefinition<any, any> {
  return {
    name: SUBMIT_TOOL,
    label: "Submit result",
    description: "Submit the final result of your task. Call it once, when the work is complete.",
    parameters: schema as ToolDefinition["parameters"],
    execute: async (_id, params) => {
      writeFileSync(resultFile, JSON.stringify(params, null, 2));
      return { content: [{ type: "text", text: "Submitted. Stop here unless you are asked to change it." }], details: {} };
    },
  };
}

export default function magiSubmit(pi: ExtensionAPI): void {
  const file = process.env.MAGI_RESULT_FILE;
  const schema = process.env.MAGI_RESULT_SCHEMA;
  if (file && schema) pi.registerTool(submitTool(file, JSON.parse(readFileSync(schema, "utf8"))));
}
