import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPublicUrl } from "../services/publicUrl.js";
import { buildApiDocument, type CoverageReport } from "./document.js";

/**
 * The OpenAPI 3.0 document for an Express app: every route it serves, with
 * the hand-written registrations where they exist (`document.ts`).
 *
 * Memoized per app. Routes are registered once at startup and never change, so
 * walking the router stack again on every request would be pure waste. Only
 * the `servers` entry is rebuilt each time, because the public URL is an
 * Admin setting that can change while the process runs.
 */

type Built = ReturnType<typeof buildApiDocument>;

const cache = new WeakMap<object, Built>();

function readVersion(): string {
  // Container builds cannot see the repo-root VERSION file because App is
  // deliberately its own build context. The release workflow passes the same
  // value as APP_VERSION and the runtime image preserves it.
  const builtVersion = process.env.APP_VERSION?.trim();
  if (builtVersion) return builtVersion;

  // VERSION lives at the repo root: <root>/VERSION. The compiled server runs
  // from <root>/App/dist/server, dev runs from <root>/App/server. Resolve
  // upward until we find it so both layouts work.
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(__dirname, "..", "..", "..", "VERSION"),
    path.resolve(__dirname, "..", "..", "..", "..", "VERSION"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        return fs.readFileSync(p, "utf8").trim();
      } catch {
        // fall through
      }
    }
  }
  return "0.0.0";
}

function built(app: object): Built {
  let result = cache.get(app);
  if (!result) {
    result = buildApiDocument(app, { version: readVersion() });
    cache.set(app, result);
  }
  return result;
}

/** The API reference for `app` — pass the Express app the server listens with. */
export function buildOpenApiDocument(app: object) {
  const { document } = built(app);
  return {
    ...document,
    servers: [{ url: getPublicUrl(), description: "This Genosyn instance" }],
  };
}

/** What the reference covers and what it could not, for the coverage test. */
export function openApiCoverage(app: object): CoverageReport {
  return built(app).report;
}
