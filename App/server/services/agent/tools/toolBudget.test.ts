import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { STATIC_TOOLS } from "../../../mcp/toolManifest.js";
import { collapseStaticTools } from "./genosynFamilies.js";
import { codingTools } from "./coding.js";
import { createFindToolsTool, createCallTool, DISCOVERY_TOOL_NAMES } from "./discovery.js";
import { createParallelDelegationTool, MAX_DELEGATIONS_PER_TURN } from "./parallelDelegation.js";
import { RESIDENT_GENOSYN_TOOLS } from "./index.js";
import { assertIndexCoversManifest, TOOL_DOMAINS, TOOL_KEYWORDS } from "./toolIndex.js";
import { assertAliasesResolve, RETIRED_FAMILIES } from "./familyAliases.js";
import { assertGrantSetsResolve } from "./grantDead.js";
import type { AgentTool } from "../types.js";

/**
 * Ceilings on the working set — the tools sent to the model on *every* request.
 *
 * The problem this whole subsystem exists to fix was not that any one tool was
 * too big. It was that nothing stopped the total growing by a family per
 * feature until it reached ~19,800 tokens a step. A budget nobody measures is a
 * budget that erodes, so these numbers are the gate: when one fires, the fix is
 * to defer something, or to raise the number *with a stated reason* — never to
 * quietly bump it.
 *
 * Measured in characters rather than tokens on purpose: token counts depend on
 * a tokenizer we do not control and cannot pin (a `custom` endpoint can serve
 * any weights). Characters are exact, reproducible, and move in the same
 * direction. Divide by ~3.6 for a rough token figure.
 */

/**
 * Resident tool count, browser off, delegation on.
 *
 * ~20 today. The headroom is small and deliberate: a couple of slots for a
 * Skill-declared toolset, not room to drift back to a full catalogue.
 */
const RESIDENT_TOOL_COUNT_MAX = 24;

/**
 * Serialized `{name, description, inputSchema}` for the whole resident set.
 *
 * ~15,700 today, against ~71,500 before deferral. 20k leaves room to add one
 * genuinely hot tool without a conversation, and not much more.
 */
const RESIDENT_SCHEMA_CHARS_MAX = 20_000;

/**
 * No single resident tool may exceed this.
 *
 * Catches the other failure mode: not too many tools, but one whose description
 * quietly grows into an essay. `mail` was 10,062 chars before it was retired.
 */
const SINGLE_RESIDENT_TOOL_CHARS_MAX = 2_000;

/**
 * `find_tools`' always-on domain footer.
 *
 * It rides inside a tool result that `loop.ts` clips at `TOOL_RESULT_CAP_MIN`
 * (8,000 chars), and it has to leave room for six full schemas alongside it.
 */
const DOMAIN_FOOTER_CHARS_MAX = 3_500;

function size(tools: { name: string; description: string; inputSchema: unknown }[]): number {
  return JSON.stringify(
    tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  ).length;
}

/** The resident set, assembled from the real sources with no database. */
function residentSet(): AgentTool[] {
  const { collapsed, passthrough } = collapseStaticTools();
  const agentFacing = new Map<string, AgentTool>();
  for (const c of collapsed) {
    agentFacing.set(c.name, {
      name: c.name,
      description: c.description,
      inputSchema: c.inputSchema as Record<string, unknown>,
      run: async () => ({ content: "" }),
    });
  }
  for (const t of passthrough) {
    agentFacing.set(t.name, {
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown>,
      run: async () => ({ content: "" }),
    });
  }

  const genosyn = RESIDENT_GENOSYN_TOOLS.map((n) => {
    const tool = agentFacing.get(n);
    assert.ok(tool, `RESIDENT_GENOSYN_TOOLS names "${n}", which the agent catalogue does not have`);
    return tool;
  });

  const coding = codingTools({ cwd: "/tmp", env: {}, bashTimeoutMs: 1_000 });

  const delegation = createParallelDelegationTool({
    budget: { remaining: MAX_DELEGATIONS_PER_TURN },
    runBrief: async () => ({ status: "completed" as const, output: "" }),
  });

  const discovery = [
    createFindToolsTool({ searchable: [], resolve: () => undefined, grantDead: new Set() }),
    createCallTool({ searchable: [], resolve: () => undefined, grantDead: new Set() }),
  ];

  return [...discovery, ...coding, delegation, ...genosyn];
}

describe("resident tool budget", () => {
  const resident = residentSet();

  test(`the working set is at most ${RESIDENT_TOOL_COUNT_MAX} tools`, () => {
    assert.ok(
      resident.length <= RESIDENT_TOOL_COUNT_MAX,
      `${resident.length} resident tools, ceiling is ${RESIDENT_TOOL_COUNT_MAX}.\n` +
        `Defer one, or raise the ceiling and say why in the same commit.\n` +
        `Resident: ${resident.map((t) => t.name).join(", ")}`,
    );
  });

  test(`the working set serializes to at most ${RESIDENT_SCHEMA_CHARS_MAX} chars`, () => {
    const chars = size(resident);
    assert.ok(
      chars <= RESIDENT_SCHEMA_CHARS_MAX,
      `resident schemas are ${chars} chars (~${Math.round(chars / 3.6)} tokens), ceiling is ` +
        `${RESIDENT_SCHEMA_CHARS_MAX}. This is paid on every step of every run.`,
    );
  });

  test(`no single resident tool exceeds ${SINGLE_RESIDENT_TOOL_CHARS_MAX} chars`, () => {
    const fat = resident
      .map((t) => ({ name: t.name, chars: size([t]) }))
      .filter((t) => t.chars > SINGLE_RESIDENT_TOOL_CHARS_MAX);
    assert.deepEqual(
      fat,
      [],
      `these resident tools are too big for the hot path: ${fat.map((f) => `${f.name} (${f.chars})`).join(", ")}`,
    );
  });

  test("the working set is far under every provider tool cap", () => {
    // OPENAI_MAX_TOOLS is 128. The point of deferral is that this stops being a
    // live constraint — if it ever binds again, deferral has regressed.
    assert.ok(resident.length < 64, `${resident.length} resident tools is close to a provider cap`);
  });
});

describe("discovery footprint", () => {
  test(`the domain footer stays under ${DOMAIN_FOOTER_CHARS_MAX} chars`, async () => {
    const { collapsed, passthrough } = collapseStaticTools();
    const searchable: AgentTool[] = [...collapsed, ...passthrough].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown>,
      run: async () => ({ content: "" }),
    }));
    const find = createFindToolsTool({
      searchable,
      resolve: () => undefined,
      grantDead: new Set(),
    });

    // A query that matches nothing returns the footer and nothing else.
    const out = await find.run({ query: "zzzz nonsense qqqq" });
    assert.ok(
      out.content.length <= DOMAIN_FOOTER_CHARS_MAX,
      `the miss-case find_tools result is ${out.content.length} chars, ceiling is ` +
        `${DOMAIN_FOOTER_CHARS_MAX}. It must leave room for six schemas inside an 8,000-char cap.`,
    );
  });
});

describe("catalogue invariants", () => {
  test("the domain index covers the manifest exactly", () => {
    assert.doesNotThrow(assertIndexCoversManifest);
  });

  test("every retired family alias still resolves", () => {
    assert.doesNotThrow(assertAliasesResolve);
  });

  test("every grant-gated name still exists in the manifest", () => {
    assert.doesNotThrow(assertGrantSetsResolve);
  });

  test("the discovery names are reserved", () => {
    assert.deepEqual(DISCOVERY_TOOL_NAMES, ["find_tools", "call_tool"]);
    // Nothing in the manifest may shadow them, or dedupe would rename ours.
    const clash = STATIC_TOOLS.filter((t) => DISCOVERY_TOOL_NAMES.includes(t.name));
    assert.deepEqual(clash, []);
  });

  test("every keyword key names a real tool", () => {
    const known = new Set(STATIC_TOOLS.map((t) => t.name));
    const bad = Object.keys(TOOL_KEYWORDS).filter((n) => !known.has(n));
    assert.deepEqual(bad, []);
  });

  test("every manifest tool has a domain, and no domain invents one", () => {
    const known = new Set(STATIC_TOOLS.map((t) => t.name));
    const indexed = Object.values(TOOL_DOMAINS).flatMap((d) => d.tools);
    assert.deepEqual(
      [...known].filter((n) => !indexed.includes(n)),
      [],
      "unindexed tools are unreachable through find_tools",
    );
    assert.deepEqual(indexed.filter((n) => !known.has(n)), []);
  });

  test("the retired families are hidden, not deleted", () => {
    // The compatibility promise: fifteen names customers' Skills may still use.
    assert.equal(Object.keys(RETIRED_FAMILIES).length, 15);
    assert.ok(RETIRED_FAMILIES.mail, "the mail alias is the one most likely to be named in prose");
    assert.ok(RETIRED_FAMILIES.finance);
    assert.ok(RETIRED_FAMILIES.base_rows);
  });
});
