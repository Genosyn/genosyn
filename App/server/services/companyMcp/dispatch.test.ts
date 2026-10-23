import assert from "node:assert/strict";
import type { RequestListener } from "node:http";
import { describe, test } from "node:test";

import express from "express";
import multer from "multer";

import { createApp } from "../../app.js";
import { withTestInstanceSecrets } from "../../test/apiAccess.js";
import { currentAuditContext, withAuditContext } from "../audit.js";
import { InProcessRequestError, requestInProcess, type InProcessRequest } from "./dispatch.js";

/**
 * The in-memory HTTP the Genosyn MCP server calls the App with. These run
 * real Express apps — none of them listening on a port — and check that what
 * a handler sees is what it would see over the network, that the caller gets
 * back exactly what was sent, and that nothing is left running afterwards.
 */

function base(overrides: Partial<InProcessRequest> = {}): InProcessRequest {
  return {
    method: "GET",
    path: "/",
    headers: { host: "genosyn.test" },
    timeoutMs: 2_000,
    maxResponseBytes: 1024 * 1024,
    ...overrides,
  };
}

const json = (body: Buffer) => JSON.parse(body.toString("utf8")) as Record<string, unknown>;

function listener(app: express.Express): RequestListener {
  return app as unknown as RequestListener;
}

describe("a request in memory is a request", () => {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.get("/whoami", (req, res) => {
    res.setHeader("x-seen", "yes");
    res.json({
      ip: req.ip,
      protocol: req.protocol,
      secure: req.secure,
      hostname: req.hostname,
      method: req.method,
      url: req.originalUrl,
      query: req.query,
      authorization: req.headers.authorization ?? null,
      cookie: req.headers.cookie ?? null,
      audit: currentAuditContext(),
    });
  });
  app.post("/echo", (req, res) =>
    res.status(201).json({ body: req.body, type: req.headers["content-type"] }),
  );
  app.delete("/things/:id", (req, res) => res.status(204).end());
  app.get("/boom", () => {
    throw new Error("handler exploded");
  });

  test("method, path, query and headers arrive as sent; the response comes back whole", async () => {
    const response = await requestInProcess(
      listener(app),
      base({
        path: "/whoami?q=ada&tags=a&tags=b",
        headers: { host: "genosyn.test", authorization: "Bearer gen_x" },
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(response.truncated, false);
    assert.equal(response.headers["x-seen"], "yes");
    assert.match(String(response.headers["content-type"]), /application\/json/);
    const seen = json(response.body);
    assert.equal(seen.method, "GET");
    assert.equal(seen.url, "/whoami?q=ada&tags=a&tags=b");
    assert.deepEqual(seen.query, { q: "ada", tags: ["a", "b"] });
    assert.equal(seen.authorization, "Bearer gen_x");
    assert.equal(seen.hostname, "genosyn.test");
    assert.equal(seen.cookie, null);
  });

  test("the caller's address and TLS state resolve exactly as for the outer request", async () => {
    // Behind one trusted proxy: the proxy's address on the socket, the client in the header.
    const proxied = json(
      (
        await requestInProcess(
          listener(app),
          base({
            path: "/whoami",
            headers: {
              host: "genosyn.test",
              "x-forwarded-for": "203.0.113.9",
              "x-forwarded-proto": "https",
            },
            remote: { address: "10.0.0.2", port: 51234, family: "IPv4" },
          }),
        )
      ).body,
    );
    assert.equal(proxied.ip, "203.0.113.9");
    assert.equal(proxied.protocol, "https");
    assert.equal(proxied.secure, true);
    // Direct TLS, no proxy headers: the socket speaks for itself.
    const direct = json(
      (
        await requestInProcess(
          listener(app),
          base({ path: "/whoami", remote: { address: "198.51.100.4", encrypted: true } }),
        )
      ).body,
    );
    assert.equal(direct.ip, "198.51.100.4");
    assert.equal(direct.protocol, "https");
  });

  test("starts from a clean async context, whatever the outer request carried", async () => {
    const seen = await withAuditContext({ runId: "run-from-outside" }, () =>
      requestInProcess(listener(app), base({ path: "/whoami" })),
    );
    assert.equal(json(seen.body).audit, null);
  });

  test("a JSON body is parsed by the app's own parser", async () => {
    const body = Buffer.from(JSON.stringify({ name: "Ada", tags: [1, 2] }));
    const response = await requestInProcess(
      listener(app),
      base({
        method: "POST",
        path: "/echo",
        headers: { host: "genosyn.test", "content-type": "application/json" },
        body,
      }),
    );
    assert.equal(response.status, 201);
    assert.deepEqual(json(response.body), {
      body: { name: "Ada", tags: [1, 2] },
      type: "application/json",
    });
  });

  test("an empty answer is an empty body", async () => {
    const response = await requestInProcess(
      listener(app),
      base({ method: "DELETE", path: "/things/1" }),
    );
    assert.equal(response.status, 204);
    assert.equal(response.body.length, 0);
  });

  test("a handler that throws answers 500 through the app, never as a rejection", async () => {
    const response = await requestInProcess(listener(app), base({ path: "/boom" }));
    assert.equal(response.status, 500);
  });

  test("no route is the app's own 404", async () => {
    const response = await requestInProcess(listener(app), base({ path: "/nowhere" }));
    assert.equal(response.status, 404);
  });
});

describe("bodies the app reads with its own middleware", () => {
  test("a multipart form reaches multer: fields and the file's bytes", async () => {
    const app = express();
    app.post("/upload", multer({ storage: multer.memoryStorage() }).single("file"), (req, res) => {
      res.json({
        fields: req.body,
        name: req.file?.originalname,
        type: req.file?.mimetype,
        bytes: req.file?.buffer.toString("base64"),
      });
    });
    const boundary = "----test-boundary";
    const fileBytes = Buffer.from([0, 1, 2, 250, 251, 252]);
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nQ3 report\r\n`,
      ),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="q3.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      fileBytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const response = await requestInProcess(
      listener(app),
      base({
        method: "POST",
        path: "/upload",
        headers: { host: "x", "content-type": `multipart/form-data; boundary=${boundary}` },
        body,
      }),
    );
    assert.deepEqual(json(response.body), {
      fields: { title: "Q3 report" },
      name: "q3.bin",
      type: "application/octet-stream",
      bytes: fileBytes.toString("base64"),
    });
  });
});

describe("limits", () => {
  test("a response longer than the limit is cut there and marked", async () => {
    const app = express();
    app.get("/big", (_req, res) => res.type("text/plain").send("x".repeat(50_000)));
    const response = await requestInProcess(
      listener(app),
      base({ path: "/big", maxResponseBytes: 10_000 }),
    );
    assert.equal(response.status, 200);
    assert.equal(response.truncated, true);
    assert.equal(response.body.length, 10_000);
  });

  test("a response that never ends is returned as far as it got when time runs out", async () => {
    const app = express();
    let closed = false;
    app.get("/stream", (req, res) => {
      res.setHeader("content-type", "text/event-stream");
      res.flushHeaders();
      res.write("event: hello\ndata: 1\n\n");
      req.on("close", () => {
        closed = true;
      });
    });
    const response = await requestInProcess(
      listener(app),
      base({ path: "/stream", timeoutMs: 200 }),
    );
    assert.equal(response.status, 200);
    assert.equal(response.truncated, true);
    assert.match(response.body.toString(), /event: hello/);
    for (let attempt = 0; attempt < 20 && !closed; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(closed, true, "the handler saw the connection close");
  });

  test("no answer at all is a timeout", async () => {
    const app = express();
    app.get("/silent", () => undefined);
    await assert.rejects(
      requestInProcess(listener(app), base({ path: "/silent", timeoutMs: 100 })),
      (error: InProcessRequestError) => {
        assert.equal(error.code, "timeout");
        assert.match(error.message, /did not answer within/);
        return true;
      },
    );
  });

  test("a cancelled call stops waiting, and the handler sees its client go", async () => {
    const app = express();
    let closed = false;
    app.get("/slow", (req) => {
      req.on("close", () => {
        closed = true;
      });
    });
    const controller = new AbortController();
    const pending = requestInProcess(
      listener(app),
      base({ path: "/slow", signal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(pending, (error: InProcessRequestError) => error.code === "aborted");
    for (let attempt = 0; attempt < 20 && !closed; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(closed, true);
    const already = new AbortController();
    already.abort();
    await assert.rejects(
      requestInProcess(listener(app), base({ path: "/slow", signal: already.signal })),
      (error: InProcessRequestError) => error.code === "aborted",
    );
  });
});

describe("many at once, and nothing left behind", () => {
  test("concurrent requests each get their own answer", async () => {
    const app = express();
    app.use(express.json());
    app.post("/n", async (req, res) => {
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 10));
      res.json({ n: (req.body as { n: number }).n });
    });
    const answers = await Promise.all(
      Array.from({ length: 40 }, (_, n) =>
        requestInProcess(
          listener(app),
          base({
            method: "POST",
            path: "/n",
            headers: { host: "x", "content-type": "application/json" },
            body: Buffer.from(JSON.stringify({ n })),
          }),
        ),
      ),
    );
    assert.deepEqual(
      answers.map((answer) => json(answer.body).n),
      Array.from({ length: 40 }, (_, n) => n),
    );
  });

  test("timers are cleared once each request settles", async () => {
    const app = express();
    app.get("/", (_req, res) => res.json({ ok: true }));
    const timers = () =>
      process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;
    const before = timers();
    for (let index = 0; index < 25; index++) await requestInProcess(listener(app), base());
    assert.ok(timers() <= before + 1, `${timers()} timers after, ${before} before`);
  });
});

describe("the real App", () => {
  test("answers through its whole stack without listening anywhere", async () => {
    // Throwaway secrets: the session middleware must not create any beside real data.
    const restoreSecrets = withTestInstanceSecrets();
    try {
      const app = createApp();
      const response = await requestInProcess(
        app as unknown as RequestListener,
        base({ path: "/api/health" }),
      );
      assert.equal(response.status, 200);
      assert.equal(json(response.body).ok, true);
      // Its security headers ran, as for any request.
      assert.equal(response.headers["x-content-type-options"], "nosniff");
      const unauthorized = await requestInProcess(
        app as unknown as RequestListener,
        base({ path: "/api/companies/00000000-0000-4000-8000-000000000000/tags" }),
      );
      assert.equal(unauthorized.status, 401);
    } finally {
      restoreSecrets();
    }
  });
});
