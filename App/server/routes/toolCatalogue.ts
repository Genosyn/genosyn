import { Router } from "express";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { STATIC_TOOLS } from "../mcp/toolManifest.js";
import { TOOL_DOMAINS } from "../services/agent/tools/toolIndex.js";
import { collapseStaticTools } from "../services/agent/tools/genosynFamilies.js";
import { CODING_TOOL_NAMES } from "../services/agent/tools/coding.js";

/**
 * The tool catalogue, for the Skill toolset picker.
 *
 * Read-only and company-agnostic in content — the catalogue is the same
 * everywhere — but mounted under a company so it inherits the normal
 * membership check rather than becoming an unauthenticated surface that
 * enumerates the product's capabilities.
 *
 * Deliberately does **not** include integration or company-MCP tools. Those are
 * per-employee and only discoverable by connecting to the server, which is far
 * too heavy for rendering a form; a Skill can still declare them by typing the
 * name, which `validateToolset` accepts by shape.
 */

export const toolCatalogueRouter = Router({ mergeParams: true });
toolCatalogueRouter.use(requireAuth);
toolCatalogueRouter.use(requireCompanyMember);

// No zod schema: this route takes no body and no query, and `:cid` is already
// resolved and checked by requireCompanyMember before the handler runs.
toolCatalogueRouter.get("/tool-catalogue", (_req, res) => {
  const summaries = new Map(STATIC_TOOLS.map((t) => [t.name, firstSentence(t.description)]));

  // A collapsed family's granular members are not agent-facing tools — only the
  // family name is. Offering `list_memory` in the picker would let a Skill
  // declare a name that resolves to nothing. Map each collapsed member to its
  // family so the picker only ever shows names that are real.
  const { collapsed } = collapseStaticTools();
  const toFamily = new Map<string, string>();
  const familySummary = new Map<string, string>();
  for (const fam of collapsed) {
    familySummary.set(fam.name, firstSentence(fam.description));
    for (const target of Object.values(fam.ops)) toFamily.set(target, fam.name);
  }

  const domains = Object.entries(TOOL_DOMAINS).map(([key, domain]) => {
    const seen = new Set<string>();
    const tools: { name: string; summary: string }[] = [];
    for (const raw of domain.tools) {
      const name = toFamily.get(raw) ?? raw;
      if (seen.has(name)) continue;
      seen.add(name);
      tools.push({ name, summary: familySummary.get(name) ?? summaries.get(name) ?? "" });
    }
    return { key, label: domain.label, blurb: domain.blurb, tools };
  });

  domains.push({
    key: "coding",
    label: "coding",
    blurb: "Shell and file tools, rooted at the employee's working directory.",
    tools: CODING_TOOL_NAMES.map((name) => ({ name, summary: "" })),
  });

  res.json({ domains });
});

/** One line is all the picker has room for. */
function firstSentence(s: string): string {
  const cut = s.indexOf(". ");
  const text = cut === -1 ? s : s.slice(0, cut + 1);
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}
