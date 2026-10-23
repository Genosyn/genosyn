import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { CliError } from "./errors.js";
import { errorFromResponse, sendRequest, type HttpOptions, type HttpResponse } from "./http.js";
import type { OpenApiDocument } from "./operations.js";

/**
 * The server's API description, cached on disk per install.
 *
 * `/api/openapi.json` is over a megabyte, so it is downloaded once and kept
 * beside the config. A run trusts the copy for a few minutes
 * (`GENOSYN_SPEC_TTL` seconds, 300 by default); after that it asks
 * `/api/health` for the server's version — a few bytes — and downloads the
 * description again only when the version moved, with `If-None-Match` so an
 * unchanged document costs a 304. An operation id or a parameter the copy
 * doesn't know triggers the same refresh before the CLI gives up on it, so a
 * route that shipped a minute ago is callable now. When the server can't be reached at
 * all, a cached copy still answers the discovery commands.
 */

export type CachedSpec = {
  baseUrl: string;
  fetchedAt: number;
  checkedAt: number;
  serverVersion?: string;
  etag?: string;
  document: OpenApiDocument;
};

export type LoadedSpec = {
  document: OpenApiDocument;
  serverVersion?: string;
  fetchedAt: number;
  /** "network" when this run downloaded or revalidated it. */
  source: "cache" | "network";
  /** Set when the server couldn't be reached and an older copy is in use. */
  staleReason?: string;
  cachePath: string;
};

export const DEFAULT_SPEC_TTL_SECONDS = 300;

export function specCachePath(cacheDirectory: string, baseUrl: string): string {
  const digest = createHash("sha256").update(baseUrl.toLowerCase()).digest("hex").slice(0, 16);
  return path.join(cacheDirectory, `openapi-${digest}.json`);
}

export function readCachedSpec(file: string, baseUrl: string): CachedSpec | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as CachedSpec;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      parsed.baseUrl?.toLowerCase() !== baseUrl.toLowerCase() ||
      !parsed.document ||
      typeof parsed.document.paths !== "object"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeCachedSpec(file: string, cached: CachedSpec): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(cached), { mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch {
    // A cache that can't be written only costs the next run a download.
  }
}

export function specTtlMs(env: Record<string, string | undefined>): number {
  const raw = env.GENOSYN_SPEC_TTL?.trim();
  if (raw === undefined || raw === "") return DEFAULT_SPEC_TTL_SECONDS * 1000;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : DEFAULT_SPEC_TTL_SECONDS * 1000;
}

async function serverVersion(baseUrl: string, http: HttpOptions): Promise<string | undefined> {
  const response = await sendRequest(
    { method: "GET", url: `${baseUrl}/api/health`, headers: { accept: "application/json" } },
    { ...http, timeoutMs: Math.min(http.timeoutMs, 15_000) },
  );
  if (response.status !== 200 || !response.isJson) return undefined;
  const version = (response.json as { version?: unknown })?.version;
  return typeof version === "string" ? version : undefined;
}

function isOpenApi(value: unknown): value is OpenApiDocument {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as OpenApiDocument).openapi === "string" &&
    !!(value as OpenApiDocument).paths &&
    typeof (value as OpenApiDocument).paths === "object"
  );
}

async function download(
  baseUrl: string,
  http: HttpOptions,
  etag: string | undefined,
): Promise<{ response: HttpResponse; url: string }> {
  const url = `${baseUrl}/api/openapi.json`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (etag) headers["if-none-match"] = etag;
  const request = { method: "GET", url, headers };
  const response = await sendRequest(request, http);
  if (response.status === 304) return { response, url };
  if (response.status !== 200) throw errorFromResponse(response, request);
  if (!response.isJson || !isOpenApi(response.json)) {
    throw new CliError(
      "network",
      `${baseUrl} doesn't look like Genosyn: ${url} isn't an OpenAPI document.`,
      { hint: "Check the address; it should be the one you open Genosyn at." },
    );
  }
  return { response, url };
}

/** The API description for `baseUrl`, from the cache when it is fresh enough. */
export async function loadSpec(options: {
  baseUrl: string;
  cacheDirectory: string;
  http: HttpOptions;
  ttlMs: number;
  /** Skip the freshness window and the version check; revalidate with the server. */
  refresh?: boolean;
}): Promise<LoadedSpec> {
  const { baseUrl, http } = options;
  const file = specCachePath(options.cacheDirectory, baseUrl);
  const cached = readCachedSpec(file, baseUrl);
  const now = http.now();
  const fromCache = (entry: CachedSpec, staleReason?: string): LoadedSpec => ({
    document: entry.document,
    serverVersion: entry.serverVersion,
    fetchedAt: entry.fetchedAt,
    source: "cache",
    staleReason,
    cachePath: file,
  });

  if (cached && !options.refresh && now - cached.checkedAt < options.ttlMs) {
    return fromCache(cached);
  }

  try {
    let version: string | undefined;
    if (cached && !options.refresh) {
      version = await serverVersion(baseUrl, http);
      if (version && version === cached.serverVersion) {
        writeCachedSpec(file, { ...cached, checkedAt: now });
        return fromCache(cached);
      }
    }
    const { response } = await download(baseUrl, http, cached?.etag);
    if (response.status === 304 && cached) {
      const refreshed: CachedSpec = {
        ...cached,
        checkedAt: now,
        serverVersion: version ?? cached.serverVersion,
      };
      writeCachedSpec(file, refreshed);
      return { ...fromCache(refreshed), source: "network" };
    }
    if (response.status === 304) {
      // A 304 with nothing cached can only follow a stale tag; ask plainly.
      const again = await download(baseUrl, http, undefined);
      return store(again.response, version);
    }
    return store(response, version);
  } catch (error) {
    if (cached && error instanceof CliError && error.kind === "network") {
      return fromCache(cached, error.message);
    }
    throw error;
  }

  // The version /api/health reported, when it was asked, so the next check
  // compares the same number; otherwise the document's own.
  function store(response: HttpResponse, version: string | undefined): LoadedSpec {
    const document = response.json as OpenApiDocument;
    const entry: CachedSpec = {
      baseUrl,
      fetchedAt: now,
      checkedAt: now,
      serverVersion: version ?? document.info?.version,
      etag: response.headers.get("etag") ?? undefined,
      document,
    };
    writeCachedSpec(file, entry);
    return {
      document,
      serverVersion: entry.serverVersion,
      fetchedAt: now,
      source: "network",
      cachePath: file,
    };
  }
}
