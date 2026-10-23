import { setDestinationGateForTests } from "../services/backupDestinations.js";

/**
 * Hold off-box copies — and connection tests — at the moment each would
 * start, so a test can see one waiting its turn or under way, then let it
 * through or fail it with a reason.
 *
 * Held by destination name. Real destinations (an SFTP host, an SMB share)
 * can't be made to pause on cue: ssh2 notices a dropped connection only at its
 * ready timeout, fifteen seconds on. Always `release()` in a `finally`, which
 * lets everything held through and removes the hold.
 *
 *   const copies = holdCopies();
 *   try {
 *     await startCopy(backup.id);
 *     await copies.reached("NAS");        // copying now; later ones wait
 *     await copies.fail("NAS", "Link dropped");
 *   } finally {
 *     copies.release();
 *   }
 */
export function holdCopies() {
  type Held = { name: string; resolve: () => void; reject: (error: Error) => void };
  const held: Held[] = [];
  const arrivals: Array<() => void> = [];
  setDestinationGateForTests(
    (destination) =>
      new Promise<void>((resolve, reject) => {
        held.push({ name: destination.name, resolve, reject });
        for (const notify of arrivals.splice(0)) notify();
      }),
  );

  async function reached(name: string, ms = 10_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!held.some((entry) => entry.name === name)) {
      if (Date.now() > deadline) throw new Error(`Nothing for "${name}" started`);
      await new Promise<void>((resolve) => {
        arrivals.push(resolve);
        setTimeout(resolve, 25);
      });
    }
  }

  function take(name: string): Held {
    const index = held.findIndex((entry) => entry.name === name);
    if (index < 0) throw new Error(`Nothing for "${name}" is held`);
    return held.splice(index, 1)[0];
  }

  return {
    reached,
    /** Let what is held for `name` go ahead. */
    async pass(name: string): Promise<void> {
      await reached(name);
      take(name).resolve();
    },
    /** Fail what is held for `name` with `message`, as the destination would. */
    async fail(name: string, message: string): Promise<void> {
      await reached(name);
      take(name).reject(new Error(message));
    },
    /** Let everything through and stop holding. */
    release(): void {
      setDestinationGateForTests(null);
      for (const entry of held.splice(0)) entry.resolve();
    },
  };
}
