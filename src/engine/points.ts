// Break a paragraph into short points for reading: one per sentence, and numbered items such as "(1) ... (2) ..."
// each become their own point. The text itself is kept as written.
const SENTENCE = /(?<=[.!?])\s+(?=[A-Z0-9(`"'[])/;
const NUMBERED = /\s+(?=\(\d\)\s)/;

export function toPoints(text: string): string[] {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return [];
  const points: string[] = [];
  for (const sentence of flat.split(SENTENCE)) {
    const pieces = sentence.split(NUMBERED).map((p) => p.trim()).filter(Boolean);
    points.push(...pieces);
  }
  return points;
}
