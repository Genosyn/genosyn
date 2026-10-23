import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Router } from "express";

/**
 * `GET /cli/genosyn-api.mjs` — the `genosyn-api` command line, served by
 * the install it talks to.
 *
 * `npm run build` bundles `cli/` into one dependency-free file, so the CLI a
 * person downloads always shipped in the same release as the server, and a
 * self-hosted install needs nothing from genosyn.com to hand it out. Served
 * without auth for the bridge agent's reason: it is open-source code with no
 * secrets in it, and asking for a key here would mean pasting one into a
 * shell before the tool that keeps keys out of shells is installed. It lives
 * outside `/api` — it is a file to download, not an API operation — so the
 * API reference leaves it out by its outside-`/api` rule.
 */

export const CLI_BUNDLE_FILE = "genosyn-api.mjs";

/** Where the build writes the bundle, seen from this module both compiled and in dev. */
export function cliBundleCandidates(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [
    // Compiled: dist/server/routes → dist/cli.
    path.resolve(here, "..", "..", "cli", CLI_BUNDLE_FILE),
    // Development: server/routes → dist/cli beside the sources.
    path.resolve(here, "..", "..", "dist", "cli", CLI_BUNDLE_FILE),
  ];
}

export function cliRouter(options: { candidates?: () => string[] } = {}): Router {
  const router = Router();
  const candidates = options.candidates ?? cliBundleCandidates;
  let bundle: Buffer | null = null;

  router.get(`/${CLI_BUNDLE_FILE}`, (_req, res) => {
    if (!bundle) {
      for (const file of candidates()) {
        try {
          bundle = fs.readFileSync(file);
          break;
        } catch {
          // Try the next layout.
        }
      }
    }
    if (!bundle) {
      return res.status(404).json({
        error: "This install was built without the genosyn-api CLI. Run `npm run build:cli` in App/.",
      });
    }
    res.setHeader("Content-Type", "text/javascript; charset=utf-8");
    res.setHeader("Content-Disposition", `inline; filename="${CLI_BUNDLE_FILE}"`);
    res.setHeader("Cache-Control", "no-cache");
    return res.send(bundle);
  });

  return router;
}
