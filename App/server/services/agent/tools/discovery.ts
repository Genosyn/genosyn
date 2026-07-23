import type { AgentTool } from "../types.js";
import { PARSE_ERROR_KEY } from "../modelClients/parseArgs.js";
import { TOOL_DOMAINS, TOOL_KEYWORDS, domainOf } from "./toolIndex.js";

/**
 * `find_tools` and `call_tool` — the two tools that make every other tool
 * reachable without putting its schema in every prompt.
 *
 * The contract the rest of the design rests on: **a capability the model has not
 * been shown is not a capability it lacks.** Everything here exists to keep that
 * true — the always-on domain footer, the grant annotations, the lenient
 * argument handling, the suggestions on a miss.
 */

/** How many full schemas one `find_tools` call returns. */
const PAGE_SIZE = 6;

/**
 * Per-schema ceiling inside a `find_tools` result.
 *
 * The deferred set includes integration and bridged-MCP schemas we have never
 * measured, and `loop.ts` clips the whole tool result at `toolResultCap` (floor
 * 8,000 chars). Without a per-schema cap one fat schema would eat the budget and
 * the clip would land mid-JSON, so the model would get a truncated object with
 * no indication that anything was missing.
 */
const SCHEMA_CHAR_CAP = 2_000;

export type DiscoveryContext = {
  /** Everything `find_tools` may return, in catalogue order. */
  searchable: AgentTool[];
  /** Resolve any name — resident, deferred, or alias. Lenient by design. */
  resolve(name: string): AgentTool | undefined;
  /**
   * Names whose every path answers "no grant" for this employee right now.
   * A rank penalty and an annotation — never a filter. `create_base` auto-grants
   * its creator mid-run, so a tool that is dead at assembly time can be alive
   * two steps later.
   */
  grantDead: Set<string>;
};

// ---------- find_tools ----------

export function createFindToolsTool(ctx: DiscoveryContext): AgentTool {
  const footer = buildDomainFooter(ctx.searchable);

  return {
    name: "find_tools",
    description:
      "Search your full tool catalogue and get back exact schemas for the tools that match. " +
      "Your visible tool list is a working set, not everything you have — most tools live in " +
      "the catalogue and are reached through this. Before concluding you cannot do something, " +
      "search for it here. Cheap and idempotent: call it as often as you like, and call it " +
      "again if you have forgotten what it returned.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "What you are trying to do, in plain words — 'record a payment', 'reply to an " +
            "email', 'read a spreadsheet'. Describe the goal, not a guessed tool name.",
        },
        domain: {
          type: "string",
          enum: Object.keys(TOOL_DOMAINS),
          description: "Optional: restrict the search to one domain.",
        },
        page: {
          type: "integer",
          minimum: 1,
          description: "Optional: page through further matches. Defaults to 1.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    run: async (input) => {
      const query = typeof input.query === "string" ? input.query : "";
      const domain = typeof input.domain === "string" ? input.domain : undefined;
      const page = Math.max(1, toInt(input.page) ?? 1);

      let pool = ctx.searchable;
      if (domain) {
        const allowed = new Set(TOOL_DOMAINS[domain]?.tools ?? []);
        pool = allowed.size > 0 ? pool.filter((t) => allowed.has(t.name)) : [];
        if (pool.length === 0) {
          return {
            content:
              `No tools in domain ${JSON.stringify(domain)}.\n\n${footer}`,
            isError: false,
          };
        }
      }

      const ranked = query
        ? rank(pool, query, ctx.grantDead)
        : pool.map((tool) => ({ tool, score: 0 }));

      const start = (page - 1) * PAGE_SIZE;
      const hits = ranked.slice(start, start + PAGE_SIZE);
      const more = ranked.length - (start + hits.length);

      const lines: string[] = [];
      if (hits.length === 0) {
        lines.push(
          query
            ? `Nothing matched ${JSON.stringify(query)}. The full catalogue is below — pick a domain and search again, or call a tool by name directly.`
            : "No tools matched.",
        );
      } else {
        lines.push(
          `${ranked.length} tool(s) matched. Call any of them with \`call_tool\`, or by name directly.`,
          "",
        );
        for (const { tool } of hits) {
          lines.push(renderTool(tool, ctx.grantDead.has(tool.name)));
          lines.push("");
        }
        if (more > 0) {
          lines.push(
            `…and ${more} more. Call find_tools again with page: ${page + 1} for the rest.`,
            "",
          );
        }
      }

      lines.push(footer);
      return { content: lines.join("\n") };
    },
  };
}

/** One tool rendered for the model: name, prose, and its real schema. */
function renderTool(tool: AgentTool, isGrantDead: boolean): string {
  const schema = JSON.stringify(tool.inputSchema, null, 2);
  const body =
    schema.length > SCHEMA_CHAR_CAP
      ? `${schema.slice(0, SCHEMA_CHAR_CAP)}\n… [schema truncated — call it and read the validation error for the rest]`
      : schema;
  const note = isGrantDead
    ? "\n  NOTE: you hold no grant for this today; calling it will return a 403."
    : "";
  return `### ${tool.name}\n${tool.description}${note}\narguments:\n${body}`;
}

/**
 * The recall backstop: every domain and its tool names, no descriptions.
 *
 * Sent on **every** `find_tools` result, including a miss. A lexical ranker on a
 * hostile corpus will sometimes return nothing useful; the difference between
 * that being a one-round-trip annoyance and a silent capability loss is whether
 * the model can see the shape of what it did not find. Names only — this has to
 * stay small enough to leave room for six schemas inside one tool result.
 */
function buildDomainFooter(searchable: AgentTool[]): string {
  const present = new Set(searchable.map((t) => t.name));
  const lines = ["--- full catalogue (names only; use find_tools or call_tool) ---"];

  for (const [key, domain] of Object.entries(TOOL_DOMAINS)) {
    const names = domain.tools.filter((n) => present.has(n));
    if (names.length === 0) continue;
    lines.push(`${key}: ${names.join(", ")}`);
  }

  // Integration and company-MCP tools have no manifest domain. They are the ones
  // with unguessable names, so listing them matters more here, not less.
  const other = searchable.map((t) => t.name).filter((n) => !domainOf(n));
  if (other.length > 0) {
    lines.push(`connected services: ${other.join(", ")}`);
  }

  return lines.join("\n");
}

// ---------- ranking ----------

function rank(
  pool: AgentTool[],
  query: string,
  grantDead: Set<string>,
): { tool: AgentTool; score: number }[] {
  const terms = tokenize(query);
  if (terms.length === 0) return pool.map((tool) => ({ tool, score: 0 }));

  const scored = pool.map((tool) => {
    const haystackName = tokenize(tool.name);
    const haystackKeywords = tokenize((TOOL_KEYWORDS[tool.name] ?? []).join(" "));
    const haystackProse = tokenize(firstSentence(tool.description));

    let score = 0;
    for (const term of terms) {
      // Name matches are the strongest signal — the model often half-remembers
      // a name and is really asking us to complete it.
      if (haystackName.some((w) => w === term)) score += 6;
      else if (haystackName.some((w) => w.startsWith(term) || term.startsWith(w))) score += 3;
      if (haystackKeywords.includes(term)) score += 4;
      if (haystackProse.includes(term)) score += 2;
    }

    // Whole-phrase hit on a curated keyword: "record a payment" should not have
    // to win on the word "payment" alone.
    const phrase = query.toLowerCase().trim();
    if ((TOOL_KEYWORDS[tool.name] ?? []).some((k) => phrase.includes(k))) score += 5;

    // A tool that can only answer 403 today ranks below one that works, but is
    // never removed — see DiscoveryContext.grantDead.
    if (grantDead.has(tool.name)) score -= 3;

    return { tool, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "your", "you",
  "get", "all", "any", "can", "how", "what", "when", "where", "which", "does",
  "use", "using", "have", "has", "was", "are", "its", "it", "to", "of", "in",
  "on", "at", "by", "an", "as", "is", "or", "be", "do", "me", "my", "a",
]);

function firstSentence(s: string): string {
  const cut = s.indexOf(". ");
  return cut === -1 ? s.slice(0, 220) : s.slice(0, cut + 1);
}

// ---------- call_tool ----------

export function createCallTool(ctx: DiscoveryContext): AgentTool {
  return {
    name: "call_tool",
    description:
      "Run any tool from your catalogue by name, including ones not in your visible list. " +
      "Use find_tools first to get the exact argument schema, then pass those arguments as a " +
      "JSON object encoded in `args_json`.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Exact tool name, as returned by find_tools.",
        },
        args_json: {
          type: "string",
          description:
            "The tool's arguments as a JSON object, encoded as a string. " +
            'Example: {"baseSlug":"crm","tableSlug":"leads"} — pass "{}" if the tool takes none.',
        },
      },
      required: ["name", "args_json"],
      additionalProperties: false,
    },
    describeCall: (input) => {
      const target = typeof input.name === "string" ? input.name : "call_tool";
      const parsed = extractArgs(input);
      return { name: target, input: parsed.ok ? parsed.args : {} };
    },
    run: async (input) => {
      // The client stamps a parse failure here when the whole `call_tool`
      // argument blob was malformed. Surfacing it verbatim is the only way the
      // model learns it was its JSON and not its field names.
      const stamped = input[PARSE_ERROR_KEY];
      if (typeof stamped === "string") {
        return {
          content:
            `Your call_tool arguments did not parse: ${stamped}\n` +
            "Send `name` as a plain string and `args_json` as a JSON object encoded in a string.",
          isError: true,
        };
      }

      const name = typeof input.name === "string" ? input.name.trim() : "";
      if (!name) {
        return {
          content: "call_tool needs a `name`. Call find_tools to see what is available.",
          isError: true,
        };
      }

      const tool = ctx.resolve(name);
      if (!tool) {
        return { content: unknownToolMessage(name, ctx), isError: true };
      }

      // Guard against the model routing call_tool at itself, which would spin.
      if (tool.name === "call_tool") {
        return {
          content: "call_tool cannot call itself. Pass the name of the tool you actually want.",
          isError: true,
        };
      }

      const parsed = extractArgs(input);
      if (!parsed.ok) {
        return { content: parsed.error, isError: true };
      }

      return tool.run(parsed.args);
    },
  };
}

type ExtractedArgs =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Pull the target tool's arguments out of a `call_tool` input.
 *
 * Deliberately tolerant. `args_json` is declared a **string** because an object
 * property with no `properties` of its own renders as "no arguments" through
 * several Ollama/vLLM chat templates and compiles to a near-empty grammar under
 * constrained decoding — producing genuinely empty args that no amount of
 * parsing can recover. A plain string renders and compiles everywhere.
 *
 * But models do not read that distinction reliably, so a model that sends an
 * object anyway, or names the field `args`, is doing something we can
 * understand — and refusing it would be pedantry that costs a round-trip.
 */
function extractArgs(input: Record<string, unknown>): ExtractedArgs {
  const raw = input.args_json ?? input.args ?? input.arguments;

  if (raw === undefined || raw === null) return { ok: true, args: {} };

  if (typeof raw === "object" && !Array.isArray(raw)) {
    return { ok: true, args: raw as Record<string, unknown> };
  }

  if (typeof raw !== "string") {
    return {
      ok: false,
      error: `args_json must be a JSON object encoded as a string; received ${typeof raw}.`,
    };
  }

  const s = raw.trim();
  if (!s) return { ok: true, args: {} };

  let value: unknown;
  try {
    value = JSON.parse(s);
  } catch (e) {
    return {
      ok: false,
      error:
        `args_json was not valid JSON (${e instanceof Error ? e.message : String(e)}). ` +
        `Received: ${s.length > 200 ? `${s.slice(0, 200)}…` : s}`,
    };
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      error: `args_json parsed to ${Array.isArray(value) ? "an array" : typeof value}, but a JSON object was expected.`,
    };
  }

  return { ok: true, args: value as Record<string, unknown> };
}

function unknownToolMessage(name: string, ctx: DiscoveryContext): string {
  const near = ctx.searchable
    .map((t) => ({ name: t.name, d: editDistance(name, t.name) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .filter((c) => c.d <= Math.max(4, Math.floor(name.length / 2)))
    .map((c) => c.name);

  const suggestion =
    near.length > 0
      ? ` Did you mean: ${near.join(", ")}?`
      : " Call find_tools with a description of what you need.";
  return `Unknown tool ${JSON.stringify(name)}.${suggestion}`;
}

/** Levenshtein, bounded by the short strings it runs on (tool names). */
function editDistance(a: string, b: string): number {
  const prev = new Array<number>(b.length + 1);
  const cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

function toInt(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v.trim());
  return undefined;
}

/** Both meta-tools, ready to be made resident. */
export function discoveryTools(ctx: DiscoveryContext): AgentTool[] {
  return [createFindToolsTool(ctx), createCallTool(ctx)];
}

/** Reserved model-facing names — `dedupeToolNames` must not hand these out. */
export const DISCOVERY_TOOL_NAMES = ["find_tools", "call_tool"];
