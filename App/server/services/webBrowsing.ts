import path from "node:path";
import { config } from "../../config.js";
import { safeFetchBuffer } from "../lib/outboundUrl.js";
import { htmlToText, pdfBufferToText } from "./resources.js";

/**
 * The open web, for AI Employees.
 *
 * An employee working a mailbox constantly needs something the company does
 * not hold: the current blank W-9, a supplier's onboarding form, a shipping
 * tariff, a page confirming which form a vendor actually wants. Without this
 * it can only ask the human to go and find it, which is the human doing the
 * employee's job.
 *
 * Three capabilities, deliberately small:
 *  - {@link searchWeb}       — find candidate pages;
 *  - {@link fetchWebPage}    — read one, as text;
 *  - {@link downloadWebFile} — pull a file down so the PDF and mail tools can
 *                              use it (the handler records the attachment).
 *
 * Safety comes from two places. The network side is
 * {@link safeFetchBuffer}: http(s) only, no embedded credentials, every
 * redirect hop re-resolved and rejected if it lands on a private, loopback,
 * link-local or metadata address — so a link in a hostile email cannot turn
 * an employee into a probe of the operator's internal network. The content
 * side is the caller's: everything returned here is untrusted third-party
 * text, and the tool handlers label it as such so a page cannot issue
 * instructions to the model that read like they came from the teammate.
 */

/** Carries an HTTP status so tool handlers can answer with the right code. */
export class WebToolError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "WebToolError";
    this.status = status;
  }
}

export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
};

export type WebPage = {
  /** The URL actually read, after redirects. */
  url: string;
  title: string;
  contentType: string;
  text: string;
  /** True when `text` was cut at the character cap. */
  truncated: boolean;
};

export type WebFile = {
  url: string;
  filename: string;
  mimeType: string;
  bytes: Buffer;
};

const USER_AGENT = "GenosynWebBot/1.0 (+https://genosyn.com)";

function assertWebEnabled(): void {
  if (!config.web.enabled) {
    throw new WebToolError(
      "Web access is turned off on this Genosyn install. Ask an operator to set `web.enabled` in config.ts if you need it.",
      403,
    );
  }
}

function parseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new WebToolError(`"${raw}" is not a valid URL. Include the scheme, e.g. https://…`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebToolError("Only http and https URLs can be opened.");
  }
  return url;
}

/**
 * `safeFetchBuffer` throws for a refused address, a redirect loop, an
 * oversized body, or a timeout. Those are all things the employee should be
 * able to read and act on (try another result, tell the human the site is
 * unreachable), so they come back as ordinary tool errors rather than 500s.
 */
async function fetchDocument(url: URL, accept: string): Promise<{
  url: string;
  contentType: string;
  body: Buffer;
}> {
  let result;
  try {
    result = await safeFetchBuffer(
      url,
      { headers: { "User-Agent": USER_AGENT, Accept: accept } },
      {
        maxBytes: config.web.maxDocumentBytes,
        timeoutMs: config.security.outboundRequestTimeoutMs,
      },
    );
  } catch (error) {
    throw new WebToolError(
      `Could not load ${url.toString()}: ${error instanceof Error ? error.message : String(error)}`,
      502,
    );
  }
  if (!result.ok) {
    throw new WebToolError(`${url.toString()} returned HTTP ${result.status}.`, 502);
  }
  return {
    url: result.url,
    contentType: (result.headers.get("content-type") ?? "").toLowerCase(),
    body: result.body,
  };
}

/**
 * Search the web and return the result list.
 *
 * DuckDuckGo's no-JavaScript HTML endpoint is the default backend because it
 * is the only one a self-hosted install can use with no account, no API key
 * and no per-tenant billing. It is scraped, so it can change shape or rate
 * limit: every failure mode here reports what happened rather than returning
 * an empty list that reads like "the web has nothing on this".
 */
export async function searchWeb(query: string, limit: number): Promise<WebSearchResult[]> {
  assertWebEnabled();
  const trimmed = query.trim();
  if (!trimmed) throw new WebToolError("Give me something to search for.");
  if (config.web.searchProvider === "disabled") {
    throw new WebToolError(
      "Web search is turned off on this Genosyn install, but `fetch_web_page` still works if you already know the URL.",
      403,
    );
  }
  const capped = Math.max(1, Math.min(limit, config.web.maxSearchResults));
  const endpoint = new URL("https://html.duckduckgo.com/html/");
  endpoint.searchParams.set("q", trimmed);
  const doc = await fetchDocument(endpoint, "text/html,application/xhtml+xml");
  const results = parseDuckDuckGoResults(doc.body.toString("utf8"), capped);
  return results;
}

/**
 * Pull `{title, url, snippet}` out of a DuckDuckGo HTML result page.
 *
 * Exported for tests: this is the part that breaks when the upstream markup
 * moves, so it is covered against a captured page rather than the network.
 */
export function parseDuckDuckGoResults(html: string, limit: number): WebSearchResult[] {
  const out: WebSearchResult[] = [];
  const seen = new Set<string>();
  // Anchor on the result-link class rather than on document structure: the
  // surrounding markup churns far more often than the class name does.
  const anchorRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorRe)) {
    const href = resolveDuckDuckGoHref(match[1]);
    if (!href || seen.has(href)) continue;
    const title = htmlToText(match[2]).text.replace(/\s+/g, " ").trim();
    if (!title) continue;
    seen.add(href);
    out.push({ title, url: href, snippet: "" });
    if (out.length >= limit) break;
  }
  if (out.length === 0) return out;

  // Snippets are a separate element and can be missing; pair them positionally
  // with the links, which is the order the page renders them in.
  const snippetRe = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets = [...html.matchAll(snippetRe)].map((m) =>
    htmlToText(m[1]).text.replace(/\s+/g, " ").trim(),
  );
  for (let i = 0; i < out.length; i += 1) {
    if (snippets[i]) out[i].snippet = snippets[i].slice(0, 400);
  }
  return out;
}

/**
 * DuckDuckGo wraps results in a redirect (`//duckduckgo.com/l/?uddg=<encoded>`).
 * Unwrapping it here means the employee gets the real destination — which is
 * what it has to reason about before deciding whether to open it.
 */
function resolveDuckDuckGoHref(raw: string): string | null {
  const decoded = raw.replace(/&amp;/g, "&");
  const absolute = decoded.startsWith("//") ? `https:${decoded}` : decoded;
  let url: URL;
  try {
    url = new URL(absolute, "https://duckduckgo.com");
  } catch {
    return null;
  }
  const wrapped = url.searchParams.get("uddg");
  if (wrapped) {
    try {
      const inner = new URL(wrapped);
      return inner.protocol === "http:" || inner.protocol === "https:" ? inner.toString() : null;
    } catch {
      return null;
    }
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // Ad and "more results" links point back at DuckDuckGo itself.
  if (/(^|\.)duckduckgo\.com$/i.test(url.hostname)) return null;
  return url.toString();
}

/** Read one page as plain text. PDFs are extracted the same way uploads are. */
export async function fetchWebPage(rawUrl: string): Promise<WebPage> {
  assertWebEnabled();
  const url = parseUrl(rawUrl);
  const doc = await fetchDocument(url, "text/html,application/xhtml+xml,text/plain,*/*;q=0.8");

  let title = "";
  let text: string;
  if (doc.contentType.includes("html") || doc.contentType.includes("xml")) {
    const extracted = htmlToText(doc.body.toString("utf8"));
    title = extracted.title;
    text = extracted.text;
  } else if (doc.contentType.includes("application/pdf")) {
    text = await pdfBufferToText(doc.body);
  } else if (doc.contentType.startsWith("text/") || doc.contentType.includes("json")) {
    text = doc.body.toString("utf8");
  } else {
    throw new WebToolError(
      `${doc.url} is ${doc.contentType || "an unknown type"}, which has no text to read. Use download_web_file to save it as an attachment instead.`,
    );
  }

  // pdf-parse occasionally emits embedded NULs; some model transports treat
  // those as C-string terminators and silently truncate the prompt.
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/\u0000/g, "").trim();
  const truncated = clean.length > config.web.maxTextChars;
  return {
    url: doc.url,
    title,
    contentType: doc.contentType,
    text: truncated ? clean.slice(0, config.web.maxTextChars) : clean,
    truncated,
  };
}

/** Download a file so it can become a chat attachment. */
export async function downloadWebFile(rawUrl: string, filenameHint?: string): Promise<WebFile> {
  assertWebEnabled();
  const url = parseUrl(rawUrl);
  const doc = await fetchDocument(url, "*/*");
  if (doc.body.length === 0) {
    throw new WebToolError(`${doc.url} returned an empty file.`);
  }
  const mimeType = doc.contentType.split(";")[0].trim() || "application/octet-stream";
  return {
    url: doc.url,
    filename: chooseFilename(filenameHint, doc.url, mimeType),
    mimeType,
    bytes: doc.body,
  };
}

const EXT_BY_MIME: Record<string, string> = {
  "application/pdf": ".pdf",
  "text/html": ".html",
  "text/plain": ".txt",
  "text/csv": ".csv",
  "application/json": ".json",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "application/zip": ".zip",
};

/**
 * A filename the human will recognize in the download chip. The URL's last
 * path segment is usually right (`fw9.pdf`); the hint wins when the employee
 * has a better one, and a content-type extension is appended when whatever we
 * ended up with has none.
 */
export function chooseFilename(hint: string | undefined, url: string, mimeType: string): string {
  const fromHint = hint ? path.basename(hint.trim()) : "";
  let name = fromHint;
  if (!name) {
    try {
      name = decodeURIComponent(path.basename(new URL(url).pathname));
    } catch {
      name = "";
    }
  }
  // Strip anything that would forge a MIME header or walk a path — the same
  // filter the mail attachment resolver applies, for the same reason.
  name = Array.from(name)
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      if (code < 32 || code === 127) return false;
      return ch !== '"' && ch !== "\\" && ch !== "/";
    })
    .join("")
    .trim()
    .slice(0, 120);
  if (!name || name === "." || name === "..") name = "download";
  if (!path.extname(name)) name += EXT_BY_MIME[mimeType] ?? "";
  return name;
}
