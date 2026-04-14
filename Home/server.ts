import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT) || 3000;
const clientDir = path.resolve(__dirname, "client");
const indexHtml = path.join(clientDir, "index.html");

app.use(express.static(clientDir, { index: false, maxAge: "1h" }));

app.get("*", (_req, res) => {
  res.sendFile(indexHtml);
});

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`[genosyn-home] serving ${clientDir} on http://0.0.0.0:${port}`);
});
