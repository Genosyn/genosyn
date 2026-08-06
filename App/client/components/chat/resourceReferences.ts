import type { CompanySearchResult } from "../../lib/api";

export type ChatResourceReference = CompanySearchResult;

/**
 * Find the active `#query` immediately before the caret. Spaces are allowed so
 * `#quarterly plan` searches the same way as the global palette. A selected
 * reference becomes a Markdown link, whose `#` lives inside `[...]`; that
 * means it cannot accidentally reopen the picker on the following keystroke.
 */
export function resourceQueryAtCaret(
  value: string,
  caret: number,
): { query: string; start: number } | null {
  const before = value.slice(0, caret);
  const match = /(^|[\s(])#([^#\n]{0,120})$/.exec(before);
  if (!match) return null;
  const start = before.length - match[2].length - 1;
  return { query: match[2], start };
}

/** Insert a readable, clickable resource tag while preserving the tail. */
export function insertResourceReference(args: {
  value: string;
  caret: number;
  start: number;
  companySlug: string;
  reference: ChatResourceReference;
}): { value: string; caret: number } {
  const label = args.reference.label.startsWith("#")
    ? args.reference.label
    : `#${args.reference.label}`;
  const safeLabel = label.replaceAll("\\", "\\\\").replaceAll("]", "\\]");
  const tag = `[${safeLabel}](/c/${args.companySlug}${args.reference.path})`;
  const before = args.value.slice(0, args.start);
  const after = args.value.slice(args.caret);
  const separator = after.startsWith(" ") ? "" : " ";
  const next = `${before}${tag}${separator}${after}`;
  return { value: next, caret: before.length + tag.length + separator.length };
}
