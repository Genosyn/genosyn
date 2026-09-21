import { z } from "zod";
import type { IntegrationTool } from "../types.js";
import { forgeFetchWithHeaders, GITHUB_ENDPOINT, repoPath } from "./forge/client.js";

export const githubActivityTool: IntegrationTool = {
  name: "list_repository_activity",
  description:
    "Read a compact, structured page of GitHub repository events (pushes, issues, pull requests, comments, reviews, releases and other published event types). Follow nextPage with the same filters. Coverage is always partial: GitHub retains at most 300 events from 30 days, and events may lag by up to six hours. Use list_commits/list_issues/list_pull_requests for authoritative follow-up; this is not a complete audit or CI history.",
  inputSchema: {
    type: "object",
    properties: {
      owner: { type: "string" },
      repo: { type: "string" },
      per_page: { type: "integer", minimum: 1, maximum: 100, description: "Provider rows per page (default 30)." },
      page: { type: "integer", minimum: 1, maximum: 300, description: "Provider page, default 1. Use nextPage to continue." },
      since: { type: "string", description: "Optional inclusive ISO timestamp. Filters this page locally; follow nextPage even if this page has no matching events." },
      until: { type: "string", description: "Optional exclusive ISO timestamp. Filters this page locally." },
    },
    required: ["owner", "repo"],
    additionalProperties: false,
  },
};

const activityArgs = z.object({
  owner: z.string().trim().min(1).max(255),
  repo: z.string().trim().min(1).max(255),
  per_page: z.number().int().min(1).max(100).default(30),
  page: z.number().int().min(1).max(300).default(1),
  since: z.string().datetime({ offset: true }).optional(),
  until: z.string().datetime({ offset: true }).optional(),
}).strict().refine((v) => !v.since || !v.until || Date.parse(v.since) < Date.parse(v.until), {
  message: "since must be earlier than until",
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

export async function listGithubRepositoryActivity(args: unknown, token: string) {
  const input = activityArgs.parse(args ?? {});
  if ((input.page - 1) * input.per_page >= 300) {
    throw new Error("GitHub repository activity exposes at most 300 events. Use a page within that window.");
  }
  const path = `${repoPath(input.owner, input.repo)}/events`;
  const { data, headers } = await forgeFetchWithHeaders(GITHUB_ENDPOINT, token, path, {
    query: { per_page: input.per_page, page: input.page },
  });
  if (!Array.isArray(data) || data.some((row) => typeof record(row).id !== "string" ||
      typeof record(row).created_at !== "string" || !Number.isFinite(Date.parse(record(row).created_at as string)))) {
    throw new Error("GitHub returned an invalid activity page; coverage could not be established.");
  }
  const rows = data as Row[];
  const dates = rows.map((row) => Date.parse(row.created_at as string));
  const since = input.since ? Date.parse(input.since) : -Infinity;
  const until = input.until ? Date.parse(input.until) : Infinity;
  const events = rows.filter((_, i) => dates[i] >= since && dates[i] < until).map(compactEvent);
  const nextPage = nextPageFromLink(headers.get("link"), path, input.page, input.per_page);
  return {
    nextPage,
    coverage: {
      source: "github_repository_events",
      repository: `${input.owner}/${input.repo}`,
      page: input.page,
      perPage: input.per_page,
      scanned: rows.length,
      returned: events.length,
      filters: { since: input.since ?? null, until: input.until ?? null },
      reachedFeedEnd: nextPage === null,
      reachedRequestedStart: !!input.since && dates.some((date) => date < since),
      newestScannedAt: dates.length ? new Date(Math.max(...dates)).toISOString() : null,
      oldestScannedAt: dates.length ? new Date(Math.min(...dates)).toISOString() : null,
      complete: false,
      retentionDays: 30,
      maximumEvents: 300,
      maximumDelaySeconds: 21_600,
      stringLimit: 500,
      omitted: ["event bodies", "commit details", "complete CI history"],
      note: "This is a delayed, capped event feed, not a complete activity audit. Empty results do not prove inactivity. Date filters apply only to this page. Strings are capped at 500 characters. Use the existing commit, issue and pull-request tools to verify specific work.",
    },
    events,
  };
}
