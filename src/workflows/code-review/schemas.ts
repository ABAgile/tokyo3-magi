// What each agent submits. The schemas are shown to the agent and validated by the engine; field descriptions
// are part of the instructions.
import { type Static, Type } from "typebox";

const Site = Type.Object({
  path: Type.String({ description: "File path relative to the working directory" }),
  line: Type.Optional(Type.Integer({ minimum: 1 })),
  note: Type.Optional(Type.String({ description: "What is at this site, when it differs from the others" })),
});
const Option = Type.Object({
  label: Type.String({ description: "The option, as an instruction a fixer could follow" }),
  consequences: Type.String({ description: "What it changes, breaks, or costs" }),
});

export const ReviewSchema = Type.Object({
  findings: Type.Array(
    Type.Object({
      severity: Type.Union([Type.Literal("critical"), Type.Literal("important")]),
      title: Type.String({ description: "Short title naming the defect" }),
      sites: Type.Array(Site, { minItems: 1, description: "Every site of this defect, not a sample" }),
      impact: Type.String({ description: "What goes wrong, and for whom" }),
      reasoning: Type.String({ description: "Why the code does this, with the evidence" }),
      fix: Type.String({ description: "The change, and the test that would catch the defect" }),
    }),
    { description: "One entry per distinct defect; empty when there is none" },
  ),
  not_covered: Type.Optional(Type.Array(Type.String(), { description: "Assigned files you could not read" })),
});
export type ReviewResult = Static<typeof ReviewSchema>;

export const PatternSchema = Type.Object({
  patterns: Type.Array(
    Type.Object({
      change: Type.Union([Type.Literal("mechanical"), Type.Literal("needs-decision")], {
        description: "mechanical: behavior-preserving and safe to apply now. needs-decision: changes a public API, behavior, or package layout, or has a real tradeoff",
      }),
      title: Type.String(),
      sites: Type.Array(Site, { minItems: 2, description: "Every occurrence; note any site that must stay separate, and why" }),
      pattern: Type.String({ description: "What repeats, and how the variants differ" }),
      interface: Type.String({ description: "The smallest set of types, functions, or methods, with signatures, that serves every site; where it lives; what stays at the call sites" }),
      migration: Type.String({ description: "Ordered steps that keep behavior identical, and the tests that prove it" }),
      payoff: Type.String({ description: "Code and branches removed, and the drift or bugs it prevents" }),
      options: Type.Optional(Type.Array(Option, { minItems: 2, description: "needs-decision: the choices a human has" })),
      recommendation: Type.Optional(Type.String({ description: "needs-decision: the option you would pick, and why" })),
    }),
    { description: "One entry per pattern; empty when there is none" },
  ),
});
export type PatternResult = Static<typeof PatternSchema>;

export const ResolutionSchema = Type.Object({
  status: Type.Union([Type.Literal("fixed"), Type.Literal("rejected"), Type.Literal("deferred"), Type.Literal("duplicate")]),
  reason: Type.String({ description: "fixed: what changed and how it was verified. rejected: why the finding is wrong or not worth it. deferred: why a human must decide" }),
  commit_subject: Type.Optional(Type.String({ maxLength: 72, description: "fixed: imperative, effect-oriented subject, at most 72 characters" })),
  commit_body: Type.Optional(Type.String({ description: "fixed: why, and the behavior change, wrapped at 72 columns. No finding IDs or round labels" })),
  also_resolves: Type.Optional(Type.Array(Type.String(), { description: "IDs of other open findings this change fully resolves" })),
  duplicate_of: Type.Optional(Type.String()),
  question: Type.Optional(Type.String({ description: "deferred: the question a human must answer" })),
  options: Type.Optional(Type.Array(Option, { minItems: 2 })),
  recommendation: Type.Optional(Type.String({ description: "deferred: the option you would pick, and why" })),
});
export type Resolution = Static<typeof ResolutionSchema>;
