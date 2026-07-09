import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The running Genosyn version, resolved once and memoized.
 *
 * Prefers the `APP_VERSION` env baked into the Docker image at build time
 * (see `App/Dockerfile`); falls back to reading the repo-root `VERSION` file
 * for dev + source installs; `"0.0.0"` when neither is available.
 *
 * The compiled server runs from `<root>/App/dist/server`, dev runs from
 * `<root>/App/server` — so we probe a couple of parent depths for VERSION to
 * cover both layouts (mirrors `openapi/spec.ts`).
 */
let cached: string | null = null;

export function appVersion(): string {
  if (cached) return cached;

  const fromEnv = process.env.APP_VERSION?.trim();
  if (fromEnv && fromEnv !== "dev") {
    cached = fromEnv;
    return cached;
  }

  const dir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(dir, "..", "..", "..", "VERSION"),
    path.resolve(dir, "..", "..", "..", "..", "VERSION"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        const v = fs.readFileSync(p, "utf8").trim();
        if (v) {
          cached = v;
          return cached;
        }
      } catch {
        // fall through to the next candidate
      }
    }
  }

  cached = fromEnv || "0.0.0";
  return cached;
}
