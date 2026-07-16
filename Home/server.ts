import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT) || 8472;
const clientDir = path.resolve(__dirname, "client");
const indexHtml = path.join(clientDir, "index.html");

// redirect: false — prerendered routes exist as directories (see prerender.ts),
// and serve-static would otherwise 301 /products/email to /products/email/,
// fighting the canonical URLs. The catch-all below serves them slash-free.
app.use(express.static(clientDir, { index: false, redirect: false, maxAge: "1h" }));

// Every prerendered route (see prerender.ts) lives at <route>/index.html so
// crawlers get route-specific markup and metadata without executing JS.
// Unknown URLs get the bare SPA shell with a 404 status — index.html holds
// the fully prerendered homepage, so serving it as a catch-all would hand
// every mistyped URL duplicate home content with a 200.
const notFoundHtml = path.join(clientDir, "404.html");

app.get("*", (req, res) => {
  const urlPath = req.path.replace(/\/+$/, "") || "/";
  if (urlPath === "/") {
    res.sendFile(indexHtml);
    return;
  }
  const candidate = path.resolve(clientDir, `.${urlPath}`, "index.html");
  if (candidate.startsWith(clientDir + path.sep) && fs.existsSync(candidate)) {
    res.sendFile(candidate);
    return;
  }
  if (fs.existsSync(notFoundHtml)) {
    res.status(404).sendFile(notFoundHtml);
    return;
  }
  res.sendFile(indexHtml);
});

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`[genosyn-home] serving ${clientDir} on http://0.0.0.0:${port}`);
});
