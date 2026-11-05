/** Small decisions the widget makes, kept apart from React so they can be tested. */

const LINK = /(https?:\/\/[^\s<>"')]+[^\s<>"').,;:!?])/g;

export type TextPart = { kind: "text" | "link"; value: string };

/**
 * A message as plain words and web links. It stays text: nothing a person or a model
 * wrote is ever read as markup here, and only `http(s)` becomes a link.
 */
export function textParts(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(LINK)) {
    const start = match.index ?? 0;
    if (start > last) parts.push({ kind: "text", value: text.slice(last, start) });
    parts.push({ kind: "link", value: match[0] });
    last = start + match[0].length;
  }
  if (last < text.length) parts.push({ kind: "text", value: text.slice(last) });
  return parts;
}

/** How long to wait before looking for replies again. */
export function pollDelayMs(args: { open: boolean; failures: number }): number {
  if (args.failures > 0) return Math.min(60_000, 3_000 * 2 ** args.failures);
  return args.open ? 3_000 : 30_000;
}
