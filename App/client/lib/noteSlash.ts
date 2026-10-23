/**
 * The Notes editor's `/` menu: what it offers and how a typed query narrows
 * it. Ranking reuses the ⌘K palette's text matching, so `/h2`, `/head`,
 * `/todo` and `/bl` (bulleted list's initials) all land where you expect.
 */

import {
  foldSearchText,
  isWordAnchoredSubsequence,
  MATCH_SCORE,
  matchesInitials,
  matchKeywords,
  matchLabelText,
} from "./searchText.js";
import type { BlockKind } from "./noteBlocks.js";

export type SlashCommandId = BlockKind | "divider" | "image" | "table" | "page";

export type SlashCommand = {
  id: SlashCommandId;
  label: string;
  description: string;
  keywords: readonly string[];
  group: "Basic blocks" | "Media" | "Pages";
  /** The Markdown shortcut that makes the same block, shown as a hint. */
  shortcut?: string;
};

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { id: "paragraph", label: "Text", description: "Just start writing with plain text.", keywords: ["plain", "paragraph", "body"], group: "Basic blocks" },
  { id: "h1", label: "Heading 1", description: "Big section heading.", keywords: ["h1", "title", "header", "large"], group: "Basic blocks", shortcut: "#" },
  { id: "h2", label: "Heading 2", description: "Medium section heading.", keywords: ["h2", "header", "medium"], group: "Basic blocks", shortcut: "##" },
  { id: "h3", label: "Heading 3", description: "Small section heading.", keywords: ["h3", "header", "small"], group: "Basic blocks", shortcut: "###" },
  { id: "bulleted", label: "Bulleted list", description: "Create a simple bulleted list.", keywords: ["bullet", "unordered", "ul", "list", "points"], group: "Basic blocks", shortcut: "-" },
  { id: "numbered", label: "Numbered list", description: "Create a list with numbering.", keywords: ["ordered", "ol", "list", "numbers", "steps"], group: "Basic blocks", shortcut: "1." },
  { id: "todo", label: "To-do list", description: "Track tasks with a checkbox.", keywords: ["todo", "task", "checkbox", "check", "checklist"], group: "Basic blocks", shortcut: "[]" },
  { id: "toggle", label: "Toggle list", description: "Hide content inside a collapsible section.", keywords: ["collapse", "details", "expand", "fold", "accordion", "dropdown"], group: "Basic blocks" },
  { id: "quote", label: "Quote", description: "Capture a quote.", keywords: ["blockquote", "citation", "cite"], group: "Basic blocks", shortcut: ">" },
  { id: "callout", label: "Callout", description: "Make writing stand out.", keywords: ["note", "tip", "info", "warning", "alert", "admonition", "highlight", "important"], group: "Basic blocks" },
  { id: "code", label: "Code", description: "Capture a code snippet.", keywords: ["snippet", "pre", "codeblock", "program", "script"], group: "Basic blocks", shortcut: "```" },
  { id: "divider", label: "Divider", description: "Visually divide blocks.", keywords: ["separator", "line", "hr", "rule", "horizontal"], group: "Basic blocks", shortcut: "---" },
  { id: "table", label: "Table", description: "Add a simple Markdown table.", keywords: ["grid", "rows", "columns", "spreadsheet"], group: "Media" },
  { id: "image", label: "Image", description: "Embed an image from a link.", keywords: ["picture", "photo", "img", "embed", "media", "screenshot"], group: "Media" },
  { id: "page", label: "Page", description: "Create a sub-page inside this page.", keywords: ["subpage", "sub-page", "child", "doc", "document", "nest"], group: "Pages" },
];

/** How well `q` (already folded) matches a command; 0 for no match. */
export function scoreSlashCommand(command: SlashCommand, q: string): number {
  if (!q) return 1;
  // In a menu of short block names, a query spelling a label's initials
  // ("bl" → Bulleted list) means that block more than a hit mid-word does
  // ("bl" inside "Table"), so mid-word hits rank below initials here.
  const labelMatch = matchLabelText(command.label, q)?.score ?? 0;
  const label = labelMatch === MATCH_SCORE.infix ? MATCH_SCORE.keywordPrefix - 5 : labelMatch;
  const keyword = matchKeywords(command.keywords, q) ?? 0;
  const initials = matchesInitials(command.label, q) ? MATCH_SCORE.initials : 0;
  const shortcut = command.shortcut && command.shortcut === q ? MATCH_SCORE.exact : 0;
  const fuzzy =
    q.length >= 2 && isWordAnchoredSubsequence(foldSearchText(command.label), q) ? MATCH_SCORE.fuzzy : 0;
  return Math.max(label, keyword, initials, shortcut, fuzzy);
}

/** The commands a query keeps, best first; ties keep the menu's own order. */
export function filterSlashCommands(
  query: string,
  commands: readonly SlashCommand[] = SLASH_COMMANDS,
): SlashCommand[] {
  const q = foldSearchText(query);
  if (!q) return [...commands];
  return commands
    .map((command, order) => ({ command, order, score: scoreSlashCommand(command, q) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map((entry) => entry.command);
}

/**
 * The open `/` query at the caret, if any: a slash at the start of the block
 * or after whitespace, with the caret somewhere after it on the same line.
 * Stops being a query once it grows past what any command needs, or holds
 * a double space — then the slash was just a slash.
 */
export function slashQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const slash = before.lastIndexOf("/");
  if (slash < 0) return null;
  if (slash > 0 && !/\s/.test(before[slash - 1])) return null;
  const query = before.slice(slash + 1);
  if (query.includes("\n") || query.length > 24 || /\s\s/.test(query) || query.startsWith(" ")) {
    return null;
  }
  return { start: slash, query };
}
