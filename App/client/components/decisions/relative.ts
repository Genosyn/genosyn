/**
 * "2h ago" / "in 4h" for the Decision Stack.
 *
 * Negative deltas read as future because two of the four timestamps on a
 * decision (an expiry, a scheduled next run) are ahead of now, and "-4h ago"
 * is the kind of thing that makes people distrust the whole row.
 */
export function formatRelative(iso: string): string {
  const date = new Date(iso);
  const sec = Math.round((Date.now() - date.getTime()) / 1000);
  if (sec < 0) {
    const ahead = Math.abs(sec);
    if (ahead < 3600) return `in ${Math.round(ahead / 60)}m`;
    if (ahead < 86400) return `in ${Math.round(ahead / 3600)}h`;
    return `in ${Math.round(ahead / 86400)}d`;
  }
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return date.toLocaleDateString();
}

/** "4m" / "1h 12m" — how long a pickup session took. */
export function formatDuration(startIso: string, endIso: string): string | null {
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const min = Math.round(ms / 60_000);
  if (min < 1) return "under a minute";
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${hr}h ${rest}m` : `${hr}h`;
}
