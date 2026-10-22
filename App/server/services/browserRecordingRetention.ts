import { expireBrowserRecordingsFinishedBefore } from "./browserRecordings.js";
import { getBrowserSettings } from "./runtimeSettings.js";
import { withSchedulerLease } from "./schedulerLeases.js";

/**
 * Deletes Routine browser recordings once they are older than the window set
 * at Admin → Runtime → Browser (`recordingRetentionDays`: 7 days unless an
 * admin changes it, 0 keeps them forever). A recording is the one Run artifact
 * that grows with every browser-using Run, and before this nothing removed one
 * short of deleting its Run, Routine, or company, so the data disk filled.
 *
 * It applies to recordings from Genosyn's browser and Member browsers alike,
 * counts from when each recording finished, and leaves the Run, its log, and
 * the BrowserSession row in place: the recording reads as `expired` afterwards.
 * A pass runs shortly after boot and then hourly, under a scheduler lease so
 * one replica does it, and a window saved at Admin → Runtime applies on the
 * next pass.
 */

const PASS_INTERVAL_MS = 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

let passTimer: ReturnType<typeof setInterval> | null = null;

/** One retention pass. Returns how many videos it deleted. */
export async function pruneExpiredBrowserRecordings(
  now: Date = new Date(),
  assertHeld?: () => void,
): Promise<number> {
  const days = getBrowserSettings().recordingRetentionDays;
  if (days <= 0) return 0;
  const { deleted, bytes } = await expireBrowserRecordingsFinishedBefore(
    new Date(now.getTime() - days * DAY_MS),
    assertHeld,
  );
  if (deleted > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[browser-recordings] retention deleted ${deleted} recording(s) older than ${days} day(s), freeing ${(bytes / (1024 * 1024)).toFixed(1)} MB`,
    );
  }
  return deleted;
}

function runPass(): void {
  withSchedulerLease("browser-recording-retention", PASS_INTERVAL_MS - 60_000, (lease) =>
    pruneExpiredBrowserRecordings(new Date(), lease.assertHeld),
  ).catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error("[browser-recordings] retention pass failed:", err);
  });
}

export function bootBrowserRecordingRetention(): void {
  if (passTimer) return;
  runPass();
  passTimer = setInterval(runPass, PASS_INTERVAL_MS);
  if (typeof passTimer.unref === "function") passTimer.unref();
}
