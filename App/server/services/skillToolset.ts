import { STATIC_TOOLS } from "../mcp/toolManifest.js";
import { collapseStaticTools } from "./agent/tools/genosynFamilies.js";
import { RETIRED_FAMILIES } from "./agent/tools/familyAliases.js";
import { CODING_TOOL_NAMES } from "./agent/tools/coding.js";
import type { Skill } from "../db/entities/Skill.js";

/**
 * A Skill's declared toolset: the tools its playbook actually uses.
 *
 * ## What this is for
 *
 * Tool discovery (`find_tools` / `call_tool`) keeps the prompt flat, but it
 * costs a round-trip and it leans on a lexical ranker that will sometimes miss.
 * That is the top risk in the whole design, and this is the escape hatch: a
 * Skill author who already knows their procedure calls `send_invoice` and
 * `record_payment` can say so, and those tools are loaded up-front for any turn
 * where the Skill is in the prompt. Discovery is bypassed entirely.
 *
 * It is deliberately **not** a permission. Declaring a tool does not grant it —
 * Grants are still checked when the tool is called, and a Skill naming a tool
 * the employee has no grant for simply gets a 403 the same as before. This
 * decides what is *loaded*, never what is *allowed*.
 *
 * ## Why validation is strict
 *
 * An unknown name is a 400 with suggestions, not a silent drop. A Skill that
 * declares a typo'd tool has a bug that only shows up as "the model didn't use
 * the tool" at 3am inside a routine — the kind of failure nobody traces back to
 * a misspelling in a text field. Fail at edit time, where a human is looking.
 */

/** Ceiling on declared tools per Skill. Past this it isn't a toolset. */
export const MAX_TOOLSET_ENTRIES = 25;

/** Tolerant read of the stored column. Never throws; garbage reads as empty. */
export function parseToolset(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return v.filter((n): n is string => typeof n === "string" && n.length > 0);
  } catch {
    return [];
  }
}

/** Serialize for storage. An empty toolset is stored as null, not `"[]"`. */
export function serializeToolset(names: string[]): string | null {
  return names.length > 0 ? JSON.stringify(names) : null;
}

/** Every static name a Skill may legally declare. */
function knownToolNames(): Set<string> {
  return new Set<string>([
    ...STATIC_TOOLS.map((t) => t.name),
    // The live collapsed family (`memory`): it is a real agent-facing tool but
    // not a STATIC_TOOLS entry, so without this a Skill declaring `memory`
    // would be rejected.
    ...collapseStaticTools().collapsed.map((c) => c.name),
    ...Object.keys(RETIRED_FAMILIES),
    ...CODING_TOOL_NAMES,
  ]);
}

/**
 * Whether a name is a dynamic tool we cannot check against a static list.
 *
 * Integration and company-MCP tools only exist once their Connection/server is
 * live, which may be after the Skill is edited — so they are accepted by shape.
 * The shapes are the real ones the runtime produces:
 *   - browser: `browser_*`
 *   - company MCP: `<server>__<tool>` (mcpBridge `exposedToolName`)
 *   - integration: `<provider>_<tool>` (mcpInternal `/integrations/_list`)
 * The integration case can't be told from a typo of a static name by shape
 * alone, so it is accepted only when the leading segment is not itself a known
 * static tool — a typo like `send_invoic` still fails.
 */
function looksDynamic(name: string, known: Set<string>): boolean {
  if (name.startsWith("browser_")) return true;
  if (name.includes("__")) return true;
  // `<provider>_<tool>`: require a provider-shaped prefix and a tool suffix,
  // and don't swallow near-misses of real static names.
  return /^[a-z0-9]+_[a-z0-9_]+$/.test(name) && !known.has(name) && !isNearStatic(name, known);
}

/** A name within edit distance 2 of a static tool is treated as a typo. */
function isNearStatic(name: string, known: Set<string>): boolean {
  for (const k of known) {
    if (Math.abs(k.length - name.length) <= 2 && editDistance(name, k) <= 2) return true;
  }
  return false;
}

export type ToolsetValidation =
  | { ok: true; names: string[] }
  | { ok: false; error: string };

export function validateToolset(names: unknown): ToolsetValidation {
  if (!Array.isArray(names)) {
    return { ok: false, error: "toolset must be an array of tool names." };
  }

  const cleaned: string[] = [];
  for (const raw of names) {
    if (typeof raw !== "string") {
      return { ok: false, error: "toolset entries must be strings." };
    }
    const name = raw.trim();
    if (!name) continue;
    if (!cleaned.includes(name)) cleaned.push(name);
  }

  // Count after cleaning: 30 entries that dedupe to 20 real tools is a fine
  // toolset, not an over-limit one.
  if (cleaned.length > MAX_TOOLSET_ENTRIES) {
    return {
      ok: false,
      error: `A Skill may declare at most ${MAX_TOOLSET_ENTRIES} tools; got ${cleaned.length}.`,
    };
  }

  const known = knownToolNames();
  const unknown = cleaned.filter((n) => !known.has(n) && !looksDynamic(n, known));
  if (unknown.length > 0) {
    const suggestions = unknown
      .map((n) => {
        const near = [...known]
          .map((k) => ({ k, d: editDistance(n, k) }))
          .sort((a, b) => a.d - b.d)
          .slice(0, 2)
          .filter((c) => c.d <= 4)
          .map((c) => c.k);
        return near.length > 0 ? `${n} (did you mean ${near.join(" or ")}?)` : n;
      })
      .join("; ");
    return { ok: false, error: `Unknown tool name(s): ${suggestions}` };
  }

  return { ok: true, names: cleaned };
}

/** The union of every active Skill's declared tools, deduped. */
export function residentNamesForSkills(skills: Skill[]): string[] {
  const out: string[] = [];
  for (const s of skills) {
    for (const n of parseToolset(s.toolsetJson)) {
      if (!out.includes(n)) out.push(n);
    }
  }
  return out;
}

/** Per-skill toolsets, for rendering under each `## Skill:` heading. */
export function skillToolsetMap(skills: Skill[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const s of skills) {
    const names = parseToolset(s.toolsetJson);
    if (names.length > 0) map.set(s.id, names);
  }
  return map;
}

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
