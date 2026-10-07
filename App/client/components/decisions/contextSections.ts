/**
 * What a labelled section of Decision context is about, read from the label
 * the employee wrote, so the card can mark it with a matching icon. Labels are
 * free text; anything unrecognized is "other" and still renders, just plainer.
 */
export type ContextSectionKind =
  | "blocked"
  | "risk"
  | "recommendation"
  | "options"
  | "timing"
  | "cost"
  | "unknowns"
  | "evidence"
  | "next"
  | "background"
  | "other";

// First match wins, so a label naming two things ("Risk if we wait") takes the
// more pressing one.
const KINDS: [ContextSectionKind, RegExp][] = [
  ["blocked", /\b(block(ed|er|ers|ing)?|stuck|halted|gated?)\b/],
  ["risk", /\b(risks?|downsides?|concerns?|caveats?|trade-?offs?|impact|stakes|consequences?)\b/],
  ["recommendation", /\b(recommend\w*|suggest\w*|propos\w*|preferred|advice)\b/],
  ["options", /\b(options?|choices?|alternatives?)\b/],
  ["timing", /\b(deadlines?|due|timing|timelines?|dates?|schedule|urgency|when)\b/],
  ["cost", /\b(costs?|price|pricing|budget|spend\w*|fees?|revenue|financials?|money)\b/],
  ["unknowns", /\b(unknowns?|missing|questions?|unclear|assumptions?|gaps?|uncertain\w*)\b/],
  [
    "evidence",
    /\b(evidence|sources?|references?|links?|verif\w*|research|findings|facts|data|records?|threads?)\b/,
  ],
  ["next", /\b(next|plan|steps?|follow-?ups?|if approved|if declined|what happens)\b/],
  [
    "background",
    /\b(what happened|background|context|situation|summary|overview|history|status)\b/,
  ],
];

export function contextSectionKind(label: string | null): ContextSectionKind {
  if (!label) return "other";
  const text = label.toLowerCase();
  return KINDS.find(([, pattern]) => pattern.test(text))?.[0] ?? "other";
}

/** Whether a label only repeats the heading it sits under ("What happened" under What happened). */
export function repeatsHeading(label: string, heading: string | undefined): boolean {
  if (!heading) return false;
  const words = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  return words(label) === words(heading);
}
