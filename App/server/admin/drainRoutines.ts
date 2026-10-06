import "reflect-metadata";

import { AppDataSource } from "../db/datasource.js";
import { drainRoutineRuns, releaseRoutineQueue } from "../services/routineQueueHold.js";

/**
 * Operator entrypoint behind the drain step of `genosyn upgrade`. Run inside
 * the container (`node dist/server/admin/drainRoutines.js`) before it stops:
 * it holds the Routine queue and waits for running Runs to finish, so the
 * restart does not cut them off. The upgraded container releases the hold.
 *
 *   drainRoutines --minutes N   hold the queue; wait up to N minutes
 *   drainRoutines --release     start queued Runs again (upgrade cancelled)
 *
 * Exit codes (the CLI branches on these):
 *   0  no Routine Run is running / released
 *   2  usage error
 *   3  Runs were still running when the wait ended
 *   1  anything else
 */
async function run(): Promise<number> {
  const argv = process.argv.slice(2);
  const release = argv.includes("--release");
  const minutesAt = argv.indexOf("--minutes");
  const minutes = minutesAt >= 0 ? Number(argv[minutesAt + 1]) : NaN;
  if (!release && !(Number.isFinite(minutes) && minutes >= 0)) {
    console.error("Usage: drainRoutines --minutes <n> | --release");
    return 2;
  }

  await AppDataSource.initialize();
  try {
    if (release) {
      await releaseRoutineQueue();
      console.log("Routine queue released.");
      return 0;
    }
    let lastReport = -Infinity;
    const running = await drainRoutineRuns({
      minutes,
      onWaiting: (count, waitedMs) => {
        if (waitedMs - lastReport < 60_000) return;
        lastReport = waitedMs;
        const waited = Math.round(waitedMs / 60_000);
        console.log(
          `${count} Routine Run${count === 1 ? "" : "s"} still running` +
            (waited > 0 ? ` after ${waited} min` : "") +
            "; new Runs wait for the upgrade.",
        );
      },
    });
    if (running > 0) {
      console.log(`${running} Routine Run${running === 1 ? " is" : "s are"} still running.`);
      return 3;
    }
    console.log("No Routine Run is running.");
    return 0;
  } finally {
    await AppDataSource.destroy().catch(() => {});
  }
}

run()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
