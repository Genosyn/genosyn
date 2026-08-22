import { getProvider } from "../integrations/index.js";
import type { IntegrationAuthMode } from "../integrations/types.js";

/**
 * Turn an employee's granted Connections into the tool list their model
 * sees. Extracted from `routes/mcpInternal.ts` because what belongs in a
 * route handler is request parsing and response shaping — and because the
 * rule this encodes is worth testing directly.
 *
 * The rule: **a Connection advertises only what it can actually do.** The
 * same Integration behaves very differently across auth modes, and a
 * Connection can outlive the mode it was created in — X's retired
 * browser-login rows can run nothing at all now, so they list nothing at
 * all. Listing the union taught employees to plan around capabilities that
 * were never there, then explain the resulting failure by guessing. A tool
 * the model was never shown is a promise it cannot make.
 */

/** The connection fields this module needs — kept structural so tests
 * don't have to build a TypeORM entity. */
export type ListableConnection = {
  id: string;
  provider: string;
  label: string;
  authMode: IntegrationAuthMode;
};

export type ListedIntegrationTool = {
  name: string;
  description: string;
  inputSchema: unknown;
  connectionId: string;
  providerToolName: string;
};

/**
 * Tool names are prefixed:
 *   - single connection for that provider → `<provider>_<tool>`
 *     (e.g. `stripe_list_customers`)
 *   - multiple connections → `<provider>_<connSlug>_<tool>`
 *     (e.g. `stripe_us_list_customers`, `stripe_eu_list_customers`)
 */
export function toolNameSegment(label: string): string {
  const cleaned = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "conn";
}

export function integrationToolDescription(
  providerName: string,
  connectionLabel: string,
  inner: string,
): string {
  return `[${providerName} · ${connectionLabel}] ${inner}`;
}

export function buildIntegrationToolListing(
  connections: ListableConnection[],
): ListedIntegrationTool[] {
  // Group by provider so we know when to disambiguate by connection.
  const byProvider = new Map<string, ListableConnection[]>();
  for (const connection of connections) {
    const arr = byProvider.get(connection.provider) ?? [];
    arr.push(connection);
    byProvider.set(connection.provider, arr);
  }

  const out: ListedIntegrationTool[] = [];
  for (const [providerId, group] of byProvider) {
    const provider = getProvider(providerId);
    if (!provider) continue;
    const disambiguate = group.length > 1;
    for (const connection of group) {
      const connSlug = toolNameSegment(connection.label || connection.id);
      const prefix = disambiguate ? `${providerId}_${connSlug}` : providerId;
      // One caveat per auth mode, appended to each tool rather than left
      // to a doc page the model never reads.
      const modeNote = provider.describeAuthMode?.(connection.authMode);
      for (const tool of provider.tools) {
        if (provider.supportsTool && !provider.supportsTool(tool.name, connection.authMode)) {
          continue;
        }
        out.push({
          name: `${prefix}_${tool.name}`,
          description: integrationToolDescription(
            provider.catalog.name,
            connection.label,
            modeNote ? `${tool.description} ${modeNote}` : tool.description,
          ),
          inputSchema: tool.inputSchema,
          connectionId: connection.id,
          providerToolName: tool.name,
        });
      }
    }
  }
  return out;
}
