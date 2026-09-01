import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { User } from "../db/entities/User.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testId } from "../test/dbHarness.js";
import { errorHandler, logRedactedError, redactErrorForLog } from "./error.js";

/**
 * Tenant content must never reach the operator log.
 *
 * The handler used to be `console.error("[error]", err)` on the whole object.
 * TypeORM's `QueryFailedError` carries `query` and `parameters` as own
 * enumerable properties, and Node prints them — so every failed INSERT or
 * UPDATE exported its bound values: the chat message, the mail body, the Soul,
 * the customer's name. On a hosted install stdout goes to an aggregator with
 * its own retention, outside any tenant's deletion request. That makes it the
 * one item on the hardening list that cannot be fixed after the fact, which is
 * why the projection is an allowlist rather than a denylist: a driver error
 * that grows a new value-bearing property in some future release does not
 * silently start being logged.
 */

const SECRET = "sk-live-do-not-log-this-value";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

/** Capture what the module actually writes, not what we hope it writes. */
function captureConsoleError<T>(fn: () => T): { result: T; written: string } {
  const original = console.error;
  const chunks: string[] = [];
  // eslint-disable-next-line no-console
  console.error = (...args: unknown[]) => {
    chunks.push(args.map((a) => JSON.stringify(a) ?? String(a)).join(" "));
  };
  try {
    const result = fn();
    return { result, written: chunks.join("\n") };
  } finally {
    // eslint-disable-next-line no-console
    console.error = original;
  }
}

describe("redactErrorForLog — the projection", () => {
  test("keeps the fields an on-call engineer actually uses", () => {
    const err = Object.assign(new Error("boom"), { status: 503, code: "ECONNRESET" });
    const out = redactErrorForLog(err);
    assert.equal(out.name, "Error");
    assert.equal(out.message, "boom");
    assert.equal(out.status, 503);
    assert.equal(out.code, "ECONNRESET");
    assert.ok(out.stack?.includes("boom"));
  });

  test("drops bound query parameters", () => {
    const err = Object.assign(new Error("insert failed"), {
      name: "QueryFailedError",
      query: 'INSERT INTO "users"("email") VALUES ($1)',
      parameters: [SECRET],
    });
    const out = redactErrorForLog(err);
    assert.equal(out.query, 'INSERT INTO "users"("email") VALUES ($1)');
    assert.equal(JSON.stringify(out).includes(SECRET), false);
    assert.equal("parameters" in out, false);
  });

  test("keeps the SQL, because the statement is not the row", () => {
    const err = Object.assign(new Error("x"), {
      query: 'UPDATE "channel_messages" SET "content" = $1 WHERE "id" = $2',
      parameters: ["a private message", "id_1"],
    });
    const out = redactErrorForLog(err);
    assert.match(String(out.query), /channel_messages/);
    assert.equal(String(JSON.stringify(out)).includes("a private message"), false);
  });

  test("ignores every property it was not told about", () => {
    const err = Object.assign(new Error("x"), {
      // The shape a future driver release might add.
      values: [SECRET],
      row: { email: SECRET },
      detail: `Key (email)=(${SECRET}) already exists`,
      parameters: [SECRET],
      driverError: { parameters: [SECRET] },
    });
    const out = redactErrorForLog(err);
    assert.equal(JSON.stringify(out).includes(SECRET), false);
  });

  test("redacts a cause the same way", () => {
    const inner = Object.assign(new Error("inner"), { parameters: [SECRET] });
    const outer = Object.assign(new Error("outer"), { cause: inner });
    const out = redactErrorForLog(outer);
    assert.equal(out.cause?.message, "inner");
    assert.equal(JSON.stringify(out).includes(SECRET), false);
  });

  test("does not walk a cause chain forever", () => {
    const a: Record<string, unknown> = { name: "A", message: "a" };
    const b: Record<string, unknown> = { name: "B", message: "b", cause: a };
    a.cause = b;
    const out = redactErrorForLog(b);
    assert.equal(out.cause?.name, "A");
    assert.equal(out.cause?.cause, undefined);
  });

  test("survives a self-referential error object", () => {
    const err: Record<string, unknown> = { name: "Cyclic", message: "loop" };
    err.self = err;
    err.cause = err;
    const out = redactErrorForLog(err);
    assert.equal(out.name, "Cyclic");
    assert.doesNotThrow(() => JSON.stringify(out));
  });

  test("truncates a huge message rather than shipping it whole", () => {
    const err = new Error("x".repeat(50_000));
    const out = redactErrorForLog(err);
    assert.ok(out.message.length < 3_000);
    assert.match(out.message, /truncated/);
  });

  test("truncates a huge query", () => {
    const err = Object.assign(new Error("x"), { query: "SELECT ".repeat(10_000) });
    const out = redactErrorForLog(err);
    assert.ok(String(out.query).length < 3_000);
  });

  test("handles a thrown string", () => {
    const out = redactErrorForLog("just a string");
    assert.equal(out.message, "just a string");
    assert.equal(out.name, "Error");
  });

  test("handles thrown null and undefined", () => {
    assert.equal(redactErrorForLog(null).message, "null");
    assert.equal(redactErrorForLog(undefined).message, "undefined");
  });

  test("handles a thrown number", () => {
    assert.equal(redactErrorForLog(42).message, "42");
  });

  test("a numeric code is normalised to a string", () => {
    const out = redactErrorForLog(Object.assign(new Error("x"), { code: 1062 }));
    assert.equal(out.code, "1062");
  });

  test("a non-integer status is dropped rather than logged as-is", () => {
    const out = redactErrorForLog(Object.assign(new Error("x"), { status: 4.5 }));
    assert.equal(out.status, undefined);
  });
});

describe("redactErrorForLog — against a real TypeORM error", () => {
  /**
   * The whole fix rests on one claim about a third-party object: that
   * `QueryFailedError` exposes `parameters` as an own enumerable property and
   * that Node therefore prints it. This provokes a genuine one rather than
   * asserting against a hand-built lookalike, so an upgrade that changes the
   * shape fails here instead of silently in production.
   */
  test("a genuine QueryFailedError carries the row, and the projection drops it", async () => {
    const users = AppDataSource.getRepository(User);
    const email = `${SECRET}@example.com`;
    await insert(User, {
      id: testId("usr"),
      email,
      name: "First",
      passwordHash: "x",
    } as never);

    let caught: unknown = null;
    try {
      // Same email a second time: `users.email` is unique.
      await users.insert({
        id: testId("usr"),
        email,
        name: "Second",
        passwordHash: "x",
      } as never);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, "expected the duplicate insert to fail");

    // The premise: the raw object really would have leaked the address.
    const rawDump = JSON.stringify(caught, Object.getOwnPropertyNames(caught));
    assert.ok(
      rawDump.includes(SECRET),
      "premise failed — the raw error no longer carries the row, so re-read this fix",
    );

    // The fix: the projection does not.
    const out = redactErrorForLog(caught);
    assert.equal(JSON.stringify(out).includes(SECRET), false);
  });

  test("what is actually written to the console carries no row values", async () => {
    const users = AppDataSource.getRepository(User);
    const email = `${SECRET}@example.com`;
    await insert(User, {
      id: testId("usr"),
      email,
      name: "First",
      passwordHash: "x",
    } as never);
    let caught: unknown = null;
    try {
      await users.insert({
        id: testId("usr"),
        email,
        name: "Second",
        passwordHash: "x",
      } as never);
    } catch (err) {
      caught = err;
    }

    const { written } = captureConsoleError(() => logRedactedError("[error]", caught));
    assert.ok(written.length > 0, "expected something to be logged");
    assert.equal(written.includes(SECRET), false);
  });
});

describe("errorHandler", () => {
  function invoke(err: unknown) {
    let status: number | null = null;
    let body: unknown = null;
    const res = {
      status(code: number) {
        status = code;
        return this;
      },
      json(payload: unknown) {
        body = payload;
        return this;
      },
    } as never;
    const { written } = captureConsoleError(() =>
      errorHandler(err, {} as never, res, (() => {}) as never),
    );
    return { status, body, written };
  }

  test("still logs, and still answers the request", () => {
    const out = invoke(new Error("boom"));
    assert.equal(out.status, 500);
    assert.deepEqual(out.body, { error: "Internal server error" });
    assert.ok(out.written.includes("[error]"));
  });

  test("a 4xx keeps its message, as before", () => {
    const out = invoke(Object.assign(new Error("Bad input"), { status: 400 }));
    assert.equal(out.status, 400);
    assert.deepEqual(out.body, { error: "Bad input" });
  });

  test("a query failure answers generically and logs no parameters", () => {
    const out = invoke(
      Object.assign(new Error("insert failed"), {
        name: "QueryFailedError",
        query: "INSERT INTO x VALUES ($1)",
        parameters: [SECRET],
      }),
    );
    assert.equal(out.status, 500);
    assert.deepEqual(out.body, { error: "Internal server error" });
    assert.equal(out.written.includes(SECRET), false);
    assert.ok(out.written.includes("INSERT INTO x"));
  });

  test("an out-of-range status falls back to 500", () => {
    assert.equal(invoke(Object.assign(new Error("x"), { status: 999 })).status, 500);
    assert.equal(invoke(Object.assign(new Error("x"), { status: 99 })).status, 500);
  });
});
