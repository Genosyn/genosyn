/**
 * Durable turns persist a one-percent placeholder before an AI Employee has
 * reported a real milestone. Treating that placeholder as measured progress
 * makes a newly started turn look stalled, so the chat renders it as activity
 * without a percentage until the first authored update arrives.
 */
export function isIndeterminateChatProgress(percent: number, label: string): boolean {
  if (percent !== 1) return false;
  const normalized = label.trim().toLowerCase();
  return normalized === "starting work" || normalized === "resuming durable work";
}

/**
 * New live turns keep the familiar typing dots until they publish a real
 * milestone. A turn recovered through polling still needs a compact card so
 * the Member can tell that persisted work is being followed in the background.
 */
export function shouldShowChatProgressCard(
  percent: number,
  label: string,
  connectionState: "streaming" | "polling" | "reconnecting" | null,
): boolean {
  return !isIndeterminateChatProgress(percent, label) || connectionState !== "streaming";
}
