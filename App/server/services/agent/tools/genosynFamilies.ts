import {
  STATIC_TOOLS,
  type McpToolInputSchema,
  type McpToolSpec,
} from "../../../mcp/toolManifest.js";

/**
 * Regroups part of the granular {@link STATIC_TOOLS} catalogue into
 * `op`-dispatched family tools **for the agent only**.
 *
 * ## What's left here, and why it shrank
 *
 * This module used to collapse sixteen families, because the whole genosyn
 * surface had to fit under OpenAI's 128-tool cap and 84 granular tools left no
 * room for an employee's integrations. Progressive disclosure removed that
 * pressure: the model is now shown a working set of ~20 tools and reaches the
 * rest through `find_tools` / `call_tool` (see `discovery.ts`), so the cap stops
 * binding long before the catalogue does.
 *
 * With the cap gone, collapsing is a net loss almost everywhere. A family's ops
 * rarely declare the same arguments, so {@link unionSchema} has to intersect
 * their `required` sets — and for most families that collapsed to just `["op"]`,
 * leaving the model a tool with twenty optional properties and the real
 * requirements buried in prose. Granular `send_invoice` advertises exactly what
 * `send_invoice` needs.
 *
 * So exactly one family survives: **`memory`**. Four small ops over one row
 * shape, genuinely cheaper merged than split, and resident on every step — the
 * one place the trade still pays. The other fifteen live on as hidden aliases
 * (see `familyAliases.ts`) so customer Skills that name them keep working.
 *
 * ## Why only the agent's view collapses
 *
 * `STATIC_TOOLS` is not ours alone: `mcp/protocol.ts` answers `tools/list` from
 * it and dispatches `tools/call` by name straight to `/tools/<name>`, which is
 * what external MCP clients (Claude Desktop, Cursor, another harness) are bound
 * to. Renaming the manifest would break every one of them, silently. So the
 * manifest stays granular and authoritative — descriptions, schemas, handlers,
 * zod validation, audit trail and grant checks all unchanged — and this module
 * only regroups it on the way to the model.
 *
 * ## Why the schemas are widened rather than picked
 *
 * A family's ops rarely declare identical arguments, so the union has to merge
 * two schemas for the same property. Merging by "take the first" is silently
 * destructive: `update_memory` and `add_memory` disagree on which fields are
 * required, and dropping either side's shape would be invisible at the call
 * site.
 *
 * So {@link widen} takes the *permissive* side of every disagreement: union the
 * types, union the nested properties, intersect the nested `required`. Widening
 * can only ever let through a call the endpoint would have rejected anyway —
 * and `mcpInternal.ts` is still the real validator, so a wrong argument comes
 * back as a zod error the model reads and retries. Narrowing, by contrast,
 * removes a capability with no diagnostic at all.
 */

/** One collapsed tool: a model-facing name, a blurb, and its `op` → tool map. */
type FamilySpec = {
  /** Prose the per-op documentation is appended to. */
  blurb: string;
  /** Model-facing `op` value → the {@link STATIC_TOOLS} name it dispatches to. */
  ops: Record<string, string>;
};

/**
 * The surviving collapsed family, keyed by model-facing tool name.
 *
 * Ops use plain CRUD verbs so the vocabulary stays predictable.
 *
 * Adding to this map is almost always the wrong move now — the cap that
 * justified collapsing is gone, and a new family costs the model a schema whose
 * `required` is the intersection of its ops. Defer the granular tools instead.
 * `memory` earns its place by being four small ops over one row shape *and*
 * resident on every step, so the merge is paid back on every request.
 */
const FAMILIES: Record<string, FamilySpec> = {
  memory: {
    blurb: "Curate your durable memory — the facts auto-injected into every prompt.",
    ops: {
      list: "list_memory",
      create: "add_memory",
      update: "update_memory",
      delete: "delete_memory",
    },
  },
};

/** A collapsed family tool, ready to be turned into an {@link AgentTool}. */
export type CollapsedTool = {
  name: string;
  description: string;
  inputSchema: McpToolInputSchema;
  /** `op` value → the granular {@link STATIC_TOOLS} name to dispatch to. */
  ops: Record<string, string>;
};

/**
 * Build the agent's view of the static catalogue: every family collapsed to one
 * `op`-dispatched tool, every other tool passed through untouched.
 *
 * Throws if a family names a tool the manifest doesn't have — that can only mean
 * someone renamed a tool without updating the family map, and failing at boot is
 * infinitely kinder than shipping an employee a tool that 404s at call time.
 */
export function collapseStaticTools(): {
  collapsed: CollapsedTool[];
  passthrough: McpToolSpec[];
} {
  const byName = new Map(STATIC_TOOLS.map((t) => [t.name, t]));
  const claimed = new Set<string>();
  const collapsed: CollapsedTool[] = [];

  for (const [family, spec] of Object.entries(FAMILIES)) {
    const members: Array<{ op: string; tool: McpToolSpec }> = [];
    for (const [op, toolName] of Object.entries(spec.ops)) {
      const tool = byName.get(toolName);
      if (!tool) {
        throw new Error(
          `Tool family "${family}" maps op "${op}" to "${toolName}", which is not in STATIC_TOOLS. ` +
            `Update FAMILIES in genosynFamilies.ts to match the manifest.`,
        );
      }
      members.push({ op, tool });
      claimed.add(toolName);
    }
    collapsed.push({
      name: family,
      description: describeFamily(spec.blurb, members),
      inputSchema: unionSchema(members),
      ops: spec.ops,
    });
  }

  return {
    collapsed,
    passthrough: STATIC_TOOLS.filter((t) => !claimed.has(t.name)),
  };
}

/**
 * Compose the family description: the blurb, then each op's own manifest prose.
 *
 * The per-op required list is spelled out because the union schema can't carry
 * it — JSON Schema has one `required` for the whole object, so anything not
 * required by *every* op has to be dropped from it (see {@link unionSchema}).
 * Writing it into the description is how that constraint stays visible to the
 * model instead of only surfacing as a zod error after a wasted call.
 */
function describeFamily(blurb: string, members: Array<{ op: string; tool: McpToolSpec }>): string {
  const lines = [blurb, "", "Set `op` to choose the action:", ""];
  for (const { op, tool } of members) {
    const required = tool.inputSchema.required ?? [];
    const args = required.length > 0 ? `Requires: ${required.join(", ")}.` : "No required args.";
    lines.push(`- \`op: "${op}"\` — ${tool.description} ${args}`);
  }
  return lines.join("\n");
}

/**
 * Union every member's arguments into one schema.
 *
 * `required` is the *intersection* of the members' required sets plus `op`:
 * only an argument every op demands can be demanded here. For `base_rows` that
 * still pins `baseSlug` and `tableSlug`; for a family whose ops disagree it
 * collapses to just `op`, and the per-op requirements live in the description.
 */
function unionSchema(members: Array<{ op: string; tool: McpToolSpec }>): McpToolInputSchema {
  const properties: Record<string, unknown> = {
    op: {
      type: "string",
      enum: members.map((m) => m.op),
      description: "Which action to perform. See this tool's description.",
    },
  };

  for (const { tool } of members) {
    for (const [prop, schema] of Object.entries(tool.inputSchema.properties ?? {})) {
      const existing = properties[prop];
      // Clone: these objects belong to STATIC_TOOLS, which `mcp/protocol.ts`
      // serves verbatim to external MCP clients. Mutating one here — as the
      // description pass below does — would rewrite the manifest under them.
      properties[prop] =
        isObject(existing) && isObject(schema) ? widen(existing, schema) : clone(schema);
    }
  }

  // Property descriptions are resolved with full knowledge of which op said
  // what, which `widen` (a pairwise merge) can't have. It matters: `parentSlug`
  // is a filter to `list` but a target parent to `create`, and `resolutionNote`
  // means three different things across complete/decline/cancel. Picking one
  // would quietly mislabel the others.
  for (const prop of Object.keys(properties)) {
    if (prop === "op") continue;
    const merged = properties[prop];
    if (!isObject(merged)) continue;
    const described = describeProperty(prop, members);
    if (described) merged.description = described;
    else delete merged.description;
  }

  const requiredSets = members.map((m) => new Set(m.tool.inputSchema.required ?? []));
  const shared = [...(requiredSets[0] ?? [])].filter((r) => requiredSets.every((s) => s.has(r)));

  return {
    type: "object",
    properties,
    required: ["op", ...shared],
    additionalProperties: false,
  };
}

/**
 * Resolve one property's description across every op that declares it.
 *
 * Where the ops agree (or only one bothered to write prose) that text stands.
 * Where they genuinely disagree, each variant is kept and tagged with the ops it
 * belongs to — `(complete) Markdown summary of what you did. (decline) Reason
 * for declining…` — because the alternative is telling the model that
 * `resolutionNote` means one thing when for two of its three ops it doesn't.
 */
function describeProperty(
  prop: string,
  members: Array<{ op: string; tool: McpToolSpec }>,
): string | undefined {
  const byText = new Map<string, string[]>();
  for (const { op, tool } of members) {
    const schema = tool.inputSchema.properties?.[prop];
    if (!isObject(schema)) continue;
    const text = typeof schema.description === "string" ? schema.description.trim() : "";
    if (!text) continue;
    const ops = byText.get(text);
    if (ops) ops.push(op);
    else byText.set(text, [op]);
  }

  const variants = [...byText.entries()];
  if (variants.length === 0) return undefined;
  if (variants.length === 1) return variants[0][0];
  return variants.map(([text, ops]) => `(${ops.join("/")}) ${text}`).join(" ");
}

/**
 * Merge two schemas for the same property by taking the permissive side of every
 * disagreement — union the types, union the nested properties, intersect the
 * nested `required`, and drop any constraint the two don't agree on.
 *
 * Never narrows. A widened schema can only admit a call the endpoint's zod would
 * have rejected anyway (the model gets a readable error and retries); a narrowed
 * one silently removes a capability the granular tool had.
 */
function widen(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  if (deepEqual(a, b)) return clone(a);
  const out: Record<string, unknown> = {};

  const type = unionTypes(a.type, b.type);
  if (type !== undefined) out.type = type;

  // Prefer the richer prose — the granular tools vary from a full sentence to
  // nothing at all, and the fuller one is what the model can actually use.
  const descriptions = [a.description, b.description]
    .filter((d): d is string => typeof d === "string")
    .sort((x, y) => y.length - x.length);
  if (descriptions[0]) out.description = descriptions[0];

  // An enum only constrains if *both* sides constrain; if one op accepts open
  // values, the family must too.
  if (Array.isArray(a.enum) && Array.isArray(b.enum)) {
    out.enum = [...new Set([...a.enum, ...b.enum])];
  }

  if (isObject(a.properties) || isObject(b.properties)) {
    out.properties = mergeProperties(a.properties, b.properties);
  }

  // Nested required: same intersection rule as the top level.
  if (Array.isArray(a.required) || Array.isArray(b.required)) {
    const ra = Array.isArray(a.required) ? a.required : [];
    const rb = Array.isArray(b.required) ? b.required : [];
    const shared = ra.filter((r) => rb.includes(r));
    if (shared.length > 0) out.required = shared;
  }

  if (isObject(a.items) && isObject(b.items)) out.items = widen(a.items, b.items);
  else if (isObject(a.items) || isObject(b.items)) out.items = a.items ?? b.items;

  if (a.additionalProperties !== undefined || b.additionalProperties !== undefined) {
    out.additionalProperties =
      a.additionalProperties === b.additionalProperties ? a.additionalProperties : true;
  }

  // Anything else (minimum, maximum, format, …) survives only where the two
  // agree; a disagreement means the constraint isn't true of every op.
  const handled = new Set([
    "type",
    "description",
    "enum",
    "properties",
    "required",
    "items",
    "additionalProperties",
  ]);
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (handled.has(key)) continue;
    if (deepEqual(a[key], b[key])) out[key] = a[key];
  }

  return out;
}

/** Union the keys of two `properties` maps, widening any key they share. */
function mergeProperties(a: unknown, b: unknown): Record<string, unknown> {
  const pa = isObject(a) ? a : {};
  const pb = isObject(b) ? b : {};
  const out: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(pa), ...Object.keys(pb)])) {
    const va = pa[key];
    const vb = pb[key];
    out[key] = isObject(va) && isObject(vb) ? widen(va, vb) : (va ?? vb);
  }
  return out;
}

/** `"string"` + `["string","null"]` → `["string","null"]`. */
function unionTypes(a: unknown, b: unknown): unknown {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const all = [...new Set([...toArray(a), ...toArray(b)])];
  return all.length === 1 ? all[0] : all;
}

function toArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [v];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Deep copy, so nothing we build aliases the shared {@link STATIC_TOOLS} objects. */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
