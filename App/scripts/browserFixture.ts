/** Build real React screens before opening Chrome, avoiding development optimizer races. */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";

export async function startBrowserFixture(harness: string, port: number) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const fixtureRoot = await fs.mkdtemp(path.join(root, "node_modules/.browser-fixture-"));
  try {
    await fs.writeFile(
      path.join(fixtureRoot, "index.html"),
      '<html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div>' +
        `<script type="module" src="../../scripts/${harness}"></script></html>`,
    );
    await build({
      configFile: path.join(root, "vite.config.ts"),
      root: fixtureRoot,
      build: { outDir: path.join(fixtureRoot, "dist"), minify: false, reportCompressedSize: false },
    });
    const server = await preview({
      configFile: false,
      root: fixtureRoot,
      build: { outDir: path.join(fixtureRoot, "dist") },
      preview: { host: "127.0.0.1", port },
    });
    const address = server.httpServer.address();
    if (!address || typeof address === "string") throw new Error("Browser fixture did not start");
    return {
      origin: `http://127.0.0.1:${address.port}`,
      async close() {
        try {
          await new Promise<void>((resolve, reject) => {
            server.httpServer.close((error) => (error ? reject(error) : resolve()));
            server.httpServer.closeAllConnections();
          });
        } finally {
          await fs.rm(fixtureRoot, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
    throw error;
  }
}
