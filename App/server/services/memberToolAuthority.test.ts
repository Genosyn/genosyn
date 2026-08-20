import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { STATIC_TOOLS } from "../mcp/toolManifest.js";
import {
  MEMBER_TOOL_AUTHORITY,
  memberInternalCallbackPolicy,
  memberToolPolicy,
} from "./memberToolAuthority.js";

describe("interactive Member tool policy", () => {
  test("classifies every manifest tool exactly once and no removed tool", () => {
    const manifest = STATIC_TOOLS.map((tool) => tool.name).sort();
    const classified = [...MEMBER_TOOL_AUTHORITY.keys()].sort();
    assert.deepEqual(
      classified,
      manifest,
      "A built-in tool was added or removed without an interactive Member authority review",
    );
  });

  test("keeps high-risk tool families out of the ordinary Member policy", () => {
    for (const tool of [
      "create_skill",
      "create_routine",
      "list_memory",
      "list_repositories",
      "send_chat_attachment",
      "run_explore_query",
      "create_chart",
      "list_vault_items",
      "create_vault_login",
      "update_vault_login",
    ]) {
      assert.equal(memberToolPolicy(tool), "admin", tool);
    }
    assert.equal(memberToolPolicy("create_invoice"), "finance.write");
    assert.equal(memberToolPolicy("list_invoices"), "finance.read");
    assert.equal(memberToolPolicy("create_todo"), "project");
    assert.equal(memberToolPolicy("read_pdf_fields"), "attachment");
    assert.equal(memberToolPolicy("start_notetaker"), "member");
    for (const tool of [
      "list_workspace_channels",
      "create_workspace_channel",
      "rename_workspace_channel",
      "archive_workspace_channel",
      "send_workspace_message",
    ]) {
      assert.equal(memberToolPolicy(tool), "channel", tool);
    }
  });

  test("fails closed for an unknown future tool", () => {
    assert.equal(memberToolPolicy("new_unreviewed_tool"), null);
    assert.equal(memberInternalCallbackPolicy("new_unreviewed_callback"), null);
    assert.equal(memberInternalCallbackPolicy("queue_browser_approval"), "admin");
    assert.equal(memberInternalCallbackPolicy("check_browser_approval"), "admin");
    assert.equal(memberInternalCallbackPolicy("claim_browser_approval"), "admin");
    assert.equal(memberInternalCallbackPolicy("finish_browser_approval"), "admin");
  });
});
