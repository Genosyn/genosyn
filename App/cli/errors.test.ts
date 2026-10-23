import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  asCliError,
  CliError,
  errorPayload,
  EXIT_CODE_TABLE,
  EXIT_CODES,
  humanError,
  issuesFrom,
  kindForStatus,
  usageError,
  type ErrorKind,
} from "./errors.js";

describe("exit codes", () => {
  test("map every status family to its documented code", () => {
    const cases: Array<[number, ErrorKind, number]> = [
      [400, "validation", 6],
      [422, "validation", 6],
      [401, "auth", 3],
      [403, "forbidden", 4],
      [404, "not_found", 5],
      [409, "conflict", 7],
      [429, "rate_limited", 7],
      [413, "client_error", 7],
      [410, "client_error", 7],
      [500, "server", 8],
      [503, "server", 8],
    ];
    for (const [status, kind, code] of cases) {
      assert.equal(kindForStatus(status), kind, String(status));
      assert.equal(new CliError(kind, "x").exitCode, code, kind);
    }
  });

  test("keep their meanings: the table and the constants agree", () => {
    assert.deepEqual(EXIT_CODES, {
      ok: 0,
      internal: 1,
      usage: 2,
      auth: 3,
      forbidden: 4,
      notFound: 5,
      validation: 6,
      rejected: 7,
      server: 8,
      network: 9,
    });
    assert.deepEqual(
      EXIT_CODE_TABLE.map((row) => row.code),
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    );
    for (const row of EXIT_CODE_TABLE) {
      for (const kind of row.kinds.split(", ").filter(Boolean) as ErrorKind[]) {
        assert.equal(new CliError(kind, "x").exitCode, row.code, kind);
      }
    }
  });

  test("usage and network errors have their own codes", () => {
    assert.equal(usageError("bad").exitCode, 2);
    assert.equal(new CliError("network", "down").exitCode, 9);
    assert.equal(new CliError("internal", "bug").exitCode, 1);
  });
});

describe("the machine-readable error", () => {
  test("carries the kind, message, code, status, request and issues", () => {
    const error = new CliError("validation", "The request didn't pass the server's validation.", {
      status: 400,
      hint: "describe it",
      issues: [{ path: "title", message: "Required", flag: "--title" }],
      response: { error: "ValidationError", issues: [] },
      request: { method: "POST", url: "https://g.test/api/x", operationId: "createX" },
    });
    assert.deepEqual(errorPayload(error), {
      error: {
        kind: "validation",
        message: "The request didn't pass the server's validation.",
        exitCode: 6,
        status: 400,
        hint: "describe it",
        operationId: "createX",
        method: "POST",
        url: "https://g.test/api/x",
        issues: [{ path: "title", message: "Required", flag: "--title" }],
        response: { error: "ValidationError", issues: [] },
      },
    });
  });

  test("leaves out what an error doesn't have", () => {
    assert.deepEqual(errorPayload(usageError("No operation.")), {
      error: { kind: "usage", message: "No operation.", exitCode: 2 },
    });
  });

  test("wraps anything thrown as an internal error, keeping CliErrors", () => {
    const original = usageError("x");
    assert.equal(asCliError(original), original);
    const wrapped = asCliError(new TypeError("boom"));
    assert.equal(wrapped.kind, "internal");
    assert.match(wrapped.message, /Unexpected error: boom/);
    assert.equal(asCliError("plain").message, "Unexpected error: plain");
  });
});

describe("issuesFrom", () => {
  test("flattens zod issues and maps each to its flag", () => {
    const body = {
      error: "ValidationError",
      issues: [
        { code: "invalid_type", path: ["title"], message: "Required" },
        { code: "too_big", path: ["items", 0, "name"], message: "Too long" },
        { code: "custom", path: [], message: "Something" },
        "nonsense",
        { message: 42, path: "legacy" },
      ],
    };
    const flags: Record<string, string> = { title: "--title" };
    assert.deepEqual(issuesFrom(body, (path) => flags[path]), [
      { path: "title", message: "Required", flag: "--title" },
      { path: "items.0.name", message: "Too long" },
      { path: "", message: "Something" },
      { path: "legacy", message: "42" },
    ]);
  });

  test("is empty for bodies without issues", () => {
    assert.deepEqual(issuesFrom({ error: "Nope" }), []);
    assert.deepEqual(issuesFrom(null), []);
    assert.deepEqual(issuesFrom("text"), []);
  });
});

describe("the readable error", () => {
  test("titles the error, lists issues by flag, and ends with the hint", () => {
    const text = humanError(
      new CliError("validation", "The request didn't pass the server's validation.", {
        status: 400,
        issues: [
          { path: "title", message: "Required", flag: "--title" },
          { path: "", message: "Bad" },
        ],
        hint: "`genosyn-api describe createGoal` lists every parameter.",
      }),
      (value) => value,
    );
    assert.equal(
      text,
      "✗ Rejected (400): The request didn't pass the server's validation.\n" +
        "  • --title: Required\n" +
        "  • (request): Bad\n" +
        "  `genosyn-api describe createGoal` lists every parameter.\n",
    );
  });

  test("colors only the mark", () => {
    const text = humanError(usageError("x"), (value) => `<${value}>`);
    assert.equal(text, "<✗> Usage: x\n");
  });
});
