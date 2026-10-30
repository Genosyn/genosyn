import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  type ActivityDownload,
  ActivityDownloadError,
  ActivityExportShapeError,
  type ActivityExportPart,
  activityDownloadBlob,
  activityDownloadProgress,
  activityExportUrl,
  addActivityExportPart,
  continueActivityDownload,
  defaultExportFilename,
  exportPartFromResponse,
  filenameFromDisposition,
  startActivityDownload,
} from "./activityExport.js";

/**
 * Export CSV on Revenue → Activities follows the export's cursor to the end
 * and saves one file. These pin what a person cannot check by eye: that the
 * file holds every activity once with one header, that a failed part keeps
 * what was read and Try again carries on from there, and that a part which
 * cannot be joined stops the download rather than saving a wrong file.
 */

// ─────────────────────────── a keyset export server ───────────────────────────

type Activity = { id: string; occurredAt: string; createdAt: string; subject: string; body: string };

const HEADER = ['"id"', '"occurredAt"', '"subject"', '"bodyText"'].join(",");

function cell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function line(row: Activity): string {
  return [row.id, row.occurredAt, row.subject, row.body].map(cell).join(",");
}

/** Newest first: occurredAt, then createdAt, then id — the export's own order. */
function order(rows: Activity[]): Activity[] {
  const desc = (a: string, b: string) => (a === b ? 0 : a < b ? 1 : -1);
  return [...rows].sort(
    (a, b) => desc(a.occurredAt, b.occurredAt) || desc(a.createdAt, b.createdAt) || desc(a.id, b.id),
  );
}

const keyOf = (row: Activity) => `${row.occurredAt}|${row.createdAt}|${row.id}`;

/**
 * An export that answers `partSize` activities a part with a cursor after the
 * last one, the way `exportActivitiesCsv` does. Rows can change between parts.
 */
function exportServer(initial: Activity[], partSize: number) {
  const state = { rows: [...initial], calls: [] as Array<string | null>, failNext: 0 };
  async function fetchPart(cursor: string | null, signal?: AbortSignal): Promise<ActivityExportPart> {
    state.calls.push(cursor);
    await Promise.resolve();
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    if (state.failNext > 0) {
      state.failNext -= 1;
      throw new Error("The server did not respond (502).");
    }
    const sorted = order(state.rows);
    const start = cursor === null ? 0 : sorted.findIndex((row) => keyOf(row) < cursor);
    const from = start === -1 ? sorted.length : start;
    const kept = sorted.slice(from, from + partSize);
    const more = from + partSize < sorted.length;
    return {
      csv: [HEADER, ...kept.map(line)].join("\r\n"),
      exported: kept.length,
      total: sorted.length,
      nextCursor: more && kept.length > 0 ? keyOf(kept[kept.length - 1]) : null,
      filename: cursor === null ? "revenue-activities-2026-10-30.csv" : null,
    };
  }
  return { state, fetchPart };
}

/** Activities in bursts: `perInstant` share each occurredAt, so ties are everywhere. */
function activities(count: number, perInstant: number, prefix = "a"): Activity[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${String(i).padStart(5, "0")}`,
    occurredAt: new Date(Date.UTC(2025, 0, 1) + Math.floor(i / perInstant) * 1_000).toISOString(),
    createdAt: "2025-01-01 00:00:00",
    subject: `Subject ${i}`,
    // A body with a line break inside its quotes, as mail often has.
    body: i % 7 === 0 ? `Hi,\r\nline two of ${i}` : `Body ${i}`,
  }));
}

/** What one export holding everything would answer. */
function wholeFile(rows: Activity[]): string {
  return [HEADER, ...order(rows).map(line)].join("\r\n");
}

async function fileText(download: ActivityDownload): Promise<string> {
  return activityDownloadBlob(download).text();
}

// ─────────────────────────────── the download ───────────────────────────────

describe("continueActivityDownload", () => {
  test("follows the cursor through every part into one file with one header", async () => {
    const rows = activities(2_537, 40);
    const server = exportServer(rows, 1_000);
    const seen: ActivityDownload[] = [];
    const done = await continueActivityDownload(startActivityDownload(), server.fetchPart, {
      onProgress: (download) => seen.push(download),
    });
    assert.equal(done.done, true);
    assert.equal(done.parts, 3);
    assert.equal(done.exported, 2_537);
    assert.equal(await fileText(done), wholeFile(rows), "the parts join into the whole export");
    assert.equal((await fileText(done)).split(HEADER).length - 1, 1, "one header row");
    assert.deepEqual(
      seen.map((download) => [download.exported, download.total, download.done]),
      [
        [1_000, 2_537, false],
        [2_000, 2_537, false],
        [2_537, 2_537, true],
      ],
      "progress after every part",
    );
    assert.equal(done.filename, "revenue-activities-2026-10-30.csv", "the server's name for it");
    assert.deepEqual(server.state.calls.slice(0, 1), [null], "the first part has no cursor");
  });

  test("a single part, an exact multiple, and an empty export are files too", async () => {
    const single = await continueActivityDownload(
      startActivityDownload(),
      exportServer(activities(12, 5), 1_000).fetchPart,
    );
    assert.equal(single.parts, 1);
    assert.equal(await fileText(single), wholeFile(activities(12, 5)));

    const exact = await continueActivityDownload(
      startActivityDownload(),
      exportServer(activities(2_000, 50), 1_000).fetchPart,
    );
    assert.equal(exact.exported, 2_000);
    assert.equal(await fileText(exact), wholeFile(activities(2_000, 50)));

    const empty = await continueActivityDownload(startActivityDownload(), exportServer([], 1_000).fetchPart);
    assert.equal(empty.done, true);
    assert.equal(empty.exported, 0);
    assert.equal(await fileText(empty), HEADER, "just the header row");
  });

  test("activities logged or removed between parts never shift or repeat what follows", async () => {
    const rows = activities(3_100, 25);
    const server = exportServer(rows, 1_000);
    let parts = 0;
    const done = await continueActivityDownload(startActivityDownload(), server.fetchPart, {
      onProgress: () => {
        parts += 1;
        if (parts === 1) {
          // Newer than anything still to come: they belong to the next export.
          server.state.rows.push(
            ...activities(30, 30, "late").map((row) => ({
              ...row,
              occurredAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
            })),
          );
          // One still to come is deleted.
          server.state.rows = server.state.rows.filter((row) => row.id !== "a-00010");
        }
      },
    });
    const ids = (await fileText(done))
      .split("\r\n")
      .filter((text) => text.startsWith('"a-') || text.startsWith('"late-'))
      .map((text) => text.slice(1, text.indexOf('"', 1)));
    assert.equal(new Set(ids).size, ids.length, "no activity twice");
    assert.deepEqual(
      new Set(ids),
      new Set(rows.map((row) => row.id).filter((id) => id !== "a-00010")),
      "every activity that was there once, and none of the late ones",
    );
  });

  test("a failed part keeps what was read, and carrying on finishes the same file", async () => {
    const rows = activities(4_250, 40);
    const server = exportServer(rows, 1_000);
    let failure: unknown;
    let progress: ActivityDownload | null = null;
    server.state.failNext = 0;
    const flaky = async (cursor: string | null, signal?: AbortSignal) => {
      // The third part fails once.
      if (server.state.calls.length === 2 && !failure) {
        server.state.failNext = 1;
      }
      return server.fetchPart(cursor, signal);
    };
    try {
      await continueActivityDownload(startActivityDownload(), flaky, {
        onProgress: (download) => {
          progress = download;
        },
      });
      assert.fail("the download should have stopped");
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof ActivityDownloadError);
    assert.match(failure.message, /502/);
    assert.equal(failure.download.parts, 2, "the two parts that arrived are kept");
    assert.equal(failure.download.exported, 2_000);
    assert.equal(failure.download.done, false);
    assert.equal(failure.download, progress, "it is the download as last reported");
    const finished = await continueActivityDownload(failure.download, server.fetchPart);
    assert.equal(finished.exported, 4_250);
    assert.equal(await fileText(finished), wholeFile(rows), "no part twice, none missing");
    const cursors = server.state.calls;
    assert.equal(cursors[2], cursors[3], "Try again asks for the part that failed, not the start");
  });

  test("a part that cannot be joined stops the download instead of saving a wrong file", async () => {
    const rows = activities(2_500, 40);
    const server = exportServer(rows, 1_000);
    const renamed = async (cursor: string | null) => {
      const part = await server.fetchPart(cursor);
      return cursor === null ? part : { ...part, csv: part.csv.replace('"subject"', '"title"') };
    };
    const changed = await continueActivityDownload(startActivityDownload(), renamed).catch((e) => e);
    assert.ok(changed instanceof ActivityDownloadError);
    assert.ok(changed.failure instanceof ActivityExportShapeError);
    assert.match(changed.message, /columns changed/);
    assert.equal(changed.download.parts, 1);

    const stuck = async (cursor: string | null) => {
      const part = await server.fetchPart(cursor);
      return cursor === null ? part : { ...part, nextCursor: cursor };
    };
    const looping = await continueActivityDownload(startActivityDownload(), stuck).catch((e) => e);
    assert.ok(looping instanceof ActivityDownloadError);
    assert.match(looping.message, /stopped moving forward/);

    const hollow = async (cursor: string | null) => {
      const part = await server.fetchPart(cursor);
      return cursor === null ? part : { ...part, exported: 0, csv: HEADER };
    };
    const empty = await continueActivityDownload(startActivityDownload(), hollow).catch((e) => e);
    assert.ok(empty instanceof ActivityDownloadError);
    assert.match(empty.message, /stopped moving forward/);
  });

  test("cancelling stops at once and asks for nothing more", async () => {
    const server = exportServer(activities(5_000, 40), 1_000);
    const controller = new AbortController();
    const error = await continueActivityDownload(startActivityDownload(), server.fetchPart, {
      signal: controller.signal,
      onProgress: (download) => {
        if (download.parts === 2) controller.abort();
      },
    }).catch((e) => e);
    assert.equal((error as Error).name, "AbortError");
    assert.ok(!(error instanceof ActivityDownloadError), "a cancel is not a failure to report");
    assert.equal(server.state.calls.length, 3, "no part after the one in flight");
  });
});

describe("addActivityExportPart", () => {
  test("refuses a part once the download is complete", () => {
    const done = addActivityExportPart(startActivityDownload(), {
      csv: HEADER,
      exported: 0,
      total: 0,
      nextCursor: null,
      filename: null,
    });
    assert.throws(
      () =>
        addActivityExportPart(done, { csv: HEADER, exported: 0, total: 0, nextCursor: null, filename: null }),
      ActivityExportShapeError,
    );
  });

  test("keeps the default name when the server suggests none", () => {
    const now = new Date("2026-10-30T12:00:00Z");
    const download = addActivityExportPart(startActivityDownload(now), {
      csv: HEADER,
      exported: 0,
      total: 0,
      nextCursor: null,
      filename: null,
    });
    assert.equal(download.filename, defaultExportFilename(now));
    assert.equal(download.filename, "revenue-activities-2026-10-30.csv");
  });
});

// ──────────────────────────────── the request ────────────────────────────────

describe("activityExportUrl", () => {
  test("sends the page's filters, never its page size, and the cursor after the first part", () => {
    const filters = new URLSearchParams({
      limit: "200",
      q: "renewal",
      kinds: "call,note",
      from: "2026-01-01T00:00:00.000Z",
    });
    const first = new URL(activityExportUrl("/api/companies/c/revenue", filters, null), "http://x");
    assert.equal(first.pathname, "/api/companies/c/revenue/activities/export");
    assert.equal(first.searchParams.get("limit"), null);
    assert.equal(first.searchParams.get("cursor"), null);
    assert.equal(first.searchParams.get("q"), "renewal");
    assert.equal(first.searchParams.get("kinds"), "call,note");
    const later = new URL(
      activityExportUrl("/api/companies/c/revenue", filters, "eyJ2Ijox+/="),
      "http://x",
    );
    assert.equal(later.searchParams.get("cursor"), "eyJ2Ijox+/=", "the cursor survives encoding");
    assert.equal(filters.get("limit"), "200", "the page's own filters are left alone");
    assert.equal(
      activityExportUrl("/b", new URLSearchParams(), null),
      "/b/activities/export",
      "no filters, no query string",
    );
  });

  test("reads a part's count, total, cursor and file name from its headers", () => {
    const part = exportPartFromResponse(
      `${HEADER}\r\n"x"`,
      new Headers({
        "X-Exported-Rows": "10000",
        "X-Export-Total": "54321",
        "X-Export-Next-Cursor": "abc",
        "Content-Disposition": 'attachment; filename="revenue-activities-2026-10-30.csv"',
      }),
    );
    assert.deepEqual(part, {
      csv: `${HEADER}\r\n"x"`,
      exported: 10_000,
      total: 54_321,
      nextCursor: "abc",
      filename: "revenue-activities-2026-10-30.csv",
    });
    const last = exportPartFromResponse(HEADER, new Headers({ "X-Exported-Rows": "nonsense" }));
    assert.equal(last.nextCursor, null);
    assert.equal(last.exported, 0);
    assert.equal(last.filename, null);
  });

  test("finds the file name however Content-Disposition writes it", () => {
    assert.equal(filenameFromDisposition('attachment; filename="a b.csv"'), "a b.csv");
    assert.equal(filenameFromDisposition("attachment; filename=plain.csv"), "plain.csv");
    assert.equal(filenameFromDisposition("attachment"), null);
    assert.equal(filenameFromDisposition(null), null);
  });
});

describe("activityDownloadProgress", () => {
  test("says how far the download has got, then what the file holds", () => {
    const start = startActivityDownload();
    assert.equal(activityDownloadProgress(start), "Starting the export…");
    const midway = addActivityExportPart(start, {
      csv: HEADER,
      exported: 10_000,
      total: 54_321,
      nextCursor: "c1",
      filename: null,
    });
    assert.equal(activityDownloadProgress(midway), "Exported 10,000 of 54,321 activities…");
    const done = addActivityExportPart(midway, {
      csv: HEADER,
      exported: 1,
      total: 54_321,
      nextCursor: null,
      filename: null,
    });
    assert.equal(activityDownloadProgress(done), "Exported 10,001 activities.");
    const one = addActivityExportPart(start, {
      csv: HEADER,
      exported: 1,
      total: 1,
      nextCursor: null,
      filename: null,
    });
    assert.equal(activityDownloadProgress(one), "Exported 1 activity.");
  });
});
