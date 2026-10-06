import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Chrome's process-singleton lock on an employee's persisted profile, and when
 * it is safe to break.
 *
 * Chrome claims a `user-data-dir` with three symlinks inside it.
 * `SingletonLock` points at `<hostname>-<pid>` of the browser holding the
 * profile; `SingletonSocket` and `SingletonCookie` let a second launch hand its
 * command line to that browser instead of opening the profile twice. A clean
 * exit removes all three. A hard stop does not — the runtime's SIGKILL when
 * `docker stop` runs out of time, an OOM kill — and the profile lives on the
 * data volume, so the next container finds the lock still in place.
 *
 * Chrome breaks a lock left on its own host once that pid is no longer Chrome.
 * A lock naming another host it refuses to break, because it cannot see that
 * host's processes. Every `genosyn upgrade` recreates the container under a new
 * hostname, as a Kubernetes rollout does with a new pod name, so a single
 * unclean stop cost the employee their profile for good: every launch after it
 * fell back to an ephemeral browser without their sign-ins.
 */

const LOCK = "SingletonLock";

/** Lock last, the order Chrome's own cleanup uses. */
const SINGLETON_ENTRIES = ["SingletonSocket", "SingletonCookie", LOCK];

/**
 * Remove a stale lock from `userDataDir` so Chrome will open the profile.
 * Returns the lock's `<hostname>-<pid>` when it removed one, otherwise null.
 *
 * Stale means the lock names another host, or a process on this host that is
 * no longer running. Another host can only be a container that used this
 * volume before: the CLI stops the old container before it starts the new one,
 * and the Helm chart runs a single replica with `Recreate`. Two App processes
 * sharing one volume at once is not a supported topology, and there this would
 * break a live lock.
 *
 * This judges the directory alone. A caller that has its own Chrome running on
 * the profile must not ask (see `clearStaleLockUnlessOpen` in
 * `browserChromium.ts`).
 *
 * Never throws. A lock it cannot read or remove is left for Chrome to judge,
 * and a refusal still falls back to an ephemeral browser.
 */
export async function clearStaleProfileLock(userDataDir: string): Promise<string | null> {
  let holder: string;
  try {
    holder = await fs.readlink(path.join(userDataDir, LOCK));
  } catch {
    // No lock, or not one Chrome wrote: Chrome's lock is always a symlink.
    return null;
  }
  if (!lockIsStale(holder)) return null;
  try {
    // `rm` unlinks a symlink rather than following it, so a link pointing
    // outside the profile cannot take its target with it.
    for (const entry of SINGLETON_ENTRIES) {
      await fs.rm(path.join(userDataDir, entry), { force: true });
    }
  } catch {
    return null;
  }
  return holder;
}

function lockIsStale(holder: string): boolean {
  // Split where Chrome does, at the last "-". Hostnames can contain one (every
  // Kubernetes pod name does), and splitting at the first would read a live
  // lock on this host as one from another.
  const at = holder.lastIndexOf("-");
  if (at === -1 || holder.slice(0, at) !== os.hostname()) return true;
  return !processIsRunning(Number(holder.slice(at + 1)));
}

function processIsRunning(pid: number): boolean {
  // Zero and negative pids address process groups, not a process.
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists under another user. Only ESRCH says it is gone.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
