// Model rotation: spread work across models so each step gets a different perspective.

/** "provider/id:thinking" without the thinking level, to compare models. */
export const modelBase = (spec: string): string => spec.replace(/:[a-z]+$/, "");

/**
 * Models in the order to try them: the list rotated to start at index, with the models in avoid moved to the
 * end, so they are used only when nothing else is left. The first is the model for the job; the rest are
 * fallbacks when it fails.
 */
export function rotation(list: string[], index: number, avoid: string[] = []): string[] {
  const blocked = new Set(avoid.map(modelBase));
  const rotated = list.map((_, k) => list[(index + k) % list.length]);
  return [...rotated.filter((m) => !blocked.has(modelBase(m))), ...rotated.filter((m) => blocked.has(modelBase(m)))];
}
