import { onModelAvailabilityChange } from "../modelAvailability.js";
import { withSchedulerLease } from "../schedulerLeases.js";
import { runCustomerChannelNotesPass } from "./notes.js";

/**
 * The customer-channel notes heartbeat.
 *
 * A short fixed tick, because whether a channel is due is a question about its
 * own messages (`notes.ts`), not about a timer: each pass looks for channels
 * that went quiet and writes their notes. It takes its own scheduler lease, so
 * two replicas never write one channel's notes twice, and a pass that finds
 * nothing to do costs one grouped query.
 */

const TICK_MS = 60_000;
/** Long enough for a pass that writes up a few channels, each one model turn. */
const LEASE_TTL_MS = 15 * 60_000;

let timer: NodeJS.Timeout | null = null;
let ticking = false;
let unsubscribe: (() => void) | null = null;

export function customerChannelNotesTick(): void {
  if (ticking) return;
  ticking = true;
  void withSchedulerLease("customer-channel-notes", LEASE_TTL_MS, (lease) =>
    runCustomerChannelNotesPass(lease.assertHeld),
  )
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[customer-channels] notes pass failed:", err);
    })
    .finally(() => {
      ticking = false;
    });
}

export function bootCustomerChannels(): void {
  if (timer) clearInterval(timer);
  timer = setInterval(customerChannelNotesTick, TICK_MS);
  timer.unref();
  // Notes that waited for an unavailable AI Model are written as soon as it
  // answers again, rather than at the next tick.
  unsubscribe?.();
  unsubscribe = onModelAvailabilityChange((change) => {
    if (change.available) customerChannelNotesTick();
  });
}

export function stopCustomerChannels(): void {
  if (timer) clearInterval(timer);
  timer = null;
  unsubscribe?.();
  unsubscribe = null;
}
