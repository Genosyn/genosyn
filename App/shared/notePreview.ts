/**
 * A note's Markdown as a line of plain text — what the Notes sidebar, the
 * notebook page and search results show under a title. Shared so the server
 * can send a preview instead of every page's whole body.
 */

/** Markdown reduced to readable text: syntax dropped, whitespace collapsed. */
export function notePlainText(markdown: string): string {
  return markdown
    .replace(/\r\n?/g, "\n")
    .replace(/^(?:```|~~~)[^\n]*$/gm, " ")
    .replace(/<\/?(?:details|summary)[^>]*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>\n]+>/g, " ")
    .replace(/^\s{0,3}>\s?\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/gim, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s+\[[ xX]\]\s+/gm, "")
    .replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gm, " ")
    .replace(/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/gm, " ")
    .replace(/\|/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(\*|_)(.+?)\1/g, "$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/\\([!-/:-@[-`{-~])/g, "$1")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** The first `max` characters of a note's text, cut at a word. */
export function notePreview(markdown: string, max = 160): string {
  const text = notePlainText(markdown);
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The stretch of a note's text around the first word of `query` it contains. */
export function noteSnippet(markdown: string, query: string, max = 160): string {
  const text = notePlainText(markdown);
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const lower = text.toLowerCase();
  let at = -1;
  for (const word of words) {
    const i = lower.indexOf(word);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0 || text.length <= max) return notePreview(markdown, max);
  const start = Math.max(0, at - Math.floor(max / 3));
  const end = Math.min(text.length, start + max);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}
