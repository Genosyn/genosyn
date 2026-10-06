import { Marked } from "marked";

/**
 * Blog posts are Markdown. This turns one into the HTML its page renders: at
 * build time for the prerendered page, and identically in the browser when it
 * hydrates. It keeps the few rules a public page needs. Headings carry ids, so
 * a section can be linked to. Raw HTML is shown as text, never trusted. Only
 * web, mail, same-site and anchor links survive. Links that leave the site
 * open in a new tab.
 */

const SAFE_URL = /^(https?:\/\/|mailto:|\/(?!\/)|#)/i;
const EXTERNAL_URL = /^https?:\/\//i;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** "Who gets to *own*" → "who-gets-to-own". */
export function headingId(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/[\s-]+/g, "-");
}

const markdown = new Marked({
  gfm: true,
  renderer: {
    heading({ tokens, depth, text }) {
      return `<h${depth} id="${headingId(text)}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
    },
    link({ href, title, tokens }) {
      const label = this.parser.parseInline(tokens);
      if (!SAFE_URL.test(href)) return label;
      const attributes = [`href="${escapeHtml(href)}"`];
      if (title) attributes.push(`title="${escapeHtml(title)}"`);
      if (EXTERNAL_URL.test(href)) attributes.push('target="_blank" rel="noreferrer"');
      return `<a ${attributes.join(" ")}>${label}</a>`;
    },
    image({ href, title, text }) {
      if (!SAFE_URL.test(href)) return escapeHtml(text);
      const caption = title ? ` title="${escapeHtml(title)}"` : "";
      return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}"${caption} loading="lazy" />`;
    },
    html({ text }) {
      return escapeHtml(text);
    },
  },
});

export function renderMarkdown(source: string): string {
  return markdown.parse(source, { async: false });
}

const WORDS_PER_MINUTE = 230;

/** Minutes to read a post, rounded, and never less than one. */
export function readingMinutes(source: string): number {
  const words = source
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/[#>*_`[\]]/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}
