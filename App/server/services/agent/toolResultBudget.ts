/** Bound tool payloads sent through the official Codex subscription adapter. */
export const TOOL_RESULT_CAP_DEFAULT = 60_000;

export function toolResultCap(contextWindow: number | null): number {
  if (!contextWindow) return TOOL_RESULT_CAP_DEFAULT;
  return Math.max(8_000, Math.min(TOOL_RESULT_CAP_DEFAULT, Math.floor(contextWindow * 0.15 * 4)));
}
