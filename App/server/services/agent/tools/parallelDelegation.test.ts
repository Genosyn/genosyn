import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { toolsBriefing } from "../systemPrompt.js";
import {
  createParallelDelegationTool,
  delegatedSystemPrompt,
  MAX_DELEGATIONS_PER_CALL,
  MAX_DELEGATIONS_PER_TURN,
  MAX_PARALLEL_DELEGATIONS,
  supportsParallelDelegation,
  type DelegatedBrief,
  type DelegatedBriefResult,
} from "./parallelDelegation.js";

function brief(index: number): { label: string; instruction: string } {
  return { label: `Issue ${index}`, instruction: `Investigate issue ${index}.` };
}

function completed(output = "done"): DelegatedBriefResult {
  return { status: "completed", output };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("Timed out waiting for delegated work to reach the expected state.");
}

test("subscription turns do not advertise delegation that would wait on their model lock", () => {
  assert.equal(supportsParallelDelegation("subscription"), false);
  assert.equal(supportsParallelDelegation("apikey"), true);
  assert.equal(supportsParallelDelegation("customEndpoint"), true);
  assert.equal(supportsParallelDelegation("apikey", 1), false);
  assert.equal(supportsParallelDelegation("customEndpoint", 1), false);
});

test("a temporary worker's inherited briefing does not promise recursive delegation", () => {
  const parent = [
    toolsBriefing("routine", true),
    "_Tools: `delegate_parallel_work`, `github_list_issues`_",
    "_Tools: `delegate_parallel_work`_",
    "A Skill may discuss delegation as business content.",
  ].join("\n");
  const worker = delegatedSystemPrompt(parent, "Issue 41");

  assert.match(parent, /- Parallel delegation: `delegate_parallel_work`/);
  assert.doesNotMatch(worker, /- Parallel delegation: `delegate_parallel_work`/);
  assert.doesNotMatch(worker, /_Tools: `delegate_parallel_work`/);
  assert.match(worker, /_Tools: `github_list_issues`_/);
  assert.match(worker, /A Skill may discuss delegation as business content/);
  assert.match(worker, /- Browser tools/);
  assert.match(worker, /## Temporary parallel worker/);
  assert.match(worker, /delegated brief "Issue 41"/);
});

test("chat and Routine briefings promise only tools the runtime offers", () => {
  for (const surface of ["chat", "routine"] as const) {
    assert.doesNotMatch(toolsBriefing(surface, false), /delegate_parallel_work/);
    assert.match(toolsBriefing(surface, true), /delegate_parallel_work/);
  }
  assert.match(toolsBriefing("routine", true), /explicitly asks to use subagents/);
  assert.doesNotMatch(toolsBriefing("chat", false, false), /`bash`/);
  assert.match(toolsBriefing("chat", false, true, true), /isolated `bash`/);
  assert.doesNotMatch(toolsBriefing("chat", false, true, true), /`read_file`/);
  assert.match(toolsBriefing("chat", false, true, true), /bubblewrap deployment/);
});

describe("delegate_parallel_work input", () => {
  test("publishes the same hard limits enforced by the runtime", () => {
    const tool = createParallelDelegationTool({
      budget: { remaining: MAX_DELEGATIONS_PER_TURN },
      runBrief: async () => completed(),
    });
    const properties = tool.inputSchema.properties as Record<string, Record<string, unknown>>;
    const tasks = properties.tasks;
    const concurrency = properties.maxConcurrency;

    assert.equal(tool.name, "delegate_parallel_work");
    assert.equal(tasks.minItems, 1);
    assert.equal(tasks.maxItems, MAX_DELEGATIONS_PER_CALL);
    assert.equal(concurrency.minimum, 1);
    assert.equal(concurrency.maximum, MAX_PARALLEL_DELEGATIONS);
    assert.equal(tool.inputSchema.additionalProperties, false);
  });

  test("trims labels and instructions before passing a self-contained brief to a worker", async () => {
    const seen: DelegatedBrief[] = [];
    const budget = { remaining: MAX_DELEGATIONS_PER_TURN };
    const tool = createParallelDelegationTool({
      budget,
      runBrief: async (value) => {
        seen.push(value);
        return completed("worker result");
      },
    });

    const result = await tool.run({
      tasks: [{ label: "  Issue 41  ", instruction: "  Inspect the failing test.  " }],
    });

    assert.deepEqual(seen, [{ label: "Issue 41", instruction: "Inspect the failing test." }]);
    assert.equal(budget.remaining, MAX_DELEGATIONS_PER_TURN - 1);
    assert.match(result.content, /1\/1 briefs completed \(concurrency 1\)/);
    assert.match(result.content, /## 1\. Issue 41 — completed\nworker result/);
    assert.equal(result.isError, undefined);
  });

  test("rejects malformed batches without spending budget or starting a worker", async () => {
    const invalid: Array<{ name: string; input: Record<string, unknown>; message: RegExp }> = [
      { name: "missing tasks", input: {}, message: /tasks.*array/ },
      { name: "non-array tasks", input: { tasks: "issue" }, message: /tasks.*array/ },
      { name: "empty batch", input: { tasks: [] }, message: /between 1 and 8/ },
      {
        name: "oversized batch",
        input: { tasks: Array.from({ length: MAX_DELEGATIONS_PER_CALL + 1 }, (_, i) => brief(i)) },
        message: /between 1 and 8/,
      },
      { name: "non-object task", input: { tasks: [null] }, message: /tasks\[0\].*object/ },
      { name: "array task", input: { tasks: [[]] }, message: /tasks\[0\].*object/ },
      {
        name: "missing label",
        input: { tasks: [{ instruction: "Do it" }] },
        message: /tasks\[0\]\.label/,
      },
      {
        name: "blank label",
        input: { tasks: [{ label: "   ", instruction: "Do it" }] },
        message: /tasks\[0\]\.label/,
      },
      {
        name: "long label",
        input: { tasks: [{ label: "l".repeat(81), instruction: "Do it" }] },
        message: /tasks\[0\]\.label/,
      },
      {
        name: "missing instruction",
        input: { tasks: [{ label: "Issue" }] },
        message: /tasks\[0\]\.instruction/,
      },
      {
        name: "blank instruction",
        input: { tasks: [{ label: "Issue", instruction: "   " }] },
        message: /tasks\[0\]\.instruction/,
      },
      {
        name: "long instruction",
        input: { tasks: [{ label: "Issue", instruction: "i".repeat(20_001) }] },
        message: /tasks\[0\]\.instruction/,
      },
      {
        name: "zero concurrency",
        input: { tasks: [brief(1)], maxConcurrency: 0 },
        message: /maxConcurrency.*integer from 1 to 4/,
      },
      {
        name: "excess concurrency",
        input: { tasks: [brief(1)], maxConcurrency: MAX_PARALLEL_DELEGATIONS + 1 },
        message: /maxConcurrency.*integer from 1 to 4/,
      },
      {
        name: "fractional concurrency",
        input: { tasks: [brief(1)], maxConcurrency: 1.5 },
        message: /maxConcurrency.*integer from 1 to 4/,
      },
      {
        name: "string concurrency",
        input: { tasks: [brief(1)], maxConcurrency: "2" },
        message: /maxConcurrency.*integer from 1 to 4/,
      },
    ];

    for (const item of invalid) {
      let calls = 0;
      const budget = { remaining: MAX_DELEGATIONS_PER_TURN };
      const tool = createParallelDelegationTool({
        budget,
        runBrief: async () => {
          calls += 1;
          return completed();
        },
      });

      const result = await tool.run(item.input);
      assert.equal(result.isError, true, item.name);
      assert.match(result.content, item.message, item.name);
      assert.equal(calls, 0, item.name);
      assert.equal(budget.remaining, MAX_DELEGATIONS_PER_TURN, item.name);
    }
  });
});

describe("delegate_parallel_work scheduling", () => {
  test("bounds concurrency and returns results in input order rather than completion order", async () => {
    const gates = new Map<string, ReturnType<typeof deferred<DelegatedBriefResult>>>();
    const started: string[] = [];
    const completedLabels: string[] = [];
    let active = 0;
    let peak = 0;
    const tool = createParallelDelegationTool({
      budget: { remaining: MAX_DELEGATIONS_PER_TURN },
      runBrief: async (value) => {
        started.push(value.label);
        active += 1;
        peak = Math.max(peak, active);
        const gate = deferred<DelegatedBriefResult>();
        gates.set(value.label, gate);
        const result = await gate.promise;
        active -= 1;
        completedLabels.push(value.label);
        return result;
      },
    });

    const pending = tool.run({
      tasks: Array.from({ length: 6 }, (_, i) => brief(i + 1)),
      maxConcurrency: 3,
    });
    await waitFor(() => started.length === 3);
    assert.deepEqual(started, ["Issue 1", "Issue 2", "Issue 3"]);
    assert.equal(peak, 3);

    gates.get("Issue 3")!.resolve(completed("result 3"));
    await waitFor(() => started.length === 4);
    gates.get("Issue 2")!.resolve(completed("result 2"));
    await waitFor(() => started.length === 5);
    gates.get("Issue 1")!.resolve(completed("result 1"));
    await waitFor(() => started.length === 6);
    gates.get("Issue 6")!.resolve(completed("result 6"));
    gates.get("Issue 5")!.resolve(completed("result 5"));
    gates.get("Issue 4")!.resolve(completed("result 4"));

    const result = await pending;
    assert.deepEqual(completedLabels, [
      "Issue 3",
      "Issue 2",
      "Issue 1",
      "Issue 6",
      "Issue 5",
      "Issue 4",
    ]);
    assert.equal(peak, 3);
    assert.match(result.content, /6\/6 briefs completed \(concurrency 3\)/);
    const headings = [...result.content.matchAll(/^## \d+\. (Issue \d+) — completed$/gm)].map(
      (match) => match[1],
    );
    assert.deepEqual(headings, ["Issue 1", "Issue 2", "Issue 3", "Issue 4", "Issue 5", "Issue 6"]);
  });

  test("shares a twelve-brief budget across calls and never starts an over-budget batch", async () => {
    let calls = 0;
    const budget = { remaining: MAX_DELEGATIONS_PER_TURN };
    const tool = createParallelDelegationTool({
      budget,
      runBrief: async () => {
        calls += 1;
        return completed();
      },
    });

    const first = await tool.run({
      tasks: Array.from({ length: MAX_DELEGATIONS_PER_CALL }, (_, i) => brief(i + 1)),
    });
    const second = await tool.run({
      tasks: Array.from({ length: MAX_DELEGATIONS_PER_TURN - MAX_DELEGATIONS_PER_CALL }, (_, i) =>
        brief(i + MAX_DELEGATIONS_PER_CALL + 1),
      ),
    });
    const rejected = await tool.run({ tasks: [brief(13)] });

    assert.equal(first.isError, undefined);
    assert.equal(second.isError, undefined);
    assert.equal(rejected.isError, true);
    assert.match(rejected.content, /delegate 0 more briefs; this call requested 1/);
    assert.equal(calls, MAX_DELEGATIONS_PER_TURN);
    assert.equal(budget.remaining, 0);
  });

  test("reserves a batch atomically so concurrent calls cannot overspend the shared budget", async () => {
    const gate = deferred<void>();
    let calls = 0;
    const budget = { remaining: MAX_DELEGATIONS_PER_TURN };
    const tool = createParallelDelegationTool({
      budget,
      runBrief: async () => {
        calls += 1;
        await gate.promise;
        return completed();
      },
    });
    const batch = Array.from({ length: MAX_DELEGATIONS_PER_CALL }, (_, i) => brief(i + 1));

    const first = tool.run({ tasks: batch });
    await waitFor(() => calls === MAX_PARALLEL_DELEGATIONS);
    const second = await tool.run({ tasks: batch });

    assert.equal(second.isError, true);
    assert.match(second.content, /delegate 4 more briefs; this call requested 8/);
    assert.equal(budget.remaining, 4);
    gate.resolve();
    const firstResult = await first;
    assert.equal(firstResult.isError, undefined);
    assert.equal(calls, MAX_DELEGATIONS_PER_CALL);
  });
});

describe("delegate_parallel_work results and cancellation", () => {
  test("contains worker failures, keeps partial success usable, and charges failed work", async () => {
    const budget = { remaining: MAX_DELEGATIONS_PER_TURN };
    const tool = createParallelDelegationTool({
      budget,
      runBrief: async (value) => {
        if (value.label === "Issue 2") return { status: "failed", error: "could not reproduce" };
        if (value.label === "Issue 3") throw new Error("worker crashed");
        return completed("");
      },
    });

    const result = await tool.run({ tasks: [brief(1), brief(2), brief(3)] });

    assert.equal(result.isError, undefined);
    assert.match(result.content, /1\/3 briefs completed/);
    assert.match(result.content, /## 1\. Issue 1 — completed\n\(no output\)/);
    assert.match(result.content, /## 2\. Issue 2 — failed\ncould not reproduce/);
    assert.match(result.content, /## 3\. Issue 3 — failed\nworker crashed/);
    assert.equal(budget.remaining, MAX_DELEGATIONS_PER_TURN - 3);
  });

  test("marks the tool result as an error only when every worker fails", async () => {
    const tool = createParallelDelegationTool({
      budget: { remaining: MAX_DELEGATIONS_PER_TURN },
      runBrief: async (value) => ({ status: "failed", error: `failed ${value.label}` }),
    });

    const result = await tool.run({ tasks: [brief(1), brief(2)] });

    assert.equal(result.isError, true);
    assert.match(result.content, /0\/2 briefs completed/);
    assert.match(result.content, /failed Issue 1/);
    assert.match(result.content, /failed Issue 2/);
  });

  test("clips an individual worker result before returning it to the parent", async () => {
    const visible = "x".repeat(12_000);
    const tool = createParallelDelegationTool({
      budget: { remaining: MAX_DELEGATIONS_PER_TURN },
      runBrief: async () => completed(visible + "NEVER_EXPOSE_THIS_SUFFIX"),
    });

    const result = await tool.run({ tasks: [brief(1)] });

    assert.match(result.content, /\[truncated after 12000 characters\]/);
    assert.doesNotMatch(result.content, /NEVER_EXPOSE_THIS_SUFFIX/);
    assert.ok(result.content.includes(visible));
  });

  test("an already-aborted turn neither spends budget nor starts workers", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const budget = { remaining: MAX_DELEGATIONS_PER_TURN };
    const tool = createParallelDelegationTool({
      budget,
      signal: controller.signal,
      runBrief: async () => {
        calls += 1;
        return completed();
      },
    });

    const result = await tool.run({ tasks: [brief(1)] });

    assert.equal(result.isError, true);
    assert.match(result.content, /aborted before it started/i);
    assert.equal(calls, 0);
    assert.equal(budget.remaining, MAX_DELEGATIONS_PER_TURN);
  });

  test("an abort lets active workers settle but prevents queued briefs from starting", async () => {
    const controller = new AbortController();
    const active = deferred<void>();
    const started: string[] = [];
    const budget = { remaining: MAX_DELEGATIONS_PER_TURN };
    const tool = createParallelDelegationTool({
      budget,
      signal: controller.signal,
      runBrief: async (value) => {
        started.push(value.label);
        await active.promise;
        return completed(`finished ${value.label}`);
      },
    });

    const pending = tool.run({
      tasks: [brief(1), brief(2), brief(3), brief(4)],
      maxConcurrency: 2,
    });
    await waitFor(() => started.length === 2);
    controller.abort();
    active.resolve();
    const result = await pending;

    assert.deepEqual(started, ["Issue 1", "Issue 2"]);
    assert.equal(budget.remaining, MAX_DELEGATIONS_PER_TURN - 4);
    assert.equal(result.isError, undefined);
    assert.match(result.content, /2\/4 briefs completed/);
    assert.match(result.content, /## 3\. Issue 3 — failed\nAborted before this brief started\./);
    assert.match(result.content, /## 4\. Issue 4 — failed\nAborted before this brief started\./);
  });
});
