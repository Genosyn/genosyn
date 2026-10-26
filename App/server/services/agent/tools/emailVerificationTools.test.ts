import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { STATIC_TOOLS } from "../../../mcp/toolManifest.js";
import { mcpInternalRouter } from "../../../routes/mcpInternal.js";
import { memberToolPolicy } from "../../memberToolAuthority.js";
import { isTaintSource } from "../../taintPolicy.js";
import { TOOL_DOMAINS, domainOf } from "./toolIndex.js";

const EMAIL_TOOLS = ["verify_email", "find_contact_email"] as const;

function routeFor(name: string): { methods?: Record<string, boolean>; stack?: unknown[] } | undefined {
  const stack = (
    mcpInternalRouter as unknown as {
      stack?: Array<{ route?: { path?: unknown; methods?: Record<string, boolean>; stack?: unknown[] } }>;
    }
  ).stack;
  return stack?.map((layer) => layer.route).find((candidate) => candidate?.path === `/tools/${name}`);
}

describe("in-house email verification tools", () => {
  test("both tools are in the manifest, read-only, and live in the revenue domain", () => {
    for (const name of EMAIL_TOOLS) {
      const tool = STATIC_TOOLS.find((candidate) => candidate.name === name);
      assert.ok(tool, `missing manifest entry for ${name}`);
      assert.equal(tool.readOnly, true, `${name} should be read-only — it confirms, it does not write`);
      assert.equal(domainOf(name), "revenue", `${name} should be discoverable under the revenue domain`);
    }
    assert.ok(TOOL_DOMAINS.revenue.tools.includes("verify_email"));
    assert.ok(TOOL_DOMAINS.revenue.tools.includes("find_contact_email"));
  });

  test("both resolve to a POST handler on the internal MCP router", () => {
    for (const name of EMAIL_TOOLS) {
      const route = routeFor(name);
      assert.ok(route, `missing internal MCP handler for ${name}`);
      assert.equal(route.methods?.post, true, `${name} is not wired as a POST handler`);
      assert.ok((route.stack?.length ?? 0) > 0, `${name} has no handler middleware`);
    }
  });

  test("verify_email requires the address; find_contact_email requires nothing up front", () => {
    const verify = STATIC_TOOLS.find((t) => t.name === "verify_email")!;
    assert.deepEqual(verify.inputSchema.required, ["email"]);
    const find = STATIC_TOOLS.find((t) => t.name === "find_contact_email")!;
    // name/domain/contactId are interchangeable routes into the same lookup, so
    // the handler — not the schema — decides which combination is enough.
    assert.equal(find.inputSchema.required, undefined);
    for (const key of ["name", "domain", "contactId"]) {
      assert.ok(key in find.inputSchema.properties, `find_contact_email should accept ${key}`);
    }
  });

  test("a delegating Member may call them at member level", () => {
    for (const name of EMAIL_TOOLS) {
      assert.equal(memberToolPolicy(name), "member", `${name} should be member-level for delegated chat`);
    }
  });

  test("they are not taint sources — only structured verdicts reach the model", () => {
    // Nothing a mail server says is handed back verbatim, so there is no
    // injection channel and no reason to taint the turn.
    for (const name of EMAIL_TOOLS) {
      assert.equal(isTaintSource(name), false, `${name} must not be a taint source`);
    }
  });
});
