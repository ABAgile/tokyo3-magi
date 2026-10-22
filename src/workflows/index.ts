// Workflow registry. A new loop lives in its own folder under workflows/ and is added here.
import type { Workflow } from "../engine/types.ts";
import { codeReview } from "./code-review/workflow.ts";

export const workflows: Record<string, Workflow<any, any>> = {
  [codeReview.name]: codeReview,
};
