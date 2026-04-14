import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  root: "client",
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "client"),
    },
  },
  // No `server` block: in dev, Vite runs in middleware mode inside the
  // Express process (see server/index.ts), so there is no separate Vite
  // HTTP server and no proxy is needed. One port for API + UI.
  build: {
    outDir: "../dist/client",
    emptyOutDir: true,
  },
});
