import type { AgentTool, ToolDeferralInfo } from "../types.js";

/**
 * How the run's tools are split, and how a name is resolved back to a tool.
 *
 * ## The three visibilities
 *
 * - **resident** — sent to the provider on every request. The working set.
 * - **deferred** — not on the wire, but findable via `find_tools` and callable
 *   via `call_tool`. The long tail.
 * - **alias** — callable, but hidden from `find_tools` and from the index.
 *   These are the retired collapsed family names (`mail`, `finance`, …). Genosyn
 *   is shipped and self-hosted, and both `toolsBriefing()` copies spent the
 *   product's whole history teaching the family/op convention — so a customer's
 *   Skill body very likely says "call `mail` with `op: draft`". That prose lives
 *   in their database and there is no migration for it. An alias costs nothing
 *   (it is never rendered anywhere) and keeps those Skills working.
 *
 * ## Why lenient dispatch
 *
 * {@link ToolRegistry.resolve} reads the *full* map, not just the resident set.
 * A model that names a deferred tool directly — because a Skill told it to,
 * because `find_tools` just returned it, or because it simply knows the name —
 * is right, and answering "unknown tool" would be the design punishing the model
 * for being correct. Resident is about what we *advertise*, never about what we
 * *accept*.
 *
 * ## Why an object rather than two locals in the loop
 *
 * `loop.ts` used to derive `toolDefs` and `byName` as function-locals. Passing a
 * registry in is a scope change, not a control-flow change: it is still built
 * once per run and never mutated, so the tool array the provider sees is
 * byte-identical on every step — which is the precondition for putting an
 * Anthropic cache breakpoint on it later.
 */

export type ToolVisibility = "resident" | "deferred" | "alias";

export type ToolRegistry = {
  /** What goes on the wire, in order. Frozen for the run. */
  resident: AgentTool[];
  /** Every dispatchable tool this run has, keyed by post-dedupe exposed name. */
  all: Map<string, AgentTool>;
  /** Deferred and non-alias, in catalogue order. What `find_tools` searches. */
  searchable: AgentTool[];
  visibility(name: string): ToolVisibility | undefined;
  resolve(name: string): AgentTool | undefined;
  stats: ToolDeferralInfo;
};

export function buildRegistry(params: {
  resident: AgentTool[];
  deferred: AgentTool[];
  aliases: AgentTool[];
  domains: string[];
  fromSkills: string[];
}): ToolRegistry {
  const visibilities = new Map<string, ToolVisibility>();
  const all = new Map<string, AgentTool>();

  // Resident wins any name collision — dedupeToolNames has already run, so a
  // collision here would mean a bug rather than a user-caused clash, and the
  // advertised tool is the one the model was told about.
  for (const t of params.aliases) {
    all.set(t.name, t);
    visibilities.set(t.name, "alias");
  }
  for (const t of params.deferred) {
    all.set(t.name, t);
    visibilities.set(t.name, "deferred");
  }
  for (const t of params.resident) {
    all.set(t.name, t);
    visibilities.set(t.name, "resident");
  }

  return {
    resident: params.resident,
    all,
    searchable: params.deferred,
    visibility: (name) => visibilities.get(name),
    resolve: (name) => all.get(name),
    stats: {
      resident: params.resident.length,
      deferred: params.deferred.length,
      domains: params.domains,
      fromSkills: params.fromSkills,
    },
  };
}

/**
 * A registry with everything resident — the shape the runtime had before
 * deferral existed.
 *
 * This is what `config.agent.toolDiscovery.enabled = false` produces, and it is
 * deliberately a real code path rather than a flag checked in six places: the
 * revert has to be one branch that is obviously equivalent to the old
 * behaviour, or it isn't a revert anyone will trust at 3am.
 */
export function residentOnlyRegistry(tools: AgentTool[]): ToolRegistry {
  return buildRegistry({
    resident: tools,
    deferred: [],
    aliases: [],
    domains: [],
    fromSkills: [],
  });
}
