import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeCodexVerification } from "../test/modelVerification.js";
import { discoverCodexDefault, verifyCodexModel } from "./codexModelSetup.js";

test("ChatGPT chooses the live workspace default then verifies an isolated reply", async () => {
  const server = fakeCodexVerification("/scratch", { model: "gpt-workspace-default" });
  assert.equal(await verifyCodexModel(server, "/scratch", "auto"), "gpt-workspace-default");
});

test("ChatGPT preserves explicitly chosen models", async () => {
  assert.equal(
    await verifyCodexModel(fakeCodexVerification("/scratch"), "/scratch", "gpt-chosen"),
    "gpt-chosen",
  );
});

for (const options of [{ reply: "" }, { status: "failed" }, { status: "interrupted" }]) {
  test(`completed sign-in is not a working connection: ${JSON.stringify(options)}`, async () => {
    await assert.rejects(
      verifyCodexModel(fakeCodexVerification("/scratch", options), "/scratch", "gpt-chosen"),
      /without a reply|could not answer/,
    );
  });
}

test("ChatGPT rejects a thread that does not match the requested isolation", async () => {
  await assert.rejects(
    verifyCodexModel(fakeCodexVerification("/different"), "/scratch", "gpt-chosen"),
    /thread isolation/,
  );
});

test("workspace catalog follows cursors and honors only the nonhidden default", async (t) => {
  const server = fakeCodexVerification("/scratch");
  let calls = 0;
  t.mock.method(server, "request", async (_method: string, params: { cursor: string | null }) => {
    calls += 1;
    if (!params.cursor)
      return { data: [{ model: "hidden", hidden: true, isDefault: true }], nextCursor: "second" };
    return { data: [{ model: "visible-default", isDefault: true }], nextCursor: null };
  });
  assert.equal(await discoverCodexDefault(server), "visible-default");
  assert.equal(calls, 2);
});

test("no advertised workspace default does not invent a stale fallback", async (t) => {
  const server = fakeCodexVerification("/scratch");
  t.mock.method(server, "request", async () => ({
    data: [{ model: "only-model" }],
    nextCursor: null,
  }));
  await assert.rejects(discoverCodexDefault(server), /did not return a default/);
});
