/**
 * Revenue → Activities' Export CSV: every activity the filters match, in one
 * file, however many there are.
 *
 * The server answers an export one part at a time — at most 10,000 activities
 * a part, newest first — and says where the next part starts in the
 * `X-Export-Next-Cursor` header (`exportActivitiesCsv`, the same parts an AI
 * Employee reads with `export_activities`). The button used to be a plain link
 * to the first part, so a company with more than 10,000 matching activities
 * got a file that silently stopped at 10,000.
 *
 * Now the page follows the cursor itself and saves one CSV: the first part
 * whole, and every later part without its header row. One file rather than a
 * file per part, because that is what someone pressing Export expects, it is
 * what a spreadsheet opens, and a browser asks before letting a page save
 * several files at once. Each part is still its own bounded request, so the
 * server never holds one long read, and the page can show how far it has got.
 *
 * Nothing is saved unless every part arrived. A part that fails stops the
 * download with what was read so far kept, and Try again carries on from the
 * part that failed rather than from the start. The cursor names the last
 * activity of the part before, so activities logged meanwhile — newer than
 * anything still to come — never shift what follows.
 */

/** One part of the export, as the server answers it. */
export type ActivityExportPart = {
  /** The part as CSV: its header row, then its activities, lines joined by CRLF. */
  csv: string;
  /** Activities this part holds (`X-Exported-Rows`). */
  exported: number;
  /** Activities the filters match right now (`X-Export-Total`). */
  total: number;
  /** Where the next part starts (`X-Export-Next-Cursor`); null on the last part. */
  nextCursor: string | null;
  /** The file name the server suggests (`Content-Disposition`), if it gave one. */
  filename: string | null;
};

/** Reads one part: the first with `cursor` null, every later one after the cursor. */
export type FetchActivityExportPart = (
  cursor: string | null,
  signal?: AbortSignal,
) => Promise<ActivityExportPart>;

/** A download in progress: what it holds so far, and where it carries on. */
export type ActivityDownload = {
  /** The first part's header row, which every later part must repeat. */
  header: string | null;
  /** The file's text so far, in order; joined, it is one CSV. */
  chunks: string[];
  /** Activities in the file so far. */
  exported: number;
  /** Activities the filters match, as the latest part counted them. */
  total: number;
  /** Parts read so far. */
  parts: number;
  /** Where the next part starts; null before the first part and after the last. */
  cursor: string | null;
  /** Every part has arrived. */
  done: boolean;
  /** The name to save the file under. */
  filename: string;
};

/** A part arrived but cannot be joined to the file: the file would be wrong. */
export class ActivityExportShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActivityExportShapeError";
  }
}

/** A download that stopped on a failed part, with everything read before it. */
export class ActivityDownloadError extends Error {
  constructor(
    /** Why the part failed: the request's own error, or the part's shape. */
    readonly failure: unknown,
    readonly download: ActivityDownload,
  ) {
    super(failure instanceof Error ? failure.message : String(failure));
    this.name = "ActivityDownloadError";
  }
}

/** The name a download is saved under when the server suggests none. */
export function defaultExportFilename(now: Date = new Date()): string {
  return `revenue-activities-${now.toISOString().slice(0, 10)}.csv`;
}

/** A download that has read nothing yet. */
export function startActivityDownload(now: Date = new Date()): ActivityDownload {
  return {
    header: null,
    chunks: [],
    exported: 0,
    total: 0,
    parts: 0,
    cursor: null,
    done: false,
    filename: defaultExportFilename(now),
  };
}

/** The first line of a CSV part: its header row, which never spans lines. */
function headerOf(csv: string): string {
  const end = csv.indexOf("\r\n");
  return end === -1 ? csv : csv.slice(0, end);
}

/**
 * The download with one more part in it. Throws {@link ActivityExportShapeError}
 * rather than build a file that is wrong: a later part whose header row is not
 * the first part's (the columns changed while it was read), or a part that
 * says more follow without moving forward — no activities in it, or the same
 * cursor again — which would never end.
 */
export function addActivityExportPart(
  download: ActivityDownload,
  part: ActivityExportPart,
): ActivityDownload {
  if (download.done) throw new ActivityExportShapeError("The export was already complete.");
  if (part.nextCursor !== null && (part.exported <= 0 || part.nextCursor === download.cursor)) {
    throw new ActivityExportShapeError(
      "The export stopped moving forward, so the file would be incomplete. Start the export again.",
    );
  }
  let chunk: string;
  let header = download.header;
  if (header === null) {
    header = headerOf(part.csv);
    chunk = part.csv;
  } else {
    if (headerOf(part.csv) !== header) {
      throw new ActivityExportShapeError(
        "The export's columns changed while it was being read. Start the export again.",
      );
    }
    // What follows the header already starts with the CRLF that ends the
    // part before; a part holding only its header adds nothing.
    chunk = part.csv.slice(header.length);
  }
  return {
    header,
    chunks: chunk ? [...download.chunks, chunk] : download.chunks,
    exported: download.exported + Math.max(part.exported, 0),
    total: part.total,
    parts: download.parts + 1,
    cursor: part.nextCursor,
    done: part.nextCursor === null,
    filename: download.parts === 0 && part.filename ? part.filename : download.filename,
  };
}

/**
 * Read parts until the export is complete, from wherever `download` stands —
 * the start, or the part a failed attempt stopped at. `onProgress` hears the
 * download after every part. A failed part throws {@link ActivityDownloadError}
 * carrying the download as it stood before that part, to carry on from; an
 * abort throws the fetch's own abort error.
 */
export async function continueActivityDownload(
  download: ActivityDownload,
  fetchPart: FetchActivityExportPart,
  opts: { signal?: AbortSignal; onProgress?: (download: ActivityDownload) => void } = {},
): Promise<ActivityDownload> {
  let current = download;
  while (!current.done) {
    let part: ActivityExportPart;
    try {
      part = await fetchPart(current.cursor, opts.signal);
    } catch (error) {
      if (opts.signal?.aborted) throw error;
      throw new ActivityDownloadError(error, current);
    }
    if (opts.signal?.aborted) throw new DOMException("The export was cancelled.", "AbortError");
    try {
      current = addActivityExportPart(current, part);
    } catch (error) {
      throw new ActivityDownloadError(error, current);
    }
    opts.onProgress?.(current);
  }
  return current;
}

/** The finished file. */
export function activityDownloadBlob(download: ActivityDownload): Blob {
  return new Blob(download.chunks, { type: "text/csv;charset=utf-8" });
}

/** The query string a part is read with: the page's filters and, after the first, the cursor. */
export function activityExportUrl(
  baseUrl: string,
  filters: URLSearchParams,
  cursor: string | null,
): string {
  const params = new URLSearchParams(filters);
  // The list's own page size means nothing to the export, which pages itself.
  params.delete("limit");
  params.delete("offset");
  params.delete("cursor");
  if (cursor) params.set("cursor", cursor);
  const query = params.toString();
  return `${baseUrl}/activities/export${query ? `?${query}` : ""}`;
}

/** The file name in a `Content-Disposition` header, if it names one. */
export function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const match = /filename="([^"]+)"/i.exec(header) ?? /filename=([^;]+)/i.exec(header);
  const name = match?.[1]?.trim();
  return name ? name : null;
}

/** One part, read from the export's response: its CSV and the headers that describe it. */
export function exportPartFromResponse(text: string, headers: Headers): ActivityExportPart {
  const count = (name: string) => {
    const value = Number(headers.get(name));
    return Number.isFinite(value) && value >= 0 ? value : 0;
  };
  return {
    csv: text,
    exported: count("X-Exported-Rows"),
    total: count("X-Export-Total"),
    nextCursor: headers.get("X-Export-Next-Cursor") || null,
    filename: filenameFromDisposition(headers.get("Content-Disposition")),
  };
}

/** "Exported 10,000 of 54,321 activities" — how far a download has got. */
export function activityDownloadProgress(download: ActivityDownload): string {
  const count = (n: number) => n.toLocaleString("en-US");
  if (download.parts === 0) return "Starting the export…";
  if (download.done) {
    return `Exported ${count(download.exported)} ${download.exported === 1 ? "activity" : "activities"}.`;
  }
  return `Exported ${count(download.exported)} of ${count(Math.max(download.total, download.exported))} activities…`;
}
