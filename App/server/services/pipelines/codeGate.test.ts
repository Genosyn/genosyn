import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { config } from "../../../config.js";
import { closeTestDb, initTestDb, resetTestDb, testCompanyId, testId } from "../../test/dbHarness.js";
import { HANDLERS } from "./handlers.js";
import {
  assertPipelineCodeAllowed,
  executePipelineCode,
  pipelineCodeAllowed,
} from "./codeRuntime.js";
import { NODE_CATALOG } from "./catalog.js";
import { validateGraph } from "./validate.js";
import { PipelineNode } from "./types.js";

/**
 * The `logic.code` node is refused in shared SaaS mode.
 *
 * `vm.createContext` is not a security boundary — `codeRuntime.ts` has always
 * said so in its own header — and the consequence on a shared install is not
 * subtle: the sandbox's callables are host functions, so
 * `axios.constructor.constructor("return process")()` returns the worker's
 * real `process`. The worker is a thread, so it shares the pid, receives a
 * copy of the parent environment (no `env` is passed to `new Worker`), and
 * still reaches `process.binding("spawn_sync")`. On a hosted install that is
 * the encryption secret, the session secret and the database URL, for anyone
 * who can reach company admin — which is every signup, on a company they
 * created.
 *
 * So the invariant this file pins is not "the sandbox holds". It is "the code
 * never runs at all when `multiTenant` is set", enforced at three independent
 * doors, of which the execution seam is the one that cannot be routed around.
 */

const security = config.security as { multiTenant: boolean };
const originalMultiTenant = security.multiTenant;

/** The canonical escape. Kept verbatim so a future reader can re-run it. */
const ESCAPE_PAYLOAD = `
  const P = axios.constructor.constructor("return process")();
  return { pid: P.pid, secretNames: Object.keys(P.env).filter((k) => k.startsWith("GENOSYN")) };
`;

let cid: string;

before(initTestDb);
beforeEach(async () => {
  await resetTestDb();
  cid = testCompanyId();
});
afterEach(() => {
  security.multiTenant = originalMultiTenant;
});
after(closeTestDb);

function runEnv() {
  return {
    trigger: { kind: "manual" as const, payload: {} },
    nodeOutputs: {},
  };
}

async function runCode(code: string, timeoutSeconds = 5) {
  return executePipelineCode({
    code,
    timeoutSeconds,
    companyId: cid,
    env: runEnv() as never,
    log: () => {},
  });
}

describe("pipelineCodeAllowed", () => {
  test("single-tenant self-host keeps the node", () => {
    security.multiTenant = false;
    assert.equal(pipelineCodeAllowed(), true);
    assert.doesNotThrow(() => assertPipelineCodeAllowed());
  });

  test("shared SaaS refuses it", () => {
    security.multiTenant = true;
    assert.equal(pipelineCodeAllowed(), false);
    assert.throws(() => assertPipelineCodeAllowed(), /not a security boundary/);
  });

  test("the refusal names the step the way the UI does", () => {
    security.multiTenant = true;
    assert.throws(() => assertPipelineCodeAllowed(), /Run JavaScript/);
  });
});

describe("executePipelineCode — the seam that cannot be routed around", () => {
  test("shared SaaS refuses the most harmless possible program", async () => {
    security.multiTenant = true;
    await assert.rejects(() => runCode("return 1;"), /not a security boundary/);
  });

  test("shared SaaS refuses the escape payload before it can run", async () => {
    security.multiTenant = true;
    await assert.rejects(() => runCode(ESCAPE_PAYLOAD), /not a security boundary/);
  });

  test("shared SaaS refuses a program that would exec", async () => {
    security.multiTenant = true;
    await assert.rejects(
      () =>
        runCode(`
          const P = axios.constructor.constructor("return process")();
          return P.binding("spawn_sync") ? "reached" : "blocked";
        `),
      /not a security boundary/,
    );
  });

  test("the refusal happens before any worker is spawned", async () => {
    security.multiTenant = true;
    // A program that would never terminate on its own. If the gate ran after
    // the worker started, this would hang until the deadline instead of
    // rejecting immediately, so a fast rejection is the observable proof that
    // nothing was spawned.
    const started = Date.now();
    await assert.rejects(() => runCode("for (;;) {}", 30), /not a security boundary/);
    assert.ok(
      Date.now() - started < 5_000,
      "expected an immediate refusal, not one that waited on a worker",
    );
  });

  test("single-tenant still runs code — the gate is not a silent kill switch", async () => {
    security.multiTenant = false;
    // A generous budget on purpose: this asserts the gate is not a silent kill
    // switch, not that a worker starts quickly. The default 5s is reachable on
    // a loaded machine running several test files at once.
    const outputs = await runCode('return "still works";', 60);
    assert.deepEqual(outputs, { result: "still works" });
  });
});

describe("the handler door", () => {
  test("logic.code refuses in shared SaaS", async () => {
    security.multiTenant = true;
    const handler = HANDLERS["logic.code"];
    assert.ok(handler);
    const node: PipelineNode = {
      id: "n_code",
      type: "logic.code",
      x: 0,
      y: 0,
      config: { code: "return 1;", timeoutSeconds: 5 },
    };
    await assert.rejects(
      () =>
        handler({
          companyId: cid,
          pipelineId: testId("pl"),
          runId: testId("plr"),
          node,
          config: node.config,
          env: runEnv(),
          log: () => {},
        } as never),
      /not a security boundary/,
    );
  });
});

describe("the authoring door", () => {
  const graphWithCode = {
    nodes: [
      { id: "t", type: "trigger.manual", x: 0, y: 0, config: {} },
      { id: "c", type: "logic.code", x: 1, y: 0, config: { code: "return 1;" } },
    ],
    edges: [{ id: "e", source: "t", target: "c" }],
  };

  test("shared SaaS reports the code step as an error on the step itself", () => {
    security.multiTenant = true;
    const issues = validateGraph(graphWithCode as never);
    const issue = issues.find((i) => i.nodeId === "c" && /not a security boundary/.test(i.message));
    assert.ok(issue, "expected an issue naming the code step");
    assert.equal(issue?.severity, "error");
  });

  test("the message points at what to use instead", () => {
    security.multiTenant = true;
    const issues = validateGraph(graphWithCode as never);
    const issue = issues.find((i) => i.nodeId === "c" && /not a security boundary/.test(i.message));
    assert.match(String(issue?.message), /logic\.http|integration\.invoke/);
  });

  test("single-tenant raises no such issue", () => {
    security.multiTenant = false;
    const issues = validateGraph(graphWithCode as never);
    assert.equal(
      issues.filter((i) => /not a security boundary/.test(i.message)).length,
      0,
    );
  });

  test("a graph without a code step is unaffected either way", () => {
    const plain = {
      nodes: [
        { id: "t", type: "trigger.manual", x: 0, y: 0, config: {} },
        { id: "d", type: "logic.delay", x: 1, y: 0, config: { seconds: 1 } },
      ],
      edges: [{ id: "e", source: "t", target: "d" }],
    };
    security.multiTenant = true;
    const hosted = validateGraph(plain as never);
    security.multiTenant = false;
    const selfHosted = validateGraph(plain as never);
    assert.deepEqual(hosted, selfHosted);
  });
});

describe("the palette door", () => {
  test("the catalog ships the code node, so filtering is what removes it", () => {
    assert.ok(
      NODE_CATALOG.some((entry) => entry.type === "logic.code"),
      "logic.code should still exist in the catalog — self-host keeps it",
    );
  });

  test("filtering by pipelineCodeAllowed drops exactly one entry", () => {
    security.multiTenant = true;
    const filtered = NODE_CATALOG.filter((entry) => entry.type !== "logic.code");
    assert.equal(filtered.length, NODE_CATALOG.length - 1);
    assert.ok(!filtered.some((entry) => entry.type === "logic.code"));
  });
});

describe("why the gate exists", () => {
  /**
   * This test asserts the sandbox IS escapable on a single-tenant install.
   *
   * It is deliberately phrased as a live check rather than a comment, because
   * the gate above is only justified for as long as this is true. If someone
   * rebuilds the code node out-of-process — scrubbed environment, no
   * `process.binding`, no shared pid — this test SHOULD start failing. That
   * failure is the signal to re-read `assertPipelineCodeAllowed` and decide
   * whether hosted installs can have the node back; it is not a regression.
   *
   * Nothing here asserts on a secret's value: it reads names only, so a
   * failure message can never carry one.
   */
  test("single-tenant: the vm context does not contain the host realm", async () => {
    security.multiTenant = false;
    // An object return becomes the outputs directly (codeRuntime.ts), so the
    // escaped fields are top-level rather than under `result`.
    const escaped = (await runCode(ESCAPE_PAYLOAD, 60)) as {
      pid?: number;
      secretNames?: string[];
    };
    assert.equal(
      escaped.pid,
      process.pid,
      "the sandbox reached the host process — this is the reason multiTenant refuses this node",
    );
    assert.ok(
      Array.isArray(escaped.secretNames),
      "the escaped realm could enumerate the parent environment",
    );
  });
});
