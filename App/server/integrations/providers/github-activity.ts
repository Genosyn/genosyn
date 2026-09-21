import { z } from "zod";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import type { IntegrationTool } from "../types.js";
import { forgeFetchWithHeaders, GITHUB_ENDPOINT, repoPath } from "./forge/client.js";

export const githubActivityTool: IntegrationTool = {
  name: "list_repository_activity",
  description:
    "Read structured GitHub activity with stable event-ID continuation. Follow nextCursor as cursor after processing eventIds. For interruption within a batch, save resumeCursor and the last successfully processed event ID; resume with cursor=resumeCursor and afterEventId. At scan end save checkpoint and supply it on the next scan to exclude processed IDs while picking up delayed arrivals. A missing saved event or anchor returns an explicit gap without advancing. Store progress in a Workstream. Receipts do not prove processing or exactly-once side effects. Coverage remains partial: at most 300 events from 30 days, delayed up to six hours.",
  inputSchema: {
    type: "object",
    properties: {
      owner: { type: "string" },
      repo: { type: "string" },
      per_page: { type: "integer", minimum: 1, maximum: 100, description: "Events returned per call (default 30); keep unchanged while following a cursor." },
      cursor: { type: "string", description: "Opaque nextCursor from the last successfully processed batch. Resumes the same saved event-ID snapshot." },
      afterEventId: { type: "string", description: "For a partially processed batch, pass its resumeCursor as cursor and the last successfully processed event ID here. Only IDs from that batch are accepted." },
      checkpoint: { type: "string", description: "Completed-scan checkpoint. Starts a new scan excluding previously processed IDs. Mutually exclusive with cursor." },
      since: { type: "string", description: "Optional inclusive ISO timestamp; keep unchanged with a cursor or checkpoint." },
      until: { type: "string", description: "Optional exclusive ISO timestamp; keep unchanged with a cursor or checkpoint." },
    },
    required: ["owner", "repo"],
    additionalProperties: false,
  },
};

const activityArgs = z.object({
  owner: z.string().trim().min(1).max(255),
  repo: z.string().trim().min(1).max(255),
  per_page: z.number().int().min(1).max(100).default(30),
  cursor: z.string().min(1).max(30_000).optional(),
  afterEventId: z.string().min(1).max(64).optional(),
  checkpoint: z.string().min(1).max(30_000).optional(),
  since: z.string().datetime({ offset: true }).optional(),
  until: z.string().datetime({ offset: true }).optional(),
}).strict().refine((v) => !v.since || !v.until || Date.parse(v.since) < Date.parse(v.until), {
  message: "since must be earlier than until",
}).refine((v) => !(v.cursor && v.checkpoint), {
  message: "Use either cursor or checkpoint, not both",
}).refine((v) => !v.afterEventId || !!v.cursor, {
  message: "afterEventId requires the saved batch's resumeCursor as cursor",
});

type Row = Record<string, unknown>;
function record(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}
function fields(value: unknown, keys: string[]): Row {
  const row = record(value);
  const result: Row = {};
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string") result[key] = value.slice(0, 500);
    else if (value === null || typeof value === "boolean" || typeof value === "number") result[key] = value;
  }
  return result;
}

type CompactEvent = Row & {
  issue?: Row;
  pull_request?: Row;
  comment?: Row;
  review?: Row;
  release?: Row;
  fork?: Row;
};

function compactEvent(event: Row): CompactEvent {
  const payload = record(event.payload);
  return {
    ...fields(event, ["id", "type", "created_at", "public"]),
    actor: fields(event.actor, ["login"]).login ?? null,
    repository: fields(event.repo, ["name"]).name ?? null,
    ...fields(payload, ["action", "ref", "ref_type", "before", "head", "size", "distinct_size", "number"]),
    ...(payload.issue ? { issue: fields(payload.issue, ["number", "title", "state", "html_url"]) } : {}),
    ...(payload.pull_request ? { pull_request: fields(payload.pull_request, ["number", "title", "state", "draft", "merged", "html_url"]) } : {}),
    ...(payload.comment ? { comment: fields(payload.comment, ["id", "html_url", "commit_id", "path", "line"]) } : {}),
    ...(payload.review ? { review: fields(payload.review, ["id", "state", "html_url"]) } : {}),
    ...(payload.release ? { release: fields(payload.release, ["id", "tag_name", "name", "draft", "prerelease", "html_url"]) } : {}),
    ...(payload.forkee ? { fork: fields(payload.forkee, ["full_name", "html_url"]) } : {}),
  };
}

/** Read a page number from Link; never fetch a provider-supplied URL with a credential. */
function nextPageFromLink(link: string | null, path: string, page: number, perPage: number): number | null {
  for (const part of (link ?? "").split(",")) {
    const match = part.match(/^\s*<([^>]+)>;\s*rel="next"/);
    if (!match) continue;
    const url = new URL(match[1]);
    const next = Number(url.searchParams.get("page"));
    if (url.origin !== GITHUB_ENDPOINT.apiBase || url.pathname !== path ||
        !Number.isInteger(next) || next !== page + 1 || next > Math.ceil(300 / perPage)) {
      throw new Error("GitHub returned an invalid activity continuation; coverage could not be established.");
    }
    return next;
  }
  return null;
}

const eventId = z.string().min(1).max(64);
const checkpointState = z.object({
  version: z.literal(1),
  kind: z.literal("checkpoint"),
  repository: z.string().max(511),
  connectionId: z.string().max(255),
  since: z.string().nullable(),
  until: z.string().nullable(),
  observedAt: z.string().datetime(),
  anchorId: eventId.nullable(),
  processedIds: z.array(eventId).max(300),
}).strict();
const cursorState = checkpointState.omit({ kind: true }).extend({
  kind: z.literal("cursor"),
  snapshotIds: z.array(eventId).max(300),
  position: z.number().int().min(0).max(300),
  pageSize: z.number().int().min(1).max(100),
}).strict();
type Checkpoint = z.infer<typeof checkpointState>;
type Cursor = z.infer<typeof cursorState>;

/** Caller-owned progress, never authorization. Compression bounds the 300 stable IDs. */
function encodeState(state: Checkpoint | Cursor): string {
  return `gha1.${deflateRawSync(Buffer.from(JSON.stringify(state))).toString("base64url")}`;
}
function decodeState(value: string, kind: "cursor" | "checkpoint"): Checkpoint | Cursor {
  try {
    if (!/^gha1\.[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid token");
    const json = inflateRawSync(Buffer.from(value.slice(5), "base64url"), { maxOutputLength: 65_000 });
    const state = (kind === "cursor" ? cursorState : checkpointState).parse(JSON.parse(json.toString("utf8")));
    const allIds = [...state.processedIds, ...("snapshotIds" in state ? state.snapshotIds : [])];
    if (allIds.length > 300 || new Set(allIds).size !== allIds.length ||
        ("position" in state && state.position > state.snapshotIds.length)) throw new Error("Invalid state");
    return state;
  } catch {
    throw new Error("Invalid GitHub activity continuation. Restore the saved cursor/checkpoint or reconcile the gap before starting a new scan.");
  }
}

function parseEvents(data: unknown): Row[] {
  if (!Array.isArray(data) || data.length > 100 || data.some((value) => {
    const row = record(value);
    return !eventId.safeParse(row.id).success || typeof row.created_at !== "string" ||
      !Number.isFinite(Date.parse(row.created_at));
  })) throw new Error("GitHub returned an invalid activity page; coverage could not be established.");
  return data as Row[];
}

/**
 * Inspect the whole retained feed before applying any caller window. A changed
 * first page or overlap between provider pages forces a retry, never a cursor
 * over a silently shifted page boundary. GitHub still offers no atomic snapshot.
 */
async function retainedEvents(path: string, token: string): Promise<Row[]> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const rows: Row[] = [];
    const seen = new Set<string>();
    let firstIds: string[] = [];
    let overlap = false;
    let pages = 0;
    for (let page = 1; page <= 3; page += 1) {
      const result = await forgeFetchWithHeaders(GITHUB_ENDPOINT, token, path, {
        query: { per_page: 100, page },
      });
      const batch = parseEvents(result.data);
      pages += 1;
      if (page === 1) firstIds = batch.map((row) => row.id as string);
      for (const row of batch) {
        if (seen.has(row.id as string)) overlap = true;
        else { seen.add(row.id as string); rows.push(row); }
      }
      const next = nextPageFromLink(result.headers.get("link"), path, page, 100);
      if (!next) break;
    }
    if (pages > 1) {
      const verify = await forgeFetchWithHeaders(GITHUB_ENDPOINT, token, path, { query: { per_page: 100, page: 1 } });
      const lastFirstIds = parseEvents(verify.data).map((row) => row.id as string);
      if (JSON.stringify(firstIds) !== JSON.stringify(lastFirstIds)) continue;
    }
    if (!overlap) return rows;
  }
  throw new Error("GitHub activity changed while scanning its pages. Retry the same saved cursor/checkpoint; no progress was acknowledged.");
}

export async function listGithubRepositoryActivity(args: unknown, token: string, connectionId = "direct") {
  const input = activityArgs.parse(args ?? {});
  const repository = `${input.owner.toLowerCase()}/${input.repo.toLowerCase()}`;
  const scope = { repository, connectionId, since: input.since ?? null, until: input.until ?? null };
  let saved = input.cursor ? decodeState(input.cursor, "cursor") :
    input.checkpoint ? decodeState(input.checkpoint, "checkpoint") : null;
  if (input.afterEventId && saved?.kind === "cursor") {
    const acknowledged = saved.snapshotIds.indexOf(input.afterEventId, saved.position);
    if (acknowledged < saved.position || acknowledged >= saved.position + saved.pageSize) {
      throw new Error("afterEventId must name an event from the saved batch. No progress was advanced.");
    }
    saved = { ...saved, position: acknowledged + 1 };
  }
  if (saved && (saved.repository !== scope.repository || saved.connectionId !== connectionId || saved.since !== scope.since || saved.until !== scope.until ||
      (saved.kind === "cursor" && saved.pageSize !== input.per_page))) {
    throw new Error("GitHub activity cursor/checkpoint does not match this Connection, repository, filters or page size. Keep the saved scan scope unchanged.");
  }
  const rows = await retainedEvents(`${repoPath(input.owner, input.repo)}/events`, token);
  const byId = new Map(rows.map((row) => [row.id as string, row]));
  const dates = rows.map((row) => Date.parse(row.created_at as string));
  const expired = !!saved && Date.now() - Date.parse(saved.observedAt) >= 30 * 86_400_000;
  const anchorMissing = !!saved?.anchorId && !byId.has(saved.anchorId);
  const unanchoredCapacity = !!saved && !saved.anchorId && rows.length === 300;
  const missing = saved?.kind === "cursor" ? saved.snapshotIds.slice(saved.position).filter((id) => !byId.has(id)) : [];
  const gap = expired ? { reason: "checkpoint_expired", missingEventIds: [] as string[] } :
    anchorMissing ? { reason: "checkpoint_anchor_missing", missingEventIds: [saved!.anchorId!] } :
    unanchoredCapacity ? { reason: "unanchored_feed_at_capacity", missingEventIds: [] as string[] } :
    missing.length ? { reason: "snapshot_events_missing", missingEventIds: missing } : null;
  const since = input.since ? Date.parse(input.since) : -Infinity;
  const until = input.until ? Date.parse(input.until) : Infinity;
  const priorIds = new Set(saved?.processedIds ?? []);
  const snapshotIds = saved?.kind === "cursor" ? saved.snapshotIds :
    rows.filter((row, i) => dates[i] >= since && dates[i] < until && !priorIds.has(row.id as string)).map((row) => row.id as string);
  const state: Cursor = saved?.kind === "cursor" ? saved : {
    version: 1, kind: "cursor", ...scope, observedAt: new Date().toISOString(),
    anchorId: rows.length ? rows[0].id as string : null,
    processedIds: rows.map((row) => row.id as string).filter((id) => priorIds.has(id)),
    snapshotIds, position: 0, pageSize: input.per_page,
  };
  const eventIds = gap ? [] : state.snapshotIds.slice(state.position, state.position + state.pageSize);
  const nextPosition = state.position + eventIds.length;
  const done = !gap && nextPosition === state.snapshotIds.length;
  const nextCursor = gap || done ? null : encodeState({ ...state, position: nextPosition });
  const checkpoint = done ? encodeState({
    version: 1, kind: "checkpoint", ...scope, observedAt: state.observedAt,
    anchorId: state.anchorId, processedIds: [...state.processedIds, ...state.snapshotIds],
  }) : null;
  return {
    resumeCursor: gap ? null : encodeState(state),
    nextCursor,
    checkpoint,
    eventIds,
    coverage: {
      source: "github_repository_events", repository,
      filters: { since: scope.since, until: scope.until },
      scanned: rows.length, returned: eventIds.length,
      snapshotEvents: state.snapshotIds.length,
      processedBefore: state.position,
      snapshotComplete: done,
      checkpointStatus: gap ? "gap" : saved ? "resumed" : "initial_scan",
      gap,
      newestScannedAt: dates.length ? new Date(Math.max(...dates)).toISOString() : null,
      oldestScannedAt: dates.length ? new Date(Math.min(...dates)).toISOString() : null,
      complete: false,
      retentionDays: 30, maximumEvents: 300, maximumDelaySeconds: 21_600,
      retainedFeedAtCapacity: rows.length === 300,
      atomicProviderSnapshot: false,
      stringLimit: 500,
      omitted: ["event bodies", "commit details", "complete CI history"],
      note: gap
        ? "Progress was not advanced. The saved boundary is no longer recoverable from GitHub's retained feed; reconcile missing history using authoritative commit/issue/PR reads before establishing a new checkpoint."
        : "Save resumeCursor before processing and record each successfully processed event ID in a Workstream. Resume a partial batch with that cursor and afterEventId; save nextCursor/checkpoint after the whole batch succeeds. Replaying an unacknowledged cursor intentionally replays its IDs. Caller-owned receipts do not prove processing or exactly-once effects. New and delayed arrivals appear on the next checkpoint scan; GitHub has no atomic or complete activity audit here.",
    },
    events: eventIds.map((id) => compactEvent(byId.get(id)!)),
  };
}
