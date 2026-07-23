import { STATIC_TOOLS } from "../mcp/toolManifest.js";
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

/** Every name a Skill may legally declare. */
function knownToolNames(): Set<string> {
  return new Set<string>([
    ...STATIC_TOOLS.map((t) => t.name),
    ...Object.keys(RETIRED_FAMILIES),
    ...CODING_TOOL_NAMES,
  ]);
}

export type ToolsetValidation =
  | { ok: true; names: string[] }
  | { ok: false; error: string };

export function validateToolset(names: unknown): ToolsetValidation {
  if (!Array.isArray(names)) {
    return { ok: false, error: "toolset must be an array of tool names." };
  }
  if (names.length > MAX_TOOLSET_ENTRIES) {
    return {
      ok: false,
      error: `A Skill may declare at most ${MAX_TOOLSET_ENTRIES} tools; got ${names.length}.`,
    };
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

  const known = knownToolNames();
  const unknown = cleaned.filter(
    // `browser_*` and company MCP tools exist only when that server is
    // connected, so they can't be checked against a static list. Accept the
    // shape and let the partition ignore any that don't resolve at run time.
    (n) => !known.has(n) && !n.startsWith("browser_") && !n.includes(":"),
  );
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
