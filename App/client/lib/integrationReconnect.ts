import type { Company, IntegrationCatalogEntry, IntegrationConnection } from "./api";

export type IntegrationReconnectTarget = {
  entry: IntegrationCatalogEntry;
  conn: IntegrationConnection;
};

/**
 * Return the Email-scoped reconnect destination only for Members who can
 * mutate company Connections. Keeping this decision outside the component
 * makes the permission boundary and URL encoding independently testable.
 */
export function mailReconnectHref(
  role: Company["role"],
  companySlug: string,
  connectionId: string,
): string | null {
  if (role !== "owner" && role !== "admin") return null;
  return `/c/${encodeURIComponent(companySlug)}/mail/integrations?reconnect=${encodeURIComponent(
    connectionId,
  )}`;
}

/**
 * Resolve a reconnect deep link against the Connections and catalog entries
 * visible in the current product. A URL must not reach a hidden provider just
 * because its Connection exists elsewhere in the company catalog.
 */
export function resolveReconnectTarget(
  requestedId: string | null,
  connections: readonly IntegrationConnection[],
  catalog: readonly IntegrationCatalogEntry[],
  allowedProviders: readonly string[] | null,
): IntegrationReconnectTarget | null {
  if (!requestedId) return null;
  const conn = connections.find((item) => item.id === requestedId);
  if (!conn) return null;
  if (allowedProviders && !allowedProviders.includes(conn.provider)) return null;
  const entry = catalog.find((item) => item.provider === conn.provider);
  return entry ? { entry, conn } : null;
}
