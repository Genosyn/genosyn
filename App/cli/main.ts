import { runCli } from "./cli.js";
import { processIo } from "./io.js";

/**
 * The `genosyn-api` executable. `cli/build.ts` bundles this file and
 * everything it imports into one dependency-free `genosyn-api.mjs`, which
 * every install serves at `/cli/genosyn-api.mjs`.
 */

// stdout closed early (`genosyn-api ops | head`) is the reader's choice, not a failure.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(process.exitCode ?? 0);
  throw error;
});

runCli(process.argv.slice(2), processIo()).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`genosyn-api: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  },
);
