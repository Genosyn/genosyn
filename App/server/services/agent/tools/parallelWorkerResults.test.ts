import assert from "node:assert/strict";
import test from "node:test";
import {
  createParallelResultStore,
  createParallelWorkResultTool,
  type ParallelResultStore,
} from "./parallelWorkerResults.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flush() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function pendingStore() {
  const store = createParallelResultStore();
  const resultId = store.reserve("Current source review")!;
  let reads = 0;
  const observed: ParallelResultStore = {
    ...store,
    read: (...args) => {
      reads++;
      return store.read(...args);
    },
  };
  return { store, observed, resultId, reads: () => reads };
}

test("ordinary result listing and default immediate pending reads retain their contract", async () => {
  const { observed, resultId, reads } = pendingStore();
  const reader = createParallelWorkResultTool(observed);
  assert.equal(reader.readOnly, true);
  assert.equal(reader.executionLane, "delegation");
  const listed = JSON.parse((await reader.run({})).content);
  assert.equal(listed.results.length, 1);
  assert.equal(listed.results[0].resultId, resultId);
  assert.equal(reads(), 0);
  const pending = JSON.parse((await reader.run({ resultId })).content);
  assert.equal(pending.status, "pending");
  assert.equal(pending.coverage.complete, false);
  assert.equal(reads(), 1);
  assert.deepEqual(JSON.parse((await reader.run({ resultId, waitMs: 0 })).content), pending);
  assert.equal(reads(), 2);
});

test("paged listing is still immediate and preserves its listing cursor", async () => {
  const { observed } = pendingStore();
  let requestedOffset: number | undefined;
  const reader = createParallelWorkResultTool({
    ...observed,
    listPage: async (offset) => {
      requestedOffset = offset;
      return {
        results: [],
        coverage: {
          offset,
          limit: 12,
          scanned: 12,
          returned: 0,
          total: 40,
          hasMore: true,
          nextOffset: 24,
        },
      };
    },
  });
  const listed = JSON.parse((await reader.run({ offset: 12, waitMs: 0 })).content);
  assert.equal(requestedOffset, 12);
  assert.equal(listed.coverage.nextOffset, 24);
  assert.deepEqual(listed.results, []);
});

for (const waitMs of [-1, 30_001, 0.5, "1000", null, true, Number.NaN, Number.POSITIVE_INFINITY]) {
  test(`invalid waitMs ${String(waitMs)} is rejected without reading worker evidence`, async () => {
    const { observed, resultId, reads } = pendingStore();
    const result = await createParallelWorkResultTool(observed).run({ resultId, waitMs });
    assert.equal(result.isError, true);
    assert.match(result.content, /Invalid.*waitMs/);
    assert.equal(reads(), 0);
  });
}

test("a positive wait requires an exact valid result ID and rejects unknown input fields", async () => {
  const { observed, resultId, reads } = pendingStore();
  const reader = createParallelWorkResultTool(observed);
  for (const input of [
    { waitMs: 1 },
    { resultId: "all", waitMs: 30_000 },
    { resultId, waitMs: 1, status: "pending" },
  ]) {
    const result = await reader.run(input);
    assert.equal(result.isError, true);
  }
  assert.equal(reads(), 0);
});

for (const status of ["completed", "failed"] as const) {
  test(`an already ${status} result returns immediately with the requested page`, async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
    const { store, observed, resultId, reads } = pendingStore();
    store.finish(
      resultId,
      status === "completed" ? { status, output: "1234567890" } : { status, error: "1234567890" },
    );
    const result = await createParallelWorkResultTool(observed).run({
      resultId,
      waitMs: 30_000,
      offset: 3,
      maxChars: 4,
    });
    const body = JSON.parse(result.content);
    assert.equal(result.isError, undefined);
    assert.equal(body.status, status);
    assert.equal(body.text, "4567");
    assert.equal(body.coverage.nextOffset, 7);
    assert.equal(body.coverage.complete, false);
    assert.equal(reads(), 1);
    assert.equal(Date.now(), 0, "finished results must not consume the wait budget");
  });
}

for (const status of ["completed", "failed"] as const) {
  test(`a pending result returns its ${status} evidence at the next bounded read`, async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
    const { store, observed, resultId, reads } = pendingStore();
    let returned = false;
    const response = createParallelWorkResultTool(observed)
      .run({ resultId, waitMs: 30_000 })
      .then((result) => {
        returned = true;
        return result;
      });
    await flush();
    assert.equal(reads(), 1);
    t.mock.timers.tick(999);
    await flush();
    assert.equal(returned, false);
    assert.equal(reads(), 1, "pending reads must not poll faster than once a second");
    store.finish(
      resultId,
      status === "completed"
        ? { status, output: "verified evidence" }
        : { status, error: "source unavailable" },
    );
    t.mock.timers.tick(1);
    const body = JSON.parse((await response).content);
    assert.equal(body.status, status);
    assert.equal(body.text, status === "completed" ? "verified evidence" : "source unavailable");
    assert.equal(body.coverage.complete, true);
    assert.equal(reads(), 2);
    t.mock.timers.tick(30_000);
    await flush();
    assert.equal(reads(), 2, "completion must leave no polling timer behind");
  });
}

for (const waitMs of [1, 750, 30_000]) {
  test(`an unfinished result returns honest pending coverage after waitMs ${waitMs}`, async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
    const { observed, resultId, reads } = pendingStore();
    const response = createParallelWorkResultTool(observed).run({ resultId, waitMs });
    await flush();
    t.mock.timers.tick(waitMs);
    const result = await response;
    const body = JSON.parse(result.content);
    assert.equal(result.isError, undefined);
    assert.equal(body.status, "pending");
    assert.equal(body.text, "");
    assert.equal(body.coverage.complete, false);
    assert.equal(reads(), 2, "the final result must come from a fresh authorized read");
  });
}

test("read time consumes the original wait budget instead of starting a fresh timeout", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const { store, resultId } = pendingStore();
  const slowRead = deferred<void>();
  let reads = 0;
  let returned = false;
  const reader = createParallelWorkResultTool({
    ...store,
    read: async (...args) => {
      if (++reads === 2) await slowRead.promise;
      return store.read(...args);
    },
  });
  const response = reader.run({ resultId, waitMs: 2_500 }).then((result) => {
    returned = true;
    return result;
  });
  await flush();
  t.mock.timers.tick(1_000);
  await flush();
  assert.equal(reads, 2);
  t.mock.timers.tick(1_000);
  slowRead.resolve();
  await flush();
  t.mock.timers.tick(499);
  await flush();
  assert.equal(returned, false);
  t.mock.timers.tick(1);
  assert.equal(JSON.parse((await response).content).status, "pending");
  assert.equal(reads, 3);
  assert.equal(Date.now(), 2_500);
});

for (const waitMs of [750, 30_000]) {
  test(`lost Grants stop a ${waitMs}ms wait without returning cached evidence or further reads`, async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
    const { store, resultId } = pendingStore();
    let authorized = true;
    let reads = 0;
    const reader = createParallelWorkResultTool({
      ...store,
      read: (...args) => {
        reads++;
        return authorized ? store.read(...args) : null;
      },
    });
    const response = reader.run({ resultId, waitMs });
    await flush();
    authorized = false;
    store.finish(resultId, { status: "completed", output: "sensitive completed evidence" });
    t.mock.timers.tick(Math.min(waitMs, 1_000));
    const result = await response;
    assert.equal(result.isError, true);
    assert.match(result.content, /Grants are no longer available/);
    assert.doesNotMatch(result.content, /sensitive|Current source review/);
    assert.equal(reads, 2);
    t.mock.timers.tick(30_000);
    await flush();
    assert.equal(reads, 2);
  });
}

test("an unavailable exact result returns immediately without starting a wait", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const { observed, reads } = pendingStore();
  const response = await createParallelWorkResultTool(observed).run({
    resultId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    waitMs: 30_000,
  });
  assert.equal(response.isError, true);
  assert.equal(reads(), 1);
  assert.equal(Date.now(), 0);
});

test("parent cancellation clears a pending timer and stops further authorized reads", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const controller = new AbortController();
  const { observed, resultId, reads } = pendingStore();
  const response = createParallelWorkResultTool(observed, { signal: controller.signal }).run({
    resultId,
    waitMs: 30_000,
  });
  await flush();
  controller.abort(new Error("original deadline reached"));
  const result = await response;
  assert.equal(result.isError, true);
  assert.match(result.content, /parent turn ended/);
  assert.doesNotMatch(result.content, /Current source review/);
  t.mock.timers.tick(30_000);
  await flush();
  assert.equal(reads(), 1);
});

test("parent cancellation interrupts an in-flight read and never exposes its later output", async () => {
  const controller = new AbortController();
  const { store, resultId } = pendingStore();
  const release = deferred<void>();
  let reads = 0;
  const reader = createParallelWorkResultTool(
    {
      ...store,
      read: async (...args) => {
        reads++;
        await release.promise;
        return store.read(...args);
      },
    },
    { signal: controller.signal },
  );
  const response = reader.run({ resultId, waitMs: 30_000 });
  await flush();
  controller.abort();
  const result = await response;
  assert.equal(result.isError, true);
  store.finish(resultId, { status: "completed", output: "late evidence" });
  release.resolve();
  await flush();
  assert.equal(reads, 1);
  assert.doesNotMatch(result.content, /late evidence/);
});

test("an already ended parent starts no result read", async () => {
  const controller = new AbortController();
  controller.abort();
  const { observed, resultId, reads } = pendingStore();
  const result = await createParallelWorkResultTool(observed, { signal: controller.signal }).run({
    resultId,
    waitMs: 30_000,
  });
  assert.equal(result.isError, true);
  assert.equal(reads(), 0);
});

test("a source read failure is not converted into an empty or pending success", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const { store, resultId } = pendingStore();
  let reads = 0;
  const reader = createParallelWorkResultTool({
    ...store,
    read: (...args) => {
      if (++reads === 2) throw new Error("source read failed");
      return store.read(...args);
    },
  });
  const response = reader.run({ resultId, waitMs: 30_000 });
  const rejected = assert.rejects(response, /source read failed/);
  await flush();
  t.mock.timers.tick(1_000);
  await rejected;
  t.mock.timers.tick(30_000);
  await flush();
  assert.equal(reads, 2);
});
