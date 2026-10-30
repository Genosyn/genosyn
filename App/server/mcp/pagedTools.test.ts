import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { BANKING_PAGE, bankingFilterShape } from "../services/bankingQueue.js";
import { BILL_PAGE, CUSTOMER_PAGE, INVOICE_PAGE, RECURRING_INVOICE_PAGE } from "../services/financeListPages.js";
import { pageBodyShape } from "../services/listPaging.js";
import { DATA_ROOM_QUESTION_PAGE } from "../services/dataRooms/aiViews.js";
import { MEETING_PAGE } from "../services/meetings/store.js";
import { NOTE_PAGE, NOTE_SEARCH_PAGE } from "../services/noteLists.js";
import { PIPELINE_RUN_PAGE, pipelineRunFilterShape } from "../services/pipelines/runHistory.js";
import { WORK_REVIEW_PAGE } from "../services/proactive/approvals.js";
import { APPLICATION_PAGE } from "../services/recruiting/applications.js";
import { OPENING_PAGE } from "../services/recruiting/openings.js";
import { CALL_PAGE } from "../services/phone/calls.js";
import { TEXT_PAGE } from "../services/phone/texts.js";
import { CONTACT_PAGE, CONTACT_SEARCH_PAGE } from "../services/revenue/contacts.js";
import { SIGNATURE_ENVELOPE_PAGE } from "../services/signing.js";
import { LEDGER_REVIEW_PAGE, ledgerReviewFilterShape } from "../services/transactionReviews.js";
import { CHANNEL_MESSAGE_PAGE } from "../services/workspaceChat.js";
import { STATIC_TOOLS } from "./toolManifest.js";

/**
 * The paging contract as the model reads it. Every paged list tool advertises
 * `limit` (with the same maximum the server cuts to) and `cursor`, says in its
 * description how to read on, and never advertises an argument its endpoint
 * refuses — or hides one it takes.
 */

const PAGED: Record<string, { max: number; default: number }> = {
  list_banking_transactions: { max: BANKING_PAGE.maxLimit, default: BANKING_PAGE.defaultLimit },
  list_finance_transactions: { max: LEDGER_REVIEW_PAGE.maxLimit, default: LEDGER_REVIEW_PAGE.defaultLimit },
  list_invoices: { max: INVOICE_PAGE.maxLimit, default: INVOICE_PAGE.defaultLimit },
  list_bills: { max: BILL_PAGE.maxLimit, default: BILL_PAGE.defaultLimit },
  list_recurring_invoices: {
    max: RECURRING_INVOICE_PAGE.maxLimit,
    default: RECURRING_INVOICE_PAGE.defaultLimit,
  },
  list_customers: { max: CUSTOMER_PAGE.maxLimit, default: CUSTOMER_PAGE.defaultLimit },
  list_meetings: { max: MEETING_PAGE.maxLimit, default: MEETING_PAGE.defaultLimit },
  search_mail: { max: 50, default: 20 },
  list_runs: { max: 50, default: 20 },
  list_handoffs: { max: 200, default: 50 },
  list_todos: { max: 200, default: 50 },
  list_contacts: { max: CONTACT_PAGE.maxLimit, default: CONTACT_PAGE.defaultLimit },
  search_contacts: {
    max: CONTACT_SEARCH_PAGE.maxLimit,
    default: CONTACT_SEARCH_PAGE.defaultLimit,
  },
  list_text_messages: { max: TEXT_PAGE.maxLimit, default: TEXT_PAGE.defaultLimit },
  list_phone_calls: { max: CALL_PAGE.maxLimit, default: CALL_PAGE.defaultLimit },
  list_workspace_messages: {
    max: CHANNEL_MESSAGE_PAGE.maxLimit,
    default: CHANNEL_MESSAGE_PAGE.defaultLimit,
  },
  list_data_room_questions: {
    max: DATA_ROOM_QUESTION_PAGE.maxLimit,
    default: DATA_ROOM_QUESTION_PAGE.defaultLimit,
  },
  list_signature_envelopes: {
    max: SIGNATURE_ENVELOPE_PAGE.maxLimit,
    default: SIGNATURE_ENVELOPE_PAGE.defaultLimit,
  },
  list_notes: { max: NOTE_PAGE.maxLimit, default: NOTE_PAGE.defaultLimit },
  search_notes: { max: NOTE_SEARCH_PAGE.maxLimit, default: NOTE_SEARCH_PAGE.defaultLimit },
  list_work_reviews: { max: WORK_REVIEW_PAGE.maxLimit, default: WORK_REVIEW_PAGE.defaultLimit },
  list_pipeline_runs: { max: PIPELINE_RUN_PAGE.maxLimit, default: PIPELINE_RUN_PAGE.defaultLimit },
  list_openings: { max: OPENING_PAGE.maxLimit, default: OPENING_PAGE.defaultLimit },
  list_applications: { max: APPLICATION_PAGE.maxLimit, default: APPLICATION_PAGE.defaultLimit },
};

function tool(name: string) {
  const found = STATIC_TOOLS.find((entry) => entry.name === name);
  assert.ok(found, `${name} is in the manifest`);
  return found;
}

describe("paged list tools", () => {
  for (const [name, limits] of Object.entries(PAGED)) {
    test(`${name} advertises limit and cursor, and how to read on`, () => {
      const spec = tool(name);
      const properties = spec.inputSchema.properties as Record<
        string,
        { type?: string; minimum?: number; maximum?: number; description?: string }
      >;
      assert.equal(properties.limit?.type, "integer");
      assert.equal(properties.limit?.minimum, 1);
      assert.equal(properties.limit?.maximum, limits.max, "the maximum the server cuts to");
      assert.match(properties.limit?.description ?? "", new RegExp(`default ${limits.default}`));
      assert.equal(properties.cursor?.type, "string");
      assert.match(properties.cursor?.description ?? "", /nextCursor/);
      assert.match(spec.description, /nextCursor/);
      assert.match(spec.description, /hasMore/);
      assert.equal(spec.inputSchema.additionalProperties, false);
      assert.equal("offset" in properties, false, "one way to page: the cursor");
    });
  }

  test("the Banking and Entry review tools advertise exactly the filters their endpoints take", () => {
    for (const [name, shape] of [
      ["list_banking_transactions", { ...bankingFilterShape, ...pageBodyShape }],
      ["list_finance_transactions", { ...ledgerReviewFilterShape, ...pageBodyShape }],
    ] as const) {
      assert.deepEqual(
        Object.keys(tool(name).inputSchema.properties).sort(),
        Object.keys(shape).sort(),
        name,
      );
    }
  });

  test("read-only list tools stay read-only", () => {
    for (const name of [
      "list_banking_transactions",
      "list_bills",
      "list_work_reviews",
      "list_openings",
      "list_applications",
    ]) {
      assert.equal(tool(name).readOnly, true, name);
    }
  });

  test("knowledge and Recruiting lists advertise exactly the filters their endpoints take", () => {
    const paging = Object.keys(pageBodyShape);
    for (const [name, filters] of [
      ["list_notes", ["notebookSlug", "parentSlug", "includeArchived"]],
      ["search_notes", ["query", "notebookSlug"]],
      ["list_work_reviews", ["status"]],
      ["list_pipeline_runs", ["pipelineId", ...Object.keys(pipelineRunFilterShape)]],
      ["list_openings", ["status", "query"]],
      // `offset` is still read for an older Skill's first page, but never offered.
      ["list_applications", ["openingId", "stage", "query", "sort", "minScore", "screenStatus"]],
    ] as const) {
      assert.deepEqual(
        Object.keys(tool(name).inputSchema.properties).sort(),
        [...filters, ...paging].sort(),
        name,
      );
    }
  });

  test("a mailbox search says why it has no total", () => {
    assert.match(tool("search_mail").description, /no total/i);
  });

  test("the activity export continues by cursor, one part at a time", () => {
    const spec = tool("export_activities");
    const properties = spec.inputSchema.properties as Record<
      string,
      { type?: string; description?: string }
    >;
    assert.equal(properties.cursor?.type, "string");
    assert.match(properties.cursor?.description ?? "", /nextCursor/);
    assert.match(spec.description, /nextCursor/);
    assert.match(spec.description, /hasMore/);
    assert.match(spec.description, /10,000/);
    assert.equal("offset" in properties, false);
    assert.equal("limit" in properties, false, "a part's size is the server's to bound");
  });

  test("Revenue lists say how to reach what a filter would otherwise hide", () => {
    const partnerships = tool("list_partnerships");
    assert.ok("includeArchived" in partnerships.inputSchema.properties);
    assert.match(partnerships.description, /includeArchived/);
    const followUps = tool("list_follow_ups");
    const undated = (followUps.inputSchema.properties as Record<string, { enum?: string[] }>)
      .undated;
    assert.deepEqual(undated?.enum, ["include", "only", "exclude"]);
    assert.match(followUps.description, /no due date|nobody gave a due date/);
  });
});
