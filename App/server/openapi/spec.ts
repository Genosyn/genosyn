import { OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../../config.js";
import { registry } from "./registry.js";
import "./auth.js";
import "./companies.js";
import "./apiKeys.js";
import "./employees.js";
import "./routines.js";

/**
 * Assembles the final OpenAPI 3.0 document from the shared registry. The
 * per-area files (`auth.ts`, etc.) are imported for their side-effect:
 * each one calls `registry.registerPath(...)` at module load.
 *
 * Memoized — the document is built once on first request and cached for the
 * lifetime of the process. There is no scenario in production where the spec
 * would change between requests, and re-walking the registry on every hit is
 * wasteful.
 */

let cached: ReturnType<OpenApiGeneratorV3["generateDocument"]> | null = null;

function readVersion(): string {
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

export function buildOpenApiDocument() {
  if (cached) return cached;
  const generator = new OpenApiGeneratorV3(registry.definitions);
  cached = generator.generateDocument({
    openapi: "3.0.0",
    info: {
      title: "Genosyn API",
      version: readVersion(),
      description:
        "REST API for Genosyn — the open-source platform for running companies " +
        "with AI employees.\n\n" +
        "**Authentication.** Every endpoint listed here accepts either a browser " +
        "session cookie (used by the web UI) or a Bearer API key minted at " +
        "Settings → API keys. API keys are scoped to a single company.\n\n" +
        "**Coverage.** This document covers the canonical scripting surface: " +
        "auth, companies, employees, routines, and the M14 api-keys endpoints. " +
        "The full surface is much larger — most routes the UI uses are not " +
        "(yet) registered here. Open an issue if there's an endpoint you want " +
        "documented.",
      contact: {
        name: "Genosyn",
        url: "https://github.com/Genosyn/genosyn",
      },
      license: { name: "MIT", url: "https://opensource.org/licenses/MIT" },
    },
    servers: [
      { url: config.publicUrl, description: "This Genosyn instance" },
    ],
  });
  return cached;
}
