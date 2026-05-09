import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";

// Bake the version into the client bundle so the hero badge stays in sync
// with the repo-root VERSION file. Mirrors App/vite.config.ts: prefer the
// APP_VERSION env var (set by the Docker build, where VERSION isn't copied
// into the build stage) and fall back to reading VERSION for local dev.
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

export default defineConfig({
  plugins: [react()],
  root: "client",
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "client"),
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(readVersion()),
  },
  server: {
    port: 8472,
    host: true,
  },
  build: {
    outDir: path.resolve(__dirname, "dist/client"),
    emptyOutDir: true,
    sourcemap: false,
  },
});
