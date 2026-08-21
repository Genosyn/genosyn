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
  checkPayload?: Record<string, unknown>;
  approvalRequired?: boolean;
};

type RpcResult = {
  result?: {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
    tools?: Array<{ name: string }>;
  };
};

const vaultItemId = "10000000-0000-4000-8000-000000000001";
const vaultItemVersion = 7;
const vaultPasskeyId = "20000000-0000-4000-8000-000000000002";

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
        ...options.checkPayload,
      });
    }
    if (url.pathname === "/mcp/tools/queue_browser_approval") {
      const body = await requestJson(req);
      events.push(`queue:${String(body.action)}`);
      if (
        body.action === "vault_totp_submit" ||
        body.action === "vault_passkey_create" ||
        body.action === "vault_passkey_use"
      ) {
        assert.equal(body.vaultItemVersion, vaultItemVersion);
      }
      if (body.action === "vault_passkey_use") {
        assert.equal(body.vaultPasskeyId, vaultPasskeyId);
      }
      return json(res, 200, { approvalId: "approval-1", status: "pending" });
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
    if (url.pathname === "/browser/approval/describe-target") {
      const body = await requestJson(req);
      events.push(`describe:${String(body.action)}`);
      return json(res, 200, {
        pageUrl: approvedUrl,
        ...(body.action === "vault_totp_submit" ||
        body.action === "vault_passkey_create" ||
        body.action === "vault_passkey_use"
          ? { itemVersion: vaultItemVersion }
          : {}),
        ...(body.action === "vault_passkey_use" ? { passkeyId: vaultPasskeyId } : {}),
        targetFingerprint: "a".repeat(64),
        targetDescriptor: {
          tagName: "button",
          inputType: "submit",
          frameUrl: approvedUrl,
          formAction: approvedUrl,
          formMethod: "POST",
          submitsForm: true,
        },
      });
    }
    if (url.pathname === "/browser/vault/submit-totp") {
      const body = await requestJson(req);
      events.push("vault-totp-submit");
      assert.deepEqual(body, {
        ...(options.approvalRequired === false ? {} : { approvalId: "approval-1" }),
        itemId: vaultItemId,
        ...(options.approvalRequired === false ? {} : { itemVersion: vaultItemVersion }),
        totpSelector: "aria-ref=e8",
        selector: "aria-ref=e9",
        key: null,
      });
      return json(res, 200, { snapshot: "signed in with current TOTP" });
    }
    if (url.pathname === "/browser/vault/prepare-totp") {
      const body = await requestJson(req);
      assert.deepEqual(body, { itemId: vaultItemId });
      events.push("vault-totp-prepare");
      return json(res, 200, { message: "TOTP enrollment protected" });
    }
    if (url.pathname === "/browser/vault/capture-totp") {
      const body = await requestJson(req);
      assert.deepEqual(body, { itemId: vaultItemId, selector: "aria-ref=e8" });
      events.push("vault-totp-save");
      return json(res, 200, { message: "TOTP setup saved" });
    }
    if (
      url.pathname === "/browser/vault/passkeys/create" ||
      url.pathname === "/browser/vault/passkeys/use"
    ) {
      const body = await requestJson(req);
      const kind = url.pathname.endsWith("/create") ? "create" : "use";
      events.push(`vault-passkey-${kind}`);
      if (options.approvalRequired === false) assert.equal(body.approvalId, undefined);
      else assert.equal(body.approvalId, "approval-1");
      assert.equal(body.itemId, vaultItemId);
      if (options.approvalRequired === false) assert.equal(body.itemVersion, undefined);
      else assert.equal(body.itemVersion, vaultItemVersion);
      assert.equal(body.selector, "aria-ref=e9");
      if (kind === "use") {
        assert.equal(body.passkeyId, vaultPasskeyId);
      }
      return json(res, 200, { snapshot: `passkey ${kind} complete` });
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
      GENOSYN_BROWSER_APPROVAL_REQUIRED: options.approvalRequired === false ? "" : "1",
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
  const request = (method: string, params: Record<string, unknown>): Promise<RpcResult> => {
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
        method,
        params,
      }) + "\n",
    );
    return response;
  };
  const rpc = (
    name = "browser_resume",
    args: Record<string, unknown> = { approvalId: "approval-1" },
  ) => request("tools/call", { name, arguments: args });
  const listTools = () => request("tools/list", {});
  return { events, rpc, listTools };
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

test("approval mode refuses an early standalone Vault TOTP fill", async () => {
  const harness = await browserHarness();
  const response = await harness.rpc("browser_fill_vault", {
    itemId: vaultItemId,
    selector: "aria-ref=e8",
    field: "totp",
  });

  assert.equal(response.result?.isError, true);
  assert.match(response.result?.content?.[0]?.text ?? "", /browser_submit_with_vault_totp/);
  assert.deepEqual(harness.events, []);
});

test("exposes protected two-step TOTP enrollment and no legacy passkey tools", async () => {
  const harness = await browserHarness();
  const listed = await harness.listTools();
  const names = listed.result?.tools?.map((tool) => tool.name) ?? [];
  assert.equal(names.includes("browser_prepare_vault_totp"), true);
  assert.equal(names.includes("browser_save_vault_totp"), true);
  assert.equal(names.includes("browser_prepare_vault_passkey"), false);
  assert.equal(names.includes("browser_save_vault_passkey"), false);

  const prepared = await harness.rpc("browser_prepare_vault_totp", { itemId: vaultItemId });
  const saved = await harness.rpc("browser_save_vault_totp", {
    itemId: vaultItemId,
    selector: "aria-ref=e8",
  });
  assert.equal(prepared.result?.isError, undefined);
  assert.equal(saved.result?.isError, undefined);
  assert.deepEqual(harness.events, ["vault-totp-prepare", "vault-totp-save"]);
});

test("combined Vault TOTP submit queues before filling and resumes in the same child", async () => {
  const harness = await browserHarness({
    checkPayload: {
      action: "vault_totp_submit",
      targetBound: true,
      vaultItemId,
      vaultItemVersion,
      vaultTotpSelector: "aria-ref=e8",
    },
  });
  const queued = await harness.rpc("browser_submit_with_vault_totp", {
    itemId: vaultItemId,
    totpSelector: "aria-ref=e8",
    selector: "aria-ref=e9",
    summary: "Sign in",
  });

  assert.equal(queued.result?.isError, undefined);
  assert.match(queued.result?.content?.[0]?.text ?? "", /pending_approval/);
  assert.deepEqual(harness.events, ["describe:vault_totp_submit", "queue:vault_totp_submit"]);

  const resumed = await harness.rpc();
  assert.equal(resumed.result?.isError, undefined);
  assert.match(resumed.result?.content?.[0]?.text ?? "", /signed in with current TOTP/);
  assert.deepEqual(harness.events, [
    "describe:vault_totp_submit",
    "queue:vault_totp_submit",
    "check",
    "url",
    "vault-totp-submit",
  ]);
});

test("a fresh MCP child reconstructs the encrypted Vault TOTP binding on resume", async () => {
  const harness = await browserHarness({
    checkPayload: {
      action: "vault_totp_submit",
      targetBound: true,
      vaultItemId,
      vaultItemVersion,
      vaultTotpSelector: "aria-ref=e8",
    },
  });

  const resumed = await harness.rpc();
  assert.equal(resumed.result?.isError, undefined);
  assert.match(resumed.result?.content?.[0]?.text ?? "", /signed in with current TOTP/);
  assert.deepEqual(harness.events, ["check", "url", "vault-totp-submit"]);
});

test("Vault passkey creation injects no authenticator until its Approval resumes", async () => {
  const harness = await browserHarness({
    checkPayload: {
      action: "vault_passkey_create",
      targetBound: true,
      vaultItemId,
      vaultItemVersion,
    },
  });
  const queued = await harness.rpc("browser_create_vault_passkey", {
    itemId: vaultItemId,
    selector: "aria-ref=e9",
  });

  assert.equal(queued.result?.isError, undefined);
  assert.match(
    queued.result?.content?.[0]?.text ?? "",
    /No passkey authenticator has been injected/,
  );
  assert.deepEqual(harness.events, ["describe:vault_passkey_create", "queue:vault_passkey_create"]);

  const resumed = await harness.rpc();
  assert.equal(resumed.result?.isError, undefined);
  assert.deepEqual(harness.events, [
    "describe:vault_passkey_create",
    "queue:vault_passkey_create",
    "check",
    "url",
    "vault-passkey-create",
  ]);
});

test("passkey use resolves and queues an exact credential when the caller omits it", async () => {
  const harness = await browserHarness({
    checkPayload: {
      action: "vault_passkey_use",
      targetBound: true,
      vaultItemId,
      vaultItemVersion,
      vaultPasskeyId,
    },
  });
  const queued = await harness.rpc("browser_use_vault_passkey", {
    itemId: vaultItemId,
    selector: "aria-ref=e9",
  });

  assert.equal(queued.result?.isError, undefined);
  assert.deepEqual(harness.events, ["describe:vault_passkey_use", "queue:vault_passkey_use"]);

  const resumed = await harness.rpc();
  assert.equal(resumed.result?.isError, undefined);
  assert.deepEqual(harness.events, [
    "describe:vault_passkey_use",
    "queue:vault_passkey_use",
    "check",
    "url",
    "vault-passkey-use",
  ]);
});

test("a fresh MCP child reconstructs a version-bound Vault passkey-use action", async () => {
  const harness = await browserHarness({
    checkPayload: {
      action: "vault_passkey_use",
      targetBound: true,
      vaultItemId,
      vaultItemVersion,
      vaultPasskeyId,
    },
  });

  const resumed = await harness.rpc();
  assert.equal(resumed.result?.isError, undefined);
  assert.match(resumed.result?.content?.[0]?.text ?? "", /passkey use complete/);
  assert.deepEqual(harness.events, ["check", "url", "vault-passkey-use"]);
});

test("combined Vault authenticator tools execute directly when approval mode is off", async () => {
  const harness = await browserHarness({ approvalRequired: false });
  const totp = await harness.rpc("browser_submit_with_vault_totp", {
    itemId: vaultItemId,
    totpSelector: "aria-ref=e8",
    selector: "aria-ref=e9",
  });
  const passkey = await harness.rpc("browser_create_vault_passkey", {
    itemId: vaultItemId,
    selector: "aria-ref=e9",
  });

  assert.equal(totp.result?.isError, undefined);
  assert.equal(passkey.result?.isError, undefined);
  assert.deepEqual(harness.events, ["vault-totp-submit", "vault-passkey-create"]);
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
