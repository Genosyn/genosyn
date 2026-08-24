import { Agent, setGlobalDispatcher } from "undici";

/**
 * HTTP client configuration for the test run.
 *
 * Loaded with `--import` from the `test` npm script, so it applies once in
 * every test-file process `node:test` spawns.
 *
 * Route tests boot the real router on a real socket — a mocked `res` cannot
 * tell you that `/revenue/deals/board` is being swallowed by
 * `/revenue/deals/:id`. That makes each of them a `fetch` client talking to a
 * `node:http` server inside its own process, and those two disagree about when
 * a pooled connection dies.
 *
 * Node's HTTP server retires an idle keep-alive socket after
 * `keepAliveTimeout` (5s by default), measured on the real clock. undici — the
 * implementation behind global `fetch` — decides the same thing from a
 * *virtual* clock that advances a flat 499ms per tick however much wall time
 * actually passed, deliberately "independent from the system clock and delays
 * caused by a blocked event loop" (`undici/lib/util/timers.js`). The two agree
 * only while the event loop keeps up.
 *
 * Under `npm test` it does not keep up. `tsx --test` runs a worker per core and
 * `resetTestDb()` rebuilds every table synchronously before each test, so five
 * or more seconds of wall clock routinely pass inside a single virtual tick.
 * The server then closes a socket undici still believes is fresh, undici
 * dispatches the next request onto it, and the test fails with
 * `TypeError: fetch failed` / `ECONNRESET`. Every file that boots a server is
 * exposed, which is why it surfaced as a different handful of tests on each
 * run and never when a file was run on its own.
 *
 * `pipelining: 0` disables keep-alive outright: one connection per request,
 * closed at the end of it. There is then no idle socket for the two clocks to
 * disagree about. Pooling buys a test suite nothing — every server it talks to
 * is on loopback — and costs it a class of failure that only appears under
 * load, which is to say only on CI.
 */
setGlobalDispatcher(new Agent({ pipelining: 0 }));
