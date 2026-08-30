import assert from "node:assert/strict";
import test from "node:test";
import { DurableRunLog, formatToolResultLine } from "./runLog.js";

/**
 * These tests used to pin head-only truncation — `/^12345\n\[truncated/` — and
 * M58 deliberately breaks that. The buffer now keeps a head *and* a rolling
 * tail, because the ending of a long Run is the part the outcome checker, the
 * reflection turn, and a human reading the transcript all reach for, and it was
 * the one part guaranteed to be missing. What is pinned instead: the ending
 * survives, the middle is what goes, the loss is stated in bytes, and the
 * rendered total still fits the cap so no `logContent` row grows.
 */

test("checkpoints the live transcript and flushes the newest content on stop", async () => {
  const checkpoints: string[] = [];
  let resolveFirstCheckpoint: (() => void) | null = null;
  const firstCheckpoint = new Promise<void>((resolve) => {
    resolveFirstCheckpoint = resolve;
  });
  const log = new DurableRunLog({
    checkpointEveryMs: 10,
    persist: async (content) => {
      checkpoints.push(content);
      resolveFirstCheckpoint?.();
      resolveFirstCheckpoint = null;
    },
  });

  log.line("run started");
  log.write("working");
  await firstCheckpoint;

  assert.deepEqual(checkpoints, ["run started\nworking"]);

  log.line(" on the report");
  await log.stopCheckpointing();

  assert.equal(checkpoints.at(-1), "run started\nworking on the report\n");
});

test("serializes checkpoints so an older slow snapshot cannot overwrite a newer one", async () => {
  let persisted = "";
  let writes = 0;
  const log = new DurableRunLog({
    persist: async (content) => {
      writes += 1;
      if (writes === 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      persisted = content;
    },
  });

  log.write("first");
  const first = log.flush();
  log.write(" second");
  await log.stopCheckpointing();
  await first;

  assert.equal(writes, 2);
  assert.equal(persisted, "first second");
});

test("an overlong transcript keeps its ending, not just its beginning", async () => {
  let persisted = "";
  const log = new DurableRunLog({
    cap: 200,
    headBytes: 20,
    tailBytes: 20,
    persist: async (content) => {
      persisted = content;
    },
  });

  log.write("HEAD-".repeat(4)); // exactly the head budget
  for (let n = 0; n < 40; n++) log.write("middle ");
  log.write("FINAL ANSWER: done.");
  await log.stopCheckpointing();

  assert.equal(log.isTruncated, true);
  assert.match(persisted, /^HEAD-HEAD-HEAD-HEAD-/);
  assert.match(persisted, /FINAL ANSWER: done\.$/);
  assert.doesNotMatch(persisted, /middle middle middle/);
});

test("the marker between head and tail says how many bytes went missing", () => {
  const log = new DurableRunLog({ cap: 200, headBytes: 10, tailBytes: 10, persist: async () => {} });
  log.write("0123456789"); // fills the head
  log.write("abcdefghij"); // fills the tail
  assert.equal(log.isTruncated, false);
  assert.equal(log.value(), "0123456789abcdefghij");

  log.write("KLMNO");
  const marker = /\n\[… (\d+) bytes omitted …\]\n/.exec(log.value());
  assert.ok(marker, `expected an omission marker in ${log.value()}`);
  assert.equal(marker[1], "5");
  assert.equal(log.isTruncated, true);
  assert.equal(log.value().startsWith("0123456789"), true);
  assert.equal(log.value().endsWith("fghijKLMNO"), true);
});

test("the rendered transcript never outgrows the cap, marker included", () => {
  const log = new DurableRunLog({ cap: 2048, persist: async () => {} });
  for (let n = 0; n < 4000; n++) log.write(`step ${n}: a line of transcript output\n`);
  const value = log.value();
  assert.equal(log.isTruncated, true);
  assert.ok(
    Buffer.byteLength(value, "utf8") <= 2048,
    `rendered ${Buffer.byteLength(value, "utf8")} bytes, cap is 2048`,
  );
  assert.match(value, /step 3999: a line of transcript output\n$/);
});

test("a smaller cap shrinks both ends in proportion — it does not go head-only again", () => {
  const log = new DurableRunLog({ cap: 1024, persist: async () => {} });
  for (let n = 0; n < 2000; n++) log.write(`step ${n}\n`);
  const value = log.value();
  assert.match(value, /^step 0\nstep 1\n/);
  assert.match(value, /step 1999\n$/);
  assert.ok(Buffer.byteLength(value, "utf8") <= 1024);
});

test("multibyte writes are accounted in bytes, not characters", () => {
  const log = new DurableRunLog({ cap: 400, headBytes: 12, tailBytes: 12, persist: async () => {} });
  log.write("😀😀😀"); // 12 bytes, exactly the head
  log.write("tail-content-here");
  assert.equal(log.isTruncated, true);
  assert.equal(log.value().startsWith("😀😀😀"), true);
  assert.equal(log.value().endsWith("nt-here"), true);
});

test("a tool result line carries a clipped, single-line preview of what came back", () => {
  assert.equal(
    formatToolResultLine("read_file", { content: "line one\n  line two\t\tline three" }),
    "[tool:read_file] ok — line one line two line three",
  );
  assert.equal(
    formatToolResultLine("mail_send", { content: "recipient unknown", isError: true }),
    "[tool:mail_send] error — recipient unknown",
  );
  // Nothing came back: the line says so by saying nothing, rather than
  // rendering a dangling dash.
  assert.equal(formatToolResultLine("noop", { content: "   " }), "[tool:noop] ok");
  assert.equal(formatToolResultLine("noop", {}), "[tool:noop] ok");

  const long = formatToolResultLine("dump", { content: "x".repeat(5000) });
  const preview = long.slice("[tool:dump] ok — ".length);
  assert.equal(preview.length, 300);
  assert.equal(preview.endsWith("…"), true);
});
