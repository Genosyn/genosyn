#!/usr/bin/env node
/**
 * Ensure node-pty's native addon matches the current Node ABI.
 *
 * node-pty 1.x ships prebuilds for a fixed set of Node versions (currently
 * only Node 24 on darwin-arm64); on any other Node the loader either picks
 * an incompatible prebuild or fails outright with `posix_spawnp failed`.
 * That breaks the in-app sign-in pty without an obvious error.
 *
 * Strategy: if loading node-pty + spawning a one-shot /bin/echo works, do
 * nothing. Otherwise, run `node-gyp rebuild` to compile the addon against
 * the running Node version. This keeps fresh `npm install` runs cheap
 * (skip the rebuild when the prebuild happens to fit) while making sure
 * any host can sign in without manual intervention.
 *
 * Runs as a `postinstall` script. Never throw — a build failure here
 * shouldn't block `npm install`; we surface the error as a warning so the
 * operator can act, and the dev server will still boot (the model panel
 * just won't be able to start a pty session until they fix it).
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const require = createRequire(import.meta.url);

function probe() {
  try {
    const pty = require(path.join(appDir, "node_modules", "node-pty"));
    return new Promise((resolve) => {
      try {
        const p = pty.spawn("/bin/echo", ["pty-ok"], {
          name: "xterm-256color",
          cols: 80,
          rows: 24,
          cwd: "/tmp",
          env: process.env,
        });
        let exited = false;
        p.onExit(({ exitCode }) => {
          exited = true;
          resolve(exitCode === 0);
        });
        setTimeout(() => {
          if (!exited) {
            try {
              p.kill();
            } catch {
              // ignore
            }
            resolve(false);
          }
        }, 3000);
      } catch {
        resolve(false);
      }
    });
  } catch {
    return Promise.resolve(false);
  }
}

async function main() {
  const platform = process.platform;
  if (platform === "win32") {
    // Windows uses ConPTY which has its own prebuild story; the Genosyn
    // server target is Linux/macOS, so skip rather than risk a half-broken
    // build on a host we don't ship for.
    return;
  }
  const ok = await probe();
  if (ok) return;
  console.log("[rebuild-node-pty] prebuild incompatible with Node " + process.version + "; rebuilding…");
  const r = spawnSync(
    process.execPath,
    [path.join(appDir, "node_modules", "node-gyp", "bin", "node-gyp.js"), "rebuild"],
    {
      cwd: path.join(appDir, "node_modules", "node-pty"),
      stdio: "inherit",
    },
  );
  if (r.status !== 0) {
    console.warn(
      "[rebuild-node-pty] node-gyp rebuild failed (exit " +
        r.status +
        "). The in-app sign-in flow will not work until this is fixed.\n" +
        "  On Alpine: apk add python3 make g++ linux-headers\n" +
        "  On Debian: apt-get install python3 build-essential\n" +
        "  On macOS:  xcode-select --install",
    );
    return;
  }
  const okAfter = await probe();
  if (!okAfter) {
    console.warn(
      "[rebuild-node-pty] rebuilt addon still fails to spawn. Inspect node-pty manually.",
    );
  }
}

main().catch((err) => {
  console.warn("[rebuild-node-pty] unexpected error:", err?.message ?? err);
});
