import "reflect-metadata";

import { AppDataSource } from "../db/datasource.js";
import { releaseRoutineQueue } from "../services/routineQueueHold.js";
import {
  clearRunPauseRequest,
  DEFAULT_PAUSE_GRACE_MS,
  pauseRoutineRunsForUpgrade,
} from "../services/runPause.js";

/**
 * Operator entrypoint behind the pause step of `genosyn upgrade`. Run inside
 * the container (`node dist/server/admin/pauseRoutines.js`) before it stops:
 * it holds the Routine queue, lets running Runs keep working for
 * `--finish-minutes` if asked, then pauses the rest. Each paused Run saves its
 * progress (up to `--grace-seconds`), stops its model turn, and waits in the
 * queue with its transcript and Effects; the upgraded container releases the
 * hold and the same Runs continue where they stopped. See
 * `services/runPause.ts`.
 *
 *   pauseRoutines [--finish-minutes N] [--grace-seconds S]
 *   pauseRoutines --release     resume normally (upgrade cancelled)
 *
 * Exit codes (the CLI branches on these):
 *   0  no Routine Run is running — every one paused or finished / released
 *   2  usage error
 *   3  Runs were still running when the wait ended; the restart stops them
 *      and the upgraded server resumes them from their last saved line
 *   1  anything else
 */
function numberFlag(argv: string[], name: string, fallback: number): number | null {
  const at = argv.indexOf(name);
  if (at < 0) return fallback;
  const value = Number(argv[at + 1]);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

async function run(): Promise<number> {
  const argv = process.argv.slice(2);
  const release = argv.includes("--release");
  const finishMinutes = numberFlag(argv, "--finish-minutes", 0);
  const graceSeconds = numberFlag(argv, "--grace-seconds", DEFAULT_PAUSE_GRACE_MS / 1000);
  const known = new Set(["--release", "--finish-minutes", "--grace-seconds"]);
  const unknown = argv.filter((arg) => arg.startsWith("--") && !known.has(arg));
  if (finishMinutes === null || graceSeconds === null || unknown.length > 0) {
    console.error(
      "Usage: pauseRoutines [--finish-minutes <n>] [--grace-seconds <s>] | --release",
    );
    return 2;
  }

  await AppDataSource.initialize();
  try {
    if (release) {
      await clearRunPauseRequest();
      await releaseRoutineQueue();
      console.log("Routine queue released; paused Runs continue now.");
      return 0;
    }
    let lastReport = -Infinity;
    const { paused, stillRunning } = await pauseRoutineRunsForUpgrade({
      finishMinutes,
      graceMs: graceSeconds * 1000,
      onPausing: (count) =>
        console.log(
          `Pausing ${count} running Routine Run${count === 1 ? "" : "s"}` +
            (graceSeconds > 0
              ? `; each saves its progress first (up to ${graceSeconds}s).`
              : "."),
        ),
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
    if (paused > 0) {
      console.log(
        `Paused ${paused} Routine Run${paused === 1 ? "" : "s"}; ${paused === 1 ? "it continues" : "they continue"} where ${paused === 1 ? "it" : "they"} stopped after the upgrade.`,
      );
    }
    if (stillRunning > 0) {
      console.log(
        `${stillRunning} Routine Run${stillRunning === 1 ? " is" : "s are"} still running; the restart stops ${stillRunning === 1 ? "it" : "them"} and the upgraded server resumes ${stillRunning === 1 ? "it" : "them"} from the last saved line.`,
      );
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
