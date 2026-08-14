import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, test } from "node:test";
import express from "express";

import { errorHandler } from "./error.js";

let server: http.Server;
let baseUrl = "";

before(async () => {
  const app = express();
  app.get("/internal", () => {
    throw new Error("postgresql://operator:secret@database/internal");
  });
  app.get("/client", () => {
    const error = new Error("Invalid request") as Error & { status: number };
    error.status = 400;
    throw error;
  });
  app.get("/invalid-status", () => {
    const error = new Error("private detail") as Error & { status: number };
    error.status = 200;
    throw error;
  });
  app.use(errorHandler);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(
  () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
);

describe("error handler disclosure boundary", () => {
  test("hides unexpected server error details", async () => {
    const response = await fetch(`${baseUrl}/internal`);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "Internal server error" });
  });

  test("preserves an intentional client-safe 4xx message", async () => {
    const response = await fetch(`${baseUrl}/client`);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Invalid request" });
  });

  test("normalizes invalid status values and hides their detail", async () => {
    const response = await fetch(`${baseUrl}/invalid-status`);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "Internal server error" });
  });
});
