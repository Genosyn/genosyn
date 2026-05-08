import { marked } from "marked";
import type { Resource } from "../db/entities/Resource.js";
import { htmlToPdf } from "./htmlToPdf.js";

/**
 * Convert a resource body into a downloadable artifact in one of the
 * supported formats. Markdown / plain text are passed through; HTML is
 * rendered through `marked`; PDF round-trips that HTML through Chromium
 * via `htmlToPdf`. Used by both the human-facing Download menu and the
 * `export_resource` MCP tool so AI employees can attach a real PDF to a
 * chat reply or Base record without having to lay one out by hand.
 */

export type ExportFormat = "md" | "txt" | "html" | "pdf";

export const EXPORT_FORMATS: ExportFormat[] = ["md", "txt", "html", "pdf"];

export function isExportFormat(value: unknown): value is ExportFormat {
  return typeof value === "string" && (EXPORT_FORMATS as string[]).includes(value);
}

export interface ExportArtifact {
  buffer: Buffer;
  mime: string;
  ext: ExportFormat;
  filename: string;
}

const MIME_BY_FORMAT: Record<ExportFormat, string> = {
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  html: "text/html; charset=utf-8",
  pdf: "application/pdf",
};

export async function exportResource(
  row: Pick<Resource, "slug" | "title" | "bodyText">,
  format: ExportFormat,
): Promise<ExportArtifact> {
  const body = row.bodyText ?? "";
  const filename = `${row.slug}.${format}`;
  const mime = MIME_BY_FORMAT[format];

  switch (format) {
    case "md":
    case "txt":
      return { buffer: Buffer.from(body, "utf8"), mime, ext: format, filename };
    case "html": {
      const html = renderResourceHtml(row.title, body);
      return { buffer: Buffer.from(html, "utf8"), mime, ext: format, filename };
    }
    case "pdf": {
      const html = renderResourceHtml(row.title, body);
      const pdf = await htmlToPdf(html);
      return { buffer: pdf, mime, ext: format, filename };
    }
  }
}

/**
 * Strip script tags and inline event handlers from server-rendered HTML.
 * We can't run DOMPurify here without pulling in jsdom, but the output
 * only ever lands in a downloaded file or a sandboxed Chromium instance
 * we tear down on the same request, so a regex-based cleanup is enough
 * to neutralize the obvious injection paths.
 */
function basicSanitize(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<\/?script\b[^>]*>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^>\s]+)/gi, "")
    .replace(/javascript:/gi, "");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderResourceHtml(title: string, body: string): string {
  const inner = basicSanitize(
    marked.parse(body, { async: false, gfm: true, breaks: true }) as string,
  );
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    line-height: 1.65;
    color: #0f172a;
    max-width: 720px;
    margin: 2.5rem auto;
    padding: 0 1.5rem;
  }
  h1, h2, h3, h4, h5, h6 { line-height: 1.25; color: #0f172a; }
  h1 { font-size: 1.875rem; margin: 0 0 1.5rem; }
  h2 { font-size: 1.375rem; margin: 2rem 0 0.75rem; }
  h3 { font-size: 1.125rem; margin: 1.5rem 0 0.5rem; }
  p, ul, ol, blockquote, pre, table { margin: 0 0 1rem; }
  ul, ol { padding-left: 1.5rem; }
  li { margin-bottom: 0.25rem; }
  a { color: #4f46e5; text-decoration: underline; }
  pre {
    background: #f1f5f9;
    padding: 0.75rem 1rem;
    border-radius: 0.5rem;
    overflow-x: auto;
    font-size: 0.85rem;
    line-height: 1.55;
  }
  code {
    background: #f1f5f9;
    padding: 0.1rem 0.3rem;
    border-radius: 0.25rem;
    font-size: 0.9em;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  pre code { background: none; padding: 0; font-size: inherit; }
  blockquote {
    border-left: 3px solid #cbd5e1;
    padding: 0 0 0 1rem;
    color: #475569;
    margin-left: 0;
  }
  table {
    border-collapse: collapse;
    font-size: 0.95em;
  }
  th, td {
    border: 1px solid #cbd5e1;
    padding: 0.4rem 0.65rem;
    text-align: left;
  }
  th { background: #f8fafc; }
  hr { border: none; border-top: 1px solid #e2e8f0; margin: 2rem 0; }
  img { max-width: 100%; height: auto; }
  /* Print: drop the centered max-width so the page margin owns the layout. */
  @media print {
    body { max-width: none; margin: 0; padding: 0; }
    pre, blockquote, table { page-break-inside: avoid; }
    h1, h2, h3 { page-break-after: avoid; }
  }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${inner}
</body>
</html>`;
}
