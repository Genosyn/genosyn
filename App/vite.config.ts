import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Bake the app version and short commit SHA into the client bundle so the UI
// can show "what's running" without a runtime API round-trip. We prefer env
// vars (set by the Docker build, where .git isn't in the build context) and
// fall back to reading VERSION + `git rev-parse` for local dev.
function readVersion(): string {
  if (process.env.APP_VERSION) return process.env.APP_VERSION.trim();
  const candidates = [
    path.resolve(__dirname, "..", "VERSION"),
    path.resolve(__dirname, "VERSION"),
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
  return "dev";
}

function readCommit(): string {
  if (process.env.APP_COMMIT) return process.env.APP_COMMIT.trim().slice(0, 7);
  try {
    return execSync("git rev-parse --short HEAD", {
      cwd: __dirname,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "local";
  }
}

export default defineConfig({
  root: "client",
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "client"),
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(readVersion()),
    __APP_COMMIT__: JSON.stringify(readCommit()),
  },
  // No `server` block: in dev, Vite runs in middleware mode inside the
  // Express process (see server/index.ts), so there is no separate Vite
  // HTTP server and no proxy is needed. One port for API + UI.
  build: {
    outDir: "../dist/client",
    emptyOutDir: true,
  },
});
