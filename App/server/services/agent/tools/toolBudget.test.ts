import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { STATIC_TOOLS } from "../../../mcp/toolManifest.js";
import { collapseStaticTools } from "./genosynFamilies.js";
import { codingTools } from "./coding.js";
import { createFindToolsTool, createCallTool, DISCOVERY_TOOL_NAMES } from "./discovery.js";
import { createParallelDelegationTool, MAX_DELEGATIONS_PER_TURN } from "./parallelDelegation.js";
import { createChatProgressTool } from "./chatProgress.js";
import { RESIDENT_GENOSYN_TOOLS } from "./index.js";
import { assertIndexCoversManifest, TOOL_DOMAINS, TOOL_KEYWORDS } from "./toolIndex.js";
import { assertAliasesResolve, RETIRED_FAMILIES } from "./familyAliases.js";
import { assertGrantSetsResolve } from "./grantDead.js";
import { SIGNING_ACCESS_RANK } from "../../../db/entities/EmployeeSigningGrant.js";
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
 * ~20,100 today, against ~71,500 before deferral. Raised from 20,000 in M48:
 * the set had already grown to 19,907 — 99.5% of that ceiling — so the two
 * `folder` params that let an AI employee file its own Routines (symmetric with
 * the `tags` param already on both tools) had 93 chars to land in, which is not
 * enough for two descriptions a model can act on. The params are trimmed to the
 * bone; this buys back a little headroom rather than leaving the next change
 * with none. Roughly 53 tokens a step — small, but paid on every step of every
 * run, so keep spending it deliberately.
 */
const RESIDENT_SCHEMA_CHARS_MAX = 20_200;

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
 * (8,000 chars), and it has to leave room for returned schemas alongside it.
 * M35 adds twelve granular Marketing tools whose exact names are part of the
 * recall backstop. The extra headroom is intentional: abbreviating or hiding
 * exact tool names would make autonomous operations undiscoverable. M20's
 * three AI-native Explore tools take the miss-case footer just over 4,000
 * characters. The six granular signing tools add their exact, independently
 * callable names to that same recall backstop.
 *
 * Raised to 4,400 for the `web` domain (`search_web`, `fetch_web_page`,
 * `download_web_file`) plus `read_mail_attachment`. These four are the tools
 * an employee reaches for precisely when it does *not* already know what it
 * has — "find the current form", "open what they sent" — so a lexical miss
 * that hid them would be the exact failure this footer exists to prevent.
 * 4,400 still leaves 45% of the 8,000-char result envelope for schemas.
 *
 * Raised to 4,440 for `get_routine`. `list_routines` used to carry every
 * routine's full brief, which pushed a long listing past the result cap and cut
 * the ids off the end — so the listing now previews briefs and `get_routine`
 * serves the full one. That makes its exact name load-bearing: an employee that
 * cannot discover it can read a routine's schedule and never its brief, which
 * is the recall failure this footer exists to prevent. Thirteen characters buys
 * the tool that keeps the listing itself inside the same envelope.
 *
 * Raised from 4,440 for the `repository_*` family (M21.5). Six new deferred
 * names cost about sixty characters after brace-compaction, and there is no
 * way to buy that back without dropping a name a model would then be unable to
 * discover — the exact failure this footer exists to prevent. 4,600 still
 * leaves over 3,400 characters for the six schemas inside the 8,000-char cap,
 * which is what the ceiling is protecting.
 *
 * Raised to 4,640 for `read_docx`, `edit_docx` and `create_docx` (M41), which
 * cost the same twenty-odd characters between them by extending the existing
 * `files` domain rather than opening a `documents` one — a new domain key
 * would have cost roughly twenty more for its label line alone, to say
 * something `files` already says. The three names have to appear in full
 * because a Word document is the case where an employee least knows what it
 * has: a `.docx` used to reach it as "binary or unsupported type", so the
 * employee asked for a PDF instead of the file already in front of it. A
 * lexical miss that hid these would restore precisely that dead end.
 *
 * Raised to 4,720 for the four recurring-invoice tools. The distinction from
 * both one-off invoices and AI Routines is load-bearing: a lexical miss for
 * "annual renewal" must surface the schedule tools or an employee will again
 * claim Finance cannot automate the next invoice. The extra 80 characters
 * still leave more than 3,200 for the returned schemas inside the 8,000-char
 * result envelope.
 *
 * Raised to 4,840 for the ten `pipelines` tools, the largest single jump here
 * and the one with the least room to argue it down. Pipelines were the only
 * shipped primitive with no MCP surface at all, so there is no partial
 * discovery to fall back on: an employee that misses these does not get a
 * worse tool, it concludes the product cannot do the thing and says so. That
 * is not hypothetical — it is the report this family was built from. The names
 * also have to appear in full because the vocabulary a model reaches for here
 * ("webhook receiver", "automation", "zapier") matches none of them lexically,
 * which is exactly the case the footer backstops. 4,840 still leaves more than
 * 3,100 characters for the six returned schemas inside the 8,000-char cap.
 *
 * Raised to 4,860 for `convert_to_pdf`, which extends the existing `files`
 * domain and costs fifteen characters. It buys back the last step of the
 * errand the Word tools were built for. An employee that reads a `.docx` NDA
 * off an email and cannot turn it into a PDF stops at exactly the sentence
 * M41 was meant to delete — "I can't do this, it's a Word document" — because
 * signing takes a PDF Resource and nothing else. The name has to be in the
 * footer in full: the model asks for this by the outcome ("save as PDF",
 * "send them a PDF copy"), which matches no other tool in the catalogue
 * lexically, and a miss here is indistinguishable to the employee from the
 * product being unable to do it.
 *
 * Raised to 4,910 for the three `goals` tools (M51), a new domain costing
 * ~40 characters. Goals are the intent layer — the reason a Routine exists —
 * and an employee told "steer toward the company's goals" that cannot
 * discover `list_goals` concludes the company has none, which is worse than a
 * missing tool: it silently un-grounds every prioritization the prompt asked
 * it to make. `update_goal_progress` must be findable by name because the
 * Goals prompt block names it. 4,910 still leaves ~3,000 characters for the
 * six returned schemas inside the 8,000-char result envelope.
 *
 * Raised to 4,960 for `propose_revision` (M52), a one-tool `improvement`
 * domain costing ~35 characters. It is the only door out of the improvement
 * loop that changes anything durable: a reflection that diagnosed a failing
 * Skill but cannot discover this tool ends as prose in a journal, and the
 * fix stays human labor forever. The name must be findable by intent
 * ("improve my skill", "edit my soul") which matches nothing else in the
 * catalogue, and the Lessons brief block tells employees the durable-fix
 * path exists — a discovery miss there reads as the product refusing its own
 * instruction. Still leaves ~3,000 characters for the six returned schemas
 * inside the 8,000-char result envelope.
 *
 * Raised to 5,080 for M54's continuity family (`schedule_wakeup`,
 * `cancel_wakeup`, `create_workstream`, `update_workstream`,
 * `list_workstreams`) plus `propose_initiative` — ~95 characters. These are
 * the tools that let work outlive one sitting, and every one is asked for by
 * intent that matches nothing else lexically: "check back in two days" must
 * find `schedule_wakeup` or the employee answers "I have no way to follow
 * up" — the exact sentence M54 exists to delete — and the Workstream brief
 * block names `update_workstream` as an instruction, so a discovery miss
 * there reads as the product refusing its own brief. ~2,900 characters
 * remain for the six returned schemas inside the 8,000-char envelope.
 *
 * Raised to 5,120 for M58's two-tool `runs` domain (`list_runs`,
 * `get_run_report`) — 31 characters. Unlike every raise above it, this domain's
 * absence would not be a worse tool but a blind spot: there was no run-reading
 * tool in this product at all, so an employee briefed about a Routine that has
 * been stood down for repeated failure, or a manager asked why a colleague's
 * work is not landing, has nothing to open. An employee that misses `list_runs`
 * does not conclude the record is undiscovered; it concludes the record is
 * unreadable, and answers from the transcript it happens to remember — which is
 * precisely the substitution M58 exists to stop. `get_run_report` has to appear
 * by name because "why did it fail" and "what did that run actually change"
 * match nothing else lexically. ~2,880 characters remain for the six returned
 * schemas inside the 8,000-char envelope.
 */
const DOMAIN_FOOTER_CHARS_MAX = 5_120;

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
  // Direct chat adds one small, turn-local resident control so a long reply can
  // keep the Member informed without making every product tool resident.
  const progress = createChatProgressTool(() => {});

  const discovery = [
    createFindToolsTool({ searchable: [], resolve: () => undefined, grantDead: new Set() }),
    createCallTool({ searchable: [], resolve: () => undefined, grantDead: new Set() }),
  ];

  return [...discovery, ...coding, progress, delegation, ...genosyn];
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

  test("signing stays granular, ranked, and cannot complete a recipient signature", () => {
    assert.deepEqual(SIGNING_ACCESS_RANK, { read: 0, draft: 1, send: 2 });
    const signingNames = TOOL_DOMAINS.signing.tools;
    assert.deepEqual(signingNames, [
      "list_signature_envelopes",
      "get_signature_envelope",
      "draft_signature_envelope",
      "send_signature_envelope",
      "remind_signature_recipient",
      "void_signature_envelope",
    ]);
    assert.equal(
      signingNames.some((name) => /complete|submit|sign_recipient/.test(name)),
      false,
      "recipient consent and signature completion must never be exposed to an AI Employee",
    );
    const send = STATIC_TOOLS.find((tool) => tool.name === "send_signature_envelope");
    const get = STATIC_TOOLS.find((tool) => tool.name === "get_signature_envelope");
    assert.match(get?.description ?? "", /does not expose the source PDF contents/i);
    assert.match(send?.description ?? "", /sends real invitation emails/i);
    assert.match(send?.description ?? "", /verify recipients, routing, expiry/i);
    assert.match(
      send?.description ?? "",
      /Member must verify document meaning and field placement/i,
    );
    assert.match(send?.description ?? "", /never consent or sign for a recipient/i);
  });

  test("the retired families are hidden, not deleted", () => {
    // The compatibility promise: fifteen names customers' Skills may still use.
    assert.equal(Object.keys(RETIRED_FAMILIES).length, 15);
    assert.ok(RETIRED_FAMILIES.mail, "the mail alias is the one most likely to be named in prose");
    assert.ok(RETIRED_FAMILIES.finance);
    assert.ok(RETIRED_FAMILIES.base_rows);
  });
});
