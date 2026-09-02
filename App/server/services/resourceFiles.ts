import path from "node:path";

/**
 * How a stored Resource original is handed back over HTTP.
 *
 * Two callers need the same answers — the download route and the mail
 * attachment builder — and getting them out of step is how an uploaded
 * `.html` ends up executing on the app's own origin. So the content type and
 * the filename sanitizer live here rather than in either caller.
 */

/** Content types for original uploads, keyed off the stored filename.
 *  Anything not listed is deliberately unnamed: see {@link resourceFileHeaders}. */
export const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".epub": "application/epub+zip",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
};

const DEL_CODE = 127;
const FIRST_PRINTABLE_CODE = 32;

/**
 * Strip anything that would forge a MIME header or walk a path: control
 * characters, quotes, backslashes. A stray CR/LF in a filename injects
 * headers exactly like an unvalidated address does, and the filename lands
 * in `Content-Disposition` verbatim — where `res.setHeader` throws
 * `ERR_INVALID_CHAR` rather than escaping it, hanging an unguarded async
 * handler instead of answering the request.
 *
 * Written as a code-point filter rather than a regex so the source carries
 * no literal control bytes.
 */
export function safeFilename(name: string, fallback: string): string {
  const cleaned = Array.from(path.basename(name))
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      if (code < FIRST_PRINTABLE_CODE || code === DEL_CODE) return false;
      return ch !== '"' && ch !== "\\";
    })
    .join("")
    .trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * Only these render in place. Everything else downloads.
 *
 * The rule used to be the inverse — inline by default, with an explicit type
 * pinned for `pdf` and `epub` only — which meant every other upload fell
 * through to Express's extension sniffing. `inferSourceKindFromFilename`
 * classifies anything it does not recognise as `text`, so an uploaded
 * `.html`, `.svg` or `.js` was served as itself, inline, from the origin that
 * holds the session cookie. The bytes come from wherever the upload came
 * from — including, since M47, an attachment on an email a stranger sent.
 *
 * A viewer is the only reason to render at all, and the product has exactly
 * three: the PDF iframe, the EPUB reader, and the `<video>` element.
 */
const INLINE_KINDS = new Set(["pdf", "epub", "video"]);

export type ResourceFileHeaders = {
  contentType: string;
  disposition: "inline" | "attachment";
  filename: string;
  /** Set only on the attachment branch — a bare `sandbox` on the PDF branch
   *  breaks the browser's own viewer, which the detail page iframes. */
  sandbox: boolean;
};

/**
 * Decide the headers for one stored original.
 *
 * `requested` is what the caller asked for and is honoured only downwards: a
 * viewer may ask a PDF to download, but nothing can talk an unrecognised
 * upload into rendering.
 */
export function resourceFileHeaders(args: {
  sourceKind: string;
  storedFilename: string | null;
  storageKey: string;
  requested: "inline" | "attachment";
}): ResourceFileHeaders {
  const filename = safeFilename(args.storedFilename ?? path.basename(args.storageKey), "download");
  const ext = path.extname(filename).toLowerCase() || path.extname(args.storageKey).toLowerCase();
  const inlineAllowed = INLINE_KINDS.has(args.sourceKind);
  const disposition = inlineAllowed && args.requested === "inline" ? "inline" : "attachment";
  // Never let the extension pick the type for a kind we won't render: an
  // unnamed type plus `attachment` is what makes a hostile upload inert.
  const contentType = inlineAllowed
    ? (MIME_BY_EXT[ext] ?? "application/octet-stream")
    : "application/octet-stream";
  return { contentType, disposition, filename, sandbox: disposition === "attachment" };
}
