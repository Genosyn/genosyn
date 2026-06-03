/**
 * Small display helpers shared by the Contracts page and the per-customer
 * contracts panel.
 */

/** Human-readable file size, e.g. `2.4 MB`. */
export function formatContractSize(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  const val = bytes / Math.pow(1024, i);
  const rounded = val >= 10 || i === 0 ? Math.round(val).toString() : val.toFixed(1);
  return `${rounded} ${units[i]}`;
}

/** Display a signed date (ISO string) as `YYYY-MM-DD`, or a placeholder. */
export function formatSignedDate(iso: string | null): string {
  if (!iso) return "No signed date";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "No signed date" : d.toISOString().slice(0, 10);
}
