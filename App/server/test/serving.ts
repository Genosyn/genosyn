/**
 * Await work the way a running server would.
 *
 * A server's listening socket keeps its event loop going, so the timers the
 * product unrefs on purpose — so that none of them holds a stopping process
 * open — still fire there: the queue starting the next waiting Run a second
 * after an AI Model is back, a waiting group discussion looking again. A test
 * process has no such socket. When one of those timers is all that is left,
 * Node 22's test runner sees an idle process and cancels the waiting test, and
 * every test after it ("Promise resolution is still pending but the event loop
 * has already resolved"). Node 24's runner keeps the loop going by itself,
 * which is why such a test can pass on a newer Node and fail on CI's.
 *
 * This holds the loop open while `work` is pending, and changes no timing.
 * The timer that holds it is also a deadline, so work that never ends fails
 * its test, saying what it was waiting for, rather than holding up the run.
 *
 *   await modelIsBack(model);
 *   const done = await whileServing(Promise.all(completions), "the paced Runs");
 */
export async function whileServing<T>(work: Promise<T>, what: string, ms = 60_000): Promise<T> {
  let serving: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        serving = setTimeout(
          () => reject(new Error(`Still waiting for ${what} after ${ms / 1000}s.`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(serving);
  }
}
