import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import readline from "node:readline";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

type HarnessOptions = {
  clickFails?: boolean;
  finishFails?: boolean;
  staleChecks?: boolean;
  approvedUrl?: string;
  claimedUrl?: string;
  currentUrls?: string[];
};

type RpcResult = {
  result?: {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
};

const children = new Set<ChildProcessWithoutNullStreams>();
const servers = new Set<Server>();

afterEach(async () => {
  for (const child of children) child.kill("SIGTERM");
  children.clear();
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  servers.clear();
});

async function browserHarness(options: HarnessOptions = {}) {
  const events: string[] = [];
  let status = "approved";
  let executed = false;
  let urlReads = 0;
  const claimToken = "claim-token-" + "x".repeat(32);
  const approvedUrl = options.approvedUrl ?? "https://shop.example.test/checkout?step=review";
  const currentUrls = options.currentUrls ?? [approvedUrl];

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/mcp/tools/check_browser_approval/approval-1") {
      events.push("check");
      return json(res, 200, {
        status: options.staleChecks ? "approved" : status,
        selector: "aria-ref=e9",
        key: null,
        pageUrl: options.claimedUrl ?? approvedUrl,
        executed: options.staleChecks ? false : executed,
      });
    }
    if (url.pathname === "/mcp/tools/claim_browser_approval/approval-1") {
      events.push("claim");
      if (status !== "approved" || executed) {
        return json(res, 409, { error: "already claimed" });
      }
      status = "executing";
      return json(res, 200, {
        status,
        claimToken,
        selector: "aria-ref=e9",
        key: null,
        pageUrl: approvedUrl,
      });
    }
    if (url.pathname === "/mcp/tools/finish_browser_approval/approval-1") {
      const body = await requestJson(req);
      events.push(`finish:${String(body.outcome)}`);
      assert.equal(body.claimToken, claimToken);
      if (options.finishFails) return json(res, 503, { error: "receipt unavailable" });
      status = body.outcome === "executed" ? "approved" : "execution_failed";
      executed = body.outcome === "executed";
      return json(res, 200, { ok: true, status });
    }
    if (url.pathname === "/browser/url") {
      events.push("url");
      const currentUrl = currentUrls[Math.min(urlReads, currentUrls.length - 1)] ?? "";
      urlReads += 1;
      return json(res, 200, { url: currentUrl });
    }
    if (url.pathname === "/browser/click") {
      events.push("click");
      if (options.clickFails) return json(res, 504, { error: "click timed out" });
      return json(res, 200, { snapshot: "checkout submitted" });
    }
    return json(res, 404, { error: "unexpected test endpoint" });
  });
  servers.add(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.mjs");
  const child = spawn(process.execPath, [script], {
    env: {
      ...process.env,
      GENOSYN_MCP_API: `${base}/mcp`,
      GENOSYN_MCP_TOKEN: "mcp-token",
      GENOSYN_BROWSER_API: `${base}/browser`,
      GENOSYN_BROWSER_SESSION_TOKEN: "browser-token",
      GENOSYN_BROWSER_APPROVAL_REQUIRED: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map<number, (result: RpcResult) => void>();
  lines.on("line", (line) => {
    const message = JSON.parse(line) as RpcResult & { id?: number };
    if (typeof message.id !== "number") return;
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  let nextId = 0;
  const rpc = (name = "browser_resume"): Promise<RpcResult> => {
    const id = ++nextId;
    const response = new Promise<RpcResult>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("browser MCP test timed out")), 5_000);
      pending.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: { approvalId: "approval-1" } },
      }) + "\n",
    );
    return response;
  };
  return { events, rpc };
}

test("browser_resume claims before the browser side effect and records completion", async () => {
  const harness = await browserHarness();
  const response = await harness.rpc();

  assert.equal(response.result?.isError, undefined);
  assert.match(response.result?.content?.[0]?.text ?? "", /checkout submitted/);
  assert.deepEqual(harness.events, ["check", "url", "claim", "url", "click", "finish:executed"]);
});

test("browser_resume accepts canonically equivalent approved URLs", async () => {
  const canonicalUrl = "https://shop.example.test/checkout?step=review#confirm";
  const harness = await browserHarness({
    approvedUrl: "https://SHOP.example.test:443/cart/../checkout?step=review#confirm",
    currentUrls: [canonicalUrl, canonicalUrl],
  });
  const response = await harness.rpc();

  assert.equal(response.result?.isError, undefined);
  assert.equal(harness.events.includes("click"), true);
  assert.equal(harness.events.includes("finish:executed"), true);
});

test("browser_resume binds approval to the canonical URL including its query", async () => {
  const harness = await browserHarness({
    approvedUrl: "https://SHOP.example.test:443/cart/../checkout?step=review#confirm",
    currentUrls: ["https://shop.example.test/checkout?step=payment#confirm"],
  });
  const response = await harness.rpc();

  assert.equal(response.result?.isError, true);
  assert.match(response.result?.content?.[0]?.text ?? "", /exact canonical URL/i);
  assert.deepEqual(harness.events, ["check", "url"]);
});

test("browser_resume deliberately binds approval to the URL fragment for SPA views", async () => {
  const harness = await browserHarness({
    approvedUrl: "https://shop.example.test/checkout?step=review#confirm",
    currentUrls: ["https://shop.example.test/checkout?step=review#change-payment"],
  });
  const response = await harness.rpc();

  assert.equal(response.result?.isError, true);
  assert.match(response.result?.content?.[0]?.text ?? "", /fragment/i);
  assert.deepEqual(harness.events, ["check", "url"]);
});

test("a query change after the atomic claim fails terminally before the click", async () => {
  const approvedUrl = "https://shop.example.test/checkout?account=primary&step=review";
  const harness = await browserHarness({
    approvedUrl,
    currentUrls: [approvedUrl, "https://shop.example.test/checkout?account=secondary&step=review"],
  });
  const response = await harness.rpc();

  assert.equal(response.result?.isError, true);
  assert.match(
    response.result?.content?.[0]?.text ?? "",
    /consumed approval will not be replayed/i,
  );
  assert.equal(harness.events.includes("click"), false);
  assert.deepEqual(harness.events, ["check", "url", "claim", "url", "finish:failed"]);
});

test("concurrent browser_resume calls can click only once", async () => {
  // Both children deliberately receive the same stale informational check;
  // only the server-side conditional claim may decide the winner.
  const harness = await browserHarness({ staleChecks: true });
  const results = await Promise.all([harness.rpc(), harness.rpc()]);

  assert.equal(harness.events.filter((event) => event === "claim").length, 2);
  assert.equal(harness.events.filter((event) => event === "click").length, 1);
  assert.equal(harness.events.filter((event) => event === "finish:executed").length, 1);
  assert.equal(results.filter((result) => result.result?.isError).length, 1);
  assert.equal(results.filter((result) => !result.result?.isError).length, 1);
});

test("a failed browser side effect records terminal failure and is not replayed", async () => {
  const harness = await browserHarness({ clickFails: true });
  const first = await harness.rpc();
  const second = await harness.rpc();

  assert.equal(first.result?.isError, true);
  assert.match(first.result?.content?.[0]?.text ?? "", /will not be replayed/i);
  assert.equal(second.result?.isError, true);
  assert.match(second.result?.content?.[0]?.text ?? "", /failed/i);
  assert.equal(harness.events.filter((event) => event === "click").length, 1);
  assert.deepEqual(harness.events, [
    "check",
    "url",
    "claim",
    "url",
    "click",
    "finish:failed",
    "check",
  ]);
});

test("a lost completion receipt leaves terminal ambiguity without replay", async () => {
  const harness = await browserHarness({ finishFails: true });
  const first = await harness.rpc();
  const second = await harness.rpc();

  assert.equal(first.result?.isError, undefined);
  assert.match(first.result?.content?.[1]?.text ?? "", /remains consumed/i);
  assert.equal(second.result?.isError, true);
  assert.match(second.result?.content?.[0]?.text ?? "", /outcome is unknown/i);
  assert.equal(harness.events.filter((event) => event === "click").length, 1);
  assert.deepEqual(harness.events, [
    "check",
    "url",
    "claim",
    "url",
    "click",
    "finish:executed",
    "check",
  ]);
});

async function requestJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) raw += chunk.toString();
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
