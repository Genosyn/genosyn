import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { STATIC_TOOLS } from "../../../mcp/toolManifest.js";
import { collapseStaticTools } from "./genosynFamilies.js";
import { createFindToolsTool, createCallTool } from "./discovery.js";
import { RESIDENT_GENOSYN_TOOLS } from "./index.js";
import type { AgentTool } from "../types.js";

/**
 * Recall gate for `find_tools`.
 *
 * The whole design rests on one promise: a capability the model has not been
 * shown is still reachable. That promise is only as good as the retriever, and
 * the retriever runs on a corpus where the obvious vocabulary is measurably
 * absent — "spreadsheet" appears in none of the 104 tool descriptions,
 * "database" in one. So the curated keyword layer in `toolIndex.ts` *is* the
 * feature, and this file is what stops someone deleting a keyword that looks
 * redundant.
 *
 * What this is not: a model eval. It proves the index can find the tool, not
 * that a 7B model behind Ollama decides to go looking. That gap is real and
 * tracked as an open item on M29.
 */

/** The deferred catalogue, built without touching a database. */
function deferredCatalogue(): AgentTool[] {
  const { collapsed, passthrough } = collapseStaticTools();
  const resident = new Set(RESIDENT_GENOSYN_TOOLS);
  const all: AgentTool[] = [
    ...collapsed.map((c) => ({
      name: c.name,
      description: c.description,
      inputSchema: c.inputSchema as Record<string, unknown>,
      run: async () => ({ content: "" }),
    })),
    ...passthrough.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown>,
      run: async () => ({ content: "" }),
    })),
  ];
  return all.filter((t) => !resident.has(t.name));
}

function findTools(grantDead = new Set<string>()) {
  const searchable = deferredCatalogue();
  return createFindToolsTool({
    searchable,
    resolve: (name) => searchable.find((t) => t.name === name),
    grantDead,
  });
}

/**
 * Every query an operator or model would plausibly type, paired with the tool
 * that must come back. Each of these was chosen because raw description
 * matching gets it wrong.
 */
const RECALL_CASES: Array<{ query: string; expect: string }> = [
  { query: "read a spreadsheet", expect: "list_base_rows" },
  { query: "spreadsheet", expect: "list_bases" },
  { query: "add a column to the table", expect: "add_base_field" },
  { query: "which database connections can I use", expect: "list_explore_connections" },
  { query: "inspect the warehouse schema", expect: "get_explore_schema" },
  { query: "query the database", expect: "run_explore_query" },
  { query: "run some sql", expect: "run_explore_query" },
  { query: "record a payment", expect: "record_payment" },
  { query: "who owes us money", expect: "list_invoices" },
  { query: "unpaid invoices", expect: "list_invoices" },
  { query: "prepare a quotation for a client", expect: "create_estimate" },
  { query: "raise an invoice for a client", expect: "create_invoice" },
  { query: "set up automatic annual invoice renewal", expect: "create_recurring_invoice" },
  { query: "pause recurring billing", expect: "update_recurring_invoice" },
  { query: "add a new client", expect: "create_customer" },
  { query: "profit and loss", expect: "get_finance_report" },
  { query: "reconcile the books", expect: "review_finance_transaction" },
  { query: "what did we discuss on the call", expect: "get_meeting_transcript" },
  { query: "recent calls with this customer", expect: "list_meetings" },
  { query: "join the Google Meet and take notes", expect: "start_notetaker" },
  { query: "who was on the meeting", expect: "get_meeting" },
  { query: "reply to that email", expect: "send_mail" },
  { query: "draft an email", expect: "create_mail_draft" },
  { query: "search my inbox", expect: "search_mail" },
  { query: "which mailboxes do i have", expect: "list_mail_accounts" },
  { query: "archive this email", expect: "update_mail_thread" },
  { query: "attach a file to this record", expect: "attach_file_to_record" },
  { query: "comment on a record", expect: "create_record_comment" },
  { query: "write a doc", expect: "create_note" },
  { query: "find a wiki page", expect: "search_notes" },
  { query: "look something up in the knowledge library", expect: "search_resources" },
  { query: "which agreements are still awaiting signature", expect: "list_signature_envelopes" },
  { query: "inspect the signer progress on this contract", expect: "get_signature_envelope" },
  {
    query: "check whether this signature request is ready to send",
    expect: "get_signature_envelope",
  },
  { query: "prepare this PDF agreement for signature", expect: "draft_signature_envelope" },
  { query: "send the agreement for signature", expect: "send_signature_envelope" },
  { query: "chase the signer for their signature", expect: "remind_signature_recipient" },
  { query: "withdraw this signature request", expect: "void_signature_envelope" },
  { query: "post in a channel", expect: "send_workspace_message" },
  { query: "message the team on slack", expect: "send_workspace_message" },
  { query: "hand this over to a colleague", expect: "create_handoff" },
  { query: "fill in a pdf form", expect: "fill_pdf_form" },
  { query: "read the word document they sent", expect: "read_docx" },
  { query: "open the docx", expect: "read_docx" },
  { query: "answer the questionnaire they emailed", expect: "edit_docx" },
  { query: "fill in the word document", expect: "edit_docx" },
  { query: "write a report as a word document", expect: "create_docx" },
  { query: "export this to word", expect: "create_docx" },
  { query: "build a kpi dashboard", expect: "create_dashboard" },
  {
    query: "configure typed CRM fields before migration",
    expect: "create_revenue_custom_field",
  },
  {
    query: "split legacy CRM rows into accounts contacts and deals",
    expect: "preview_linked_base_revenue_import",
  },
  { query: "merge duplicate company accounts", expect: "merge_revenue_accounts" },
  {
    query: "import historical deal owner and amount changes with effective timestamps",
    expect: "preview_historical_deal_import",
  },
  { query: "review deal time in stage history", expect: "list_deal_history" },
  {
    query: "preview merge duplicate contacts with conflict resolution",
    expect: "preview_revenue_record_merge",
  },
  { query: "merge this reviewed duplicate candidate", expect: "merge_revenue_records" },
  {
    query: "resolve an old merged partnership tombstone",
    expect: "resolve_revenue_record_redirect",
  },
  { query: "show per-record merge audit rows", expect: "get_revenue_operation" },
  { query: "undo a bulk revenue job", expect: "undo_revenue_operation" },
  {
    query: "preview archive selected partnerships",
    expect: "preview_revenue_bulk_operation",
  },
  {
    query: "queue an atomic asynchronous bulk follow-up completion",
    expect: "start_revenue_bulk_job",
  },
  { query: "check bulk job progress", expect: "get_revenue_bulk_job" },
  {
    query: "download failed bulk reconciliation",
    expect: "export_revenue_bulk_reconciliation",
  },
  {
    query: "find unassigned urgent overdue follow-ups for lost deals",
    expect: "list_follow_ups",
  },
  {
    query: "save this follow-up filter as a shared view",
    expect: "create_follow_up_view",
  },
  { query: "show CRM import summary counts", expect: "get_revenue_import" },
  { query: "find import row by source ID", expect: "list_revenue_import_rows" },
  {
    query: "download skipped import reconciliation",
    expect: "export_revenue_import_reconciliation",
  },
  { query: "export buying committees as CSV", expect: "export_revenue_snapshot" },
  {
    query: "propose canonical account domains from website redirects",
    expect: "propose_revenue_account_domains",
  },
  {
    query: "reconcile zero-value deals from Stripe subscriptions",
    expect: "propose_stripe_commercial_values",
  },
  {
    query: "review superseded field provenance",
    expect: "list_revenue_field_evidence",
  },
  { query: "find duplicate contacts by email", expect: "scan_revenue_duplicates" },
  {
    query: "backfill Gmail proposal attachments",
    expect: "scan_revenue_mail_documents",
  },
  {
    query: "review Gmail attachment candidates",
    expect: "list_revenue_document_candidates",
  },
  {
    query: "write CRM custom field with source confidence",
    expect: "set_revenue_custom_fields",
  },
  { query: "search the company CRM activity audit", expect: "list_activities" },
  { query: "build an outbound sequence and its steps", expect: "create_sequence" },
  { query: "view product signal firing history", expect: "list_signal_events" },
  { query: "launch a paid ad campaign", expect: "create_marketing_campaign" },
  { query: "compare ad creative variants", expect: "create_marketing_experiment" },
  { query: "record yesterday's ad spend", expect: "record_marketing_performance" },
  { query: "write a playbook", expect: "create_skill" },
  { query: "what git repos do i have", expect: "list_repositories" },
  // Nobody asks for a "work session" — they ask for the outcome. These are the
  // phrasings that stranded an employee before the tool existed: it could read
  // the repository, and had no way to start changing it.
  { query: "fix this bug in the code", expect: "start_repository_work_session" },
  { query: "send me a pull request", expect: "start_repository_work_session" },
  { query: "make a change to the repo", expect: "start_repository_work_session" },
  // Deliberately a deferred orientation tool: `list_employees` is resident, so
  // it is never a find_tools hit — asserting on it would test nothing.
  { query: "what departments are there", expect: "list_teams" },
  // Pipelines answer to the vocabulary of the thing being built, never to the
  // word "pipeline" — which in this product an operator is at least as likely
  // to mean about sales. These are the phrasings that returned nothing at all
  // before the family existed.
  { query: "set up a webhook receiver", expect: "create_pipeline" },
  { query: "automate this without an AI in the loop", expect: "create_pipeline" },
  { query: "what automations do we have", expect: "list_pipelines" },
  { query: "the step library for automations", expect: "list_pipeline_node_types" },
  { query: "did the webhook arrive", expect: "list_pipeline_runs" },
  { query: "why did the automation fail", expect: "get_pipeline_run" },
  { query: "our webhook url leaked", expect: "rotate_pipeline_webhook_token" },
];

describe("find_tools recall", () => {
  const tool = findTools();

  for (const { query, expect } of RECALL_CASES) {
    test(`"${query}" surfaces ${expect}`, async () => {
      const out = await tool.run({ query });
      assert.equal(out.isError, undefined, `find_tools errored for ${query}`);
      assert.ok(
        out.content.includes(`### ${expect}`),
        `"${query}" did not return ${expect} in its top matches.\n` +
          `Add a keyword to TOOL_KEYWORDS in toolIndex.ts.\n` +
          `Got:\n${out.content.slice(0, 900)}`,
      );
    });
  }

  test("a query that matches nothing still shows the whole catalogue", async () => {
    const out = await tool.run({ query: "zzzz nonsense qqqq" });
    assert.ok(out.content.includes("full catalogue"), "missing the domain footer");
    assert.ok(out.content.includes("finance:"), "footer lost the finance domain");
    assert.ok(out.content.includes("mail:"), "footer lost the mail domain");
  });

  test("the domain footer rides on every result, including hits", async () => {
    const out = await tool.run({ query: "record a payment" });
    assert.ok(out.content.includes("catalogue names"));
  });

  test("recurring invoice discovery includes the required template-line contract", async () => {
    const out = await tool.run({ query: "set up automatic annual invoice renewal" });
    assert.ok(out.content.includes("### create_recurring_invoice"));
    assert.ok(out.content.includes('"required"'));
    assert.ok(out.content.includes('"lines"'));
    assert.ok(out.content.includes('"unitPriceCents"'));
  });

  test("recurring invoice update discovery includes its required schedule slug", async () => {
    const out = await tool.run({ query: "pause recurring billing" });
    assert.ok(out.content.includes("### update_recurring_invoice"));
    assert.ok(out.content.includes('"required": [\n    "recurringInvoiceSlug"'));
  });

  test("a grant-dead tool is annotated, never hidden", async () => {
    const dead = new Set(["record_payment"]);
    const out = await findTools(dead).run({ query: "record a payment" });
    assert.ok(out.content.includes("### record_payment"), "grant-dead tool was filtered out");
    assert.ok(out.content.includes("no grant"), "grant-dead tool was not annotated");
  });

  test("domain filter narrows to that domain", async () => {
    const out = await tool.run({ domain: "mail" });
    assert.ok(out.content.includes("### search_mail"));
    assert.ok(!out.content.includes("### create_invoice"));
  });
});

describe("call_tool dispatch", () => {
  const searchable = deferredCatalogue();
  let ran: { name: string; args: Record<string, unknown> } | null = null;
  const target: AgentTool = {
    name: "send_invoice",
    description: "Send an invoice.",
    inputSchema: { type: "object" },
    run: async (args) => {
      ran = { name: "send_invoice", args };
      return { content: "sent" };
    },
  };
  const call = createCallTool({
    searchable,
    resolve: (name) => (name === "send_invoice" ? target : searchable.find((t) => t.name === name)),
    grantDead: new Set(),
  });

  test("parses args_json as a string", async () => {
    ran = null;
    const out = await call.run({ name: "send_invoice", args_json: '{"invoiceId":"inv_1"}' });
    assert.equal(out.content, "sent");
    assert.deepEqual(ran, { name: "send_invoice", args: { invoiceId: "inv_1" } });
  });

  test("tolerates a model that sends an object instead of a string", async () => {
    ran = null;
    await call.run({ name: "send_invoice", args_json: { invoiceId: "inv_2" } });
    assert.deepEqual(ran, { name: "send_invoice", args: { invoiceId: "inv_2" } });
  });

  test("tolerates the field being called args", async () => {
    ran = null;
    await call.run({ name: "send_invoice", args: '{"invoiceId":"inv_3"}' });
    assert.deepEqual(ran, { name: "send_invoice", args: { invoiceId: "inv_3" } });
  });

  test("an absent args_json means no arguments, not an error", async () => {
    ran = null;
    const out = await call.run({ name: "send_invoice" });
    assert.equal(out.isError, undefined);
    assert.deepEqual(ran, { name: "send_invoice", args: {} });
  });

  test("malformed JSON says so, and quotes the offending text", async () => {
    const out = await call.run({ name: "send_invoice", args_json: "{invoiceId: inv_1}" });
    assert.equal(out.isError, true);
    assert.match(out.content, /not valid JSON/);
    assert.match(out.content, /invoiceId/);
  });

  test("an unknown name suggests near misses instead of just failing", async () => {
    const out = await call.run({ name: "send_invoic", args_json: "{}" });
    assert.equal(out.isError, true);
    assert.match(out.content, /send_invoice/);
  });

  test("call_tool refuses to call itself", async () => {
    const selfCall = createCallTool({
      searchable,
      resolve: (name) => (name === "call_tool" ? selfCall : undefined),
      grantDead: new Set(),
    });
    const out = await selfCall.run({ name: "call_tool", args_json: "{}" });
    assert.equal(out.isError, true);
  });

  test("call_tool can dispatch find_tools (the meta-tools resolve too)", async () => {
    // Regression: the model, told everything runs through call_tool, will call
    // call_tool("find_tools"). If resolve() can't see the meta-tools, that
    // returns "unknown tool" for a tool sitting in its own visible list.
    const find = createFindToolsTool({
      searchable,
      resolve: () => undefined,
      grantDead: new Set(),
    });
    const withMeta = createCallTool({
      searchable,
      resolve: (name) => (name === "find_tools" ? find : undefined),
      grantDead: new Set(),
    });
    const out = await withMeta.run({ name: "find_tools", args_json: '{"query":"invoice"}' });
    assert.equal(out.isError, undefined, `call_tool(find_tools) failed: ${out.content}`);
    assert.ok(out.content.includes("catalogue"));
  });

  test("describeCall reports the real target, not call_tool", () => {
    const described = call.describeCall?.({
      name: "send_invoice",
      args_json: '{"invoiceId":"inv_9"}',
    });
    assert.deepEqual(described, { name: "send_invoice", input: { invoiceId: "inv_9" } });
  });
});

describe("catalogue integrity", () => {
  test("every manifest tool is reachable — resident, deferred, or a family op", async () => {
    const { collapsed, passthrough } = collapseStaticTools();
    const reachable = new Set<string>();
    for (const t of passthrough) reachable.add(t.name);
    for (const c of collapsed) for (const target of Object.values(c.ops)) reachable.add(target);

    const missing = STATIC_TOOLS.map((t) => t.name).filter((n) => !reachable.has(n));
    assert.deepEqual(missing, [], "these manifest tools fell out of the agent's reach");
  });
});
