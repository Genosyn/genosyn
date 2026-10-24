import { pbkdf2 } from "node:crypto";

/**
 * Keep every thread in libuv's pool busy, the way a loaded server's are, so
 * each file open waits its turn. Returns a function that stops and waits for
 * the pool to drain — and for whatever was waiting in it to run.
 *
 * A file stream opened and then forgotten only fails once the pool gets to
 * its open, which an idle test process does at once and a busy server much
 * later: long enough for the file to be removed first. Removing it with a
 * synchronous call while the pool is held, then draining, makes that the
 * outcome every run rather than about one CI run in four.
 */
export function occupyThreadPool(): () => Promise<void> {
  let busy = true;
  const threads = Number(process.env.UV_THREADPOOL_SIZE) || 4;
  const work = async () => {
    while (busy) {
      await new Promise<void>((resolve, reject) =>
        pbkdf2("busy", "salt", 50_000, 32, "sha256", (err) => (err ? reject(err) : resolve())),
      );
    }
  };
  const workers = Array.from({ length: threads * 2 }, work);
  return async () => {
    busy = false;
    await Promise.all(workers);
  };
}
