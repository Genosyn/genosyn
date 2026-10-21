import { defineConfig, type Plugin } from "vite";
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

/**
 * Two pages: the App, and the careers site's own small bundle, which the
 * server fills with each careers page's head and data. Only when building the
 * App's own root: a browser-test fixture builds this config with a root and
 * page of its own, and must build that page alone.
 */
function appPages(): Plugin {
  const clientRoot = path.resolve(__dirname, "client");
  return {
    name: "genosyn-app-pages",
    config(config) {
      if (path.resolve(config.root ?? process.cwd()) !== clientRoot) return;
      return {
        build: {
          rollupOptions: {
            input: {
              main: path.join(clientRoot, "index.html"),
              careers: path.join(clientRoot, "careers.html"),
            },
          },
        },
      };
    },
  };
}

export default defineConfig({
  root: "client",
  plugins: [react(), appPages()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "client"),
      // epubjs advertises a pre-built browser bundle compiled with Babel 6.
      // That bundle executes `Function(...)` while it initializes, which is
      // rejected by our production CSP before React can mount. Bundle the
      // package's native ES module source instead so the app remains usable
      // without weakening `script-src` with `unsafe-eval`.
      epubjs: path.resolve(__dirname, "node_modules/epubjs/src/index.js"),
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
