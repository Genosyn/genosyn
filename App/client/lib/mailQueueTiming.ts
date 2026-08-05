/** Human-scale duration for the deliberately approximate draft-send ETA. */
export function approximateMailQueueDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "less than a minute";

  const minutes = Math.max(1, Math.ceil(milliseconds / 60_000));
  if (minutes < 60) return `about ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (remainingMinutes === 0) return `about ${hours} ${hours === 1 ? "hour" : "hours"}`;
  return `about ${hours}h ${remainingMinutes}m`;
}

/** Local clock time paired with the relative duration so the ETA is unambiguous. */
export function mailQueueEtaLabel(
  estimatedCompletionAt: string,
  nowMs: number = Date.now(),
  formatTime: (date: Date) => string = (date) =>
    new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date),
): string | null {
  const finish = new Date(estimatedCompletionAt);
  if (!Number.isFinite(finish.getTime())) return null;
  return `Estimated finish ${formatTime(finish)} · ${approximateMailQueueDuration(
    finish.getTime() - nowMs,
  )}`;
}

/** Terminal batches have no progress left to show. */
export function activeMailQueueBatch<T extends { status: string }>(batch: T | null): T | null {
  return batch?.status === "queued" || batch?.status === "running" ? batch : null;
}
