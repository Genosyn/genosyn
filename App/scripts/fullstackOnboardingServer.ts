/** Disposable real-app boot for test-onboarding-fullstack.ts; never reads a developer database. */
import "reflect-metadata";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import express from "express";
import { config } from "../config.js";

const testRoot = process.argv[2];
assert(testRoot && path.basename(testRoot).startsWith("genosyn-onboarding-fullstack-"));
assert.equal(path.dirname(fs.realpathSync(testRoot)), fs.realpathSync(os.tmpdir()));
const port = Number(process.argv[3] ?? "18487");
const uiPort = Number(process.argv[4] ?? "18489");
const clientDir = fileURLToPath(new URL("../dist/client/", import.meta.url));
assert(
  fs.existsSync(path.join(clientDir, "index.html")),
  "Run npm run build:client before the fullstack browser suite.",
);
Object.assign(config, {
  dataDir: path.join(testRoot, "data"),
  port,
  sessionSecret: randomBytes(32).toString("hex"),
});
Object.assign(config.db, {
  sqlitePath: path.join(testRoot, "data", "app.sqlite"),
  driver: "sqlite",
});
Object.assign(config.security, {
  encryptionSecret: randomBytes(32).toString("hex"),
  secureCookies: false,
  trustedProxyHops: 1,
  bootstrapMasterAdminEmail: "onboarding-owner@example.test",
  outboundPrivateHostAllowlist: ["127.0.0.1", "localhost"],
});
Object.assign(config.agent.codingTools, { enabled: false, executionMode: "disabled" });

// Only this fake model is used. It exercises the real custom model streaming client and
// verification endpoint without an external account or network request.
const model = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (req.url === "/v1/chat/completions") {
    const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(request.model, "qa-local-model");
    assert.equal(request.stream, true);
    const probe = request.tools?.some(
      (tool: { function?: { name?: string } }) => tool.function?.name === "connection_test",
    );
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const delta = probe
      ? {
          tool_calls: [
            {
              index: 0,
              id: "qa-probe",
              type: "function",
              function: { name: "connection_test", arguments: '{"ok":true}' },
            },
          ],
        }
      : { content: "No external work performed in this browser regression." };
    res.end(
      `data: ${JSON.stringify({ id: "qa-completion", object: "chat.completion.chunk", created: 1, model: "qa-local-model", choices: [{ index: 0, delta, finish_reason: probe ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
    console.log(`[fullstack-model-probe] ${probe ? "verified" : "reply"}`);
    return;
  }
  if (req.url === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "qa-local-model", object: "model", created: 1 }] }));
    return;
  }
  res.writeHead(404).end();
});
await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
console.log(
  `[fullstack-model-url] http://127.0.0.1:${(model.address() as { port: number }).port}/v1`,
);

// The real router/services run on an isolated current schema; migration tests cover boot SQL.
console.log("[fullstack-stage] importing database schema");
const { initTestDb } = await import("../server/test/dbHarness.js");
console.log("[fullstack-stage] creating isolated database schema");
await initTestDb();
console.log("[fullstack-stage] isolated database ready");
const { setPublicUrl } = await import("../server/services/publicUrl.js");
await setPublicUrl(`http://127.0.0.1:${uiPort}`);
console.log("[fullstack-stage] importing real app server");
await import("../server/index.js");

// Serve the actual production client bundle through a local reverse proxy.
// The API still runs the real source entrypoint with NODE_ENV=production, avoiding
// a second Vite development graph while retaining all API/security middleware.
const ui = express();
ui.use("/api", (req, res) => {
  const upstream = http.request(
    {
      hostname: "127.0.0.1",
      port,
      method: req.method,
      path: req.originalUrl,
      headers: {
        ...req.headers,
        host: `127.0.0.1:${port}`,
        "x-forwarded-host": req.headers.host ?? `127.0.0.1:${uiPort}`,
        "x-forwarded-proto": "http",
      },
    },
    (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    },
  );
  upstream.on("error", () => res.status(502).end());
  req.pipe(upstream);
});
ui.use(express.static(clientDir));
ui.get(/^\/(?!api).*/, (_req, res) => res.sendFile(path.join(clientDir, "index.html")));
const frontend = http.createServer(ui);
frontend.on("upgrade", (req, socket, head) => {
  const upstream = net.connect(port, "127.0.0.1", () => {
    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n`);
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      upstream.write(`${req.rawHeaders[index]}: ${req.rawHeaders[index + 1]}\r\n`);
    }
    upstream.write("\r\n");
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});
await new Promise<void>((resolve) => frontend.listen(uiPort, "127.0.0.1", resolve));
console.log(`[fullstack-stage] built client listening on :${uiPort}`);
