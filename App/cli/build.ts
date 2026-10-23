import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "vite";

/**
 * Bundle the CLI into one file: `dist/cli/genosyn-api.mjs`.
 *
 * The CLI imports nothing but Node's built-ins, so the bundle is the whole
 * program — download it, `chmod +x`, run it. Vite (already the App's
 * bundler) does the work in SSR mode, which keeps `node:` imports as imports
 * and inlines everything else; the shebang makes the file executable as is.
 * `npm run build` runs this, so every image carries the CLI and every
 * install serves it at `/cli/genosyn-api.mjs` (`server/routes/cli.ts`).
 */

export const CLI_BUNDLE_FILE = "genosyn-api.mjs";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The release the bundle belongs to: `APP_VERSION` in image builds, else the repo's VERSION. */
export function releaseVersion(): string {
  const fromEnv = process.env.APP_VERSION?.trim();
  if (fromEnv && fromEnv !== "dev") return fromEnv;
  try {
    const version = fs.readFileSync(path.join(APP_DIR, "..", "VERSION"), "utf8").trim();
    if (version) return version;
  } catch {
    // Not in the repo layout; fall through.
  }
  return fromEnv || "0.0.0";
}

export async function buildCli(
  options: { outDir?: string; version?: string } = {},
): Promise<string> {
  const outDir = options.outDir ?? path.join(APP_DIR, "dist", "cli");
  await build({
    configFile: false,
    root: APP_DIR,
    logLevel: "warn",
    publicDir: false,
    define: { __GENOSYN_CLI_VERSION__: JSON.stringify(options.version ?? releaseVersion()) },
    build: {
      ssr: path.join(APP_DIR, "cli", "main.ts"),
      outDir,
      emptyOutDir: true,
      target: "node22",
      minify: false,
      sourcemap: false,
      copyPublicDir: false,
      reportCompressedSize: false,
      rollupOptions: {
        output: {
          format: "es",
          entryFileNames: CLI_BUNDLE_FILE,
          banner: "#!/usr/bin/env node",
          inlineDynamicImports: true,
        },
      },
    },
    ssr: { target: "node", noExternal: true },
  });
  const file = path.join(outDir, CLI_BUNDLE_FILE);
  fs.chmodSync(file, 0o755);
  return file;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const file = await buildCli();
  process.stdout.write(`Built ${path.relative(process.cwd(), file)}\n`);
}
