import assert from "node:assert/strict";
import { describe, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom";

import { ActivityTimeline, type RevenueActivity } from "../components/revenue/ActivityTimeline.js";
import { DialogProvider } from "../components/ui/Dialog.js";
import type { Company, Employee, Member } from "../lib/api.js";
import type { Meeting, MeetingCustomer } from "../lib/meetings.js";
import { CustomerNotesPanel } from "./CustomerNotesPanel.js";
import { MeetingCustomerCard } from "./MeetingDetail.js";

/**
 * What a meeting's page says about its customer, and what a customer's page
 * says about its meetings and notes, drawn from data. A link grants nothing, so
 * a Member without Finance access is told a customer exists and not which, and
 * isn't offered a picker that could only answer 403.
 */

const h = React.createElement;

const consoleError = console.error.bind(console);
mock.method(console, "error", (...args: unknown[]) => {
  if (String(args[0]).includes("useLayoutEffect does nothing on the server")) return;
  consoleError(...args);
});

const company = (financeAccess: Company["financeAccess"]) =>
  ({
    id: "company",
    slug: "qa",
    name: "QA",
    mission: "",
    vision: "",
    role: "member",
    financeAccess,
    requireTwoFactor: false,
  }) satisfies Company;

const acme: MeetingCustomer = {
  id: "cus_1",
  name: "Acme Corp",
  slug: "acme-corp",
  domain: "acme-corp.test",
  accountStatus: "prospect",
  archived: false,
};

const meeting = (over: Partial<Meeting> = {}) =>
  ({ id: "m1", customerChosen: false, ...over }) as Meeting;

function card(
  access: Company["financeAccess"],
  props: { meeting?: Meeting; customer?: MeetingCustomer | null; withheld?: boolean } = {},
): string {
  return renderToStaticMarkup(
    h(
      StaticRouter,
      { location: "/c/qa/meetings/m1" },
      h(MeetingCustomerCard, {
        company: company(access),
        meeting: props.meeting ?? meeting(),
        customer: props.customer ?? null,
        withheld: props.withheld ?? false,
        onChanged: () => undefined,
      }),
    ),
  );
}

describe("the meeting's Customer card", () => {
  test("links to the customer, and says how it got there", () => {
    const html = card("read", { customer: acme });
    assert.match(html, /href="\/c\/qa\/customers\/acme-corp"/);
    assert.match(html, /Acme Corp/);
    assert.match(html, /Prospect/);
    assert.match(html, /acme-corp\.test/);
    assert.match(html, /Linked from the attendees/);
    assert.match(html, /Change/);
  });

  test("says when a Member chose it", () => {
    const html = card("full", { customer: acme, meeting: meeting({ customerChosen: true }) });
    assert.match(html, /Chosen by a Member/);
  });

  test("marks an archived customer", () => {
    assert.match(card("read", { customer: { ...acme, archived: true } }), /Archived/);
  });

  test("with no customer, offers to link one and says what would link it", () => {
    const html = card("read");
    assert.match(html, />Link</);
    assert.match(html, /Add them as attendees/);
  });

  test("says why a removed link stays removed", () => {
    const html = card("read", { meeting: meeting({ customerChosen: true }) });
    assert.match(html, /removed the link/);
  });

  test("without Finance access: no name, no way to the customer, no picker", () => {
    const html = card("none", { withheld: true });
    assert.match(html, /linked to a customer/);
    assert.match(html, /finance access/);
    assert.doesNotMatch(html, /\/customers\//);
    assert.doesNotMatch(html, /Change|>Link</);
  });

  test("without Finance access and no customer, still no picker", () => {
    assert.doesNotMatch(card("none"), /Change|>Link</);
  });
});

const baseActivity = {
  companyId: "company",
  contactId: null,
  dealId: null,
  customerId: "cus_1",
  mailThreadId: null,
  mailMessageId: null,
  meetingId: null,
  actorUserId: null,
  actorEmployeeId: null,
  metaJson: null,
  occurredAt: "2026-08-01T10:00:00.000Z",
  createdAt: "2026-08-01T10:00:00.000Z",
} satisfies Partial<RevenueActivity>;

const note = (over: Partial<RevenueActivity>): RevenueActivity => ({
  ...baseActivity,
  id: "a1",
  kind: "note",
  subject: "",
  bodyText: "Wants a security review.",
  ...over,
});

function timeline(activity: RevenueActivity): string {
  return renderToStaticMarkup(
    h(
      StaticRouter,
      { location: "/c/qa/customers/acme-corp" },
      h(ActivityTimeline, { activities: [activity], companySlug: "qa" }),
    ),
  );
}

describe("the customer's timeline", () => {
  test("a meeting's row goes to the meeting", () => {
    const html = timeline(note({ kind: "meeting", subject: "Review", meetingId: "m1" }));
    assert.match(html, /href="\/c\/qa\/meetings\/m1"/);
    assert.match(html, /Open meeting/);
  });

  test("any other row has no such link", () => {
    assert.doesNotMatch(timeline(note({})), /Open meeting/);
  });

  test("a note with no subject doesn't say Note twice", () => {
    assert.equal(timeline(note({})).match(/>Note</g)?.length, 1);
  });
});

function notes(props: {
  rows: RevenueActivity[];
  total?: number;
  preview?: number;
  members?: Member[];
  employees?: Employee[];
}): string {
  return renderToStaticMarkup(
    h(
      StaticRouter,
      { location: "/c/qa/customers/acme-corp" },
      h(
        DialogProvider,
        null,
        h(CustomerNotesPanel, {
          companyId: "company",
          customerId: "cus_1",
          notes: props.rows,
          total: props.total ?? props.rows.length,
          members: props.members ?? [],
          employees: props.employees ?? [],
          contactLinks: { c1: { title: "Sam Doe", to: "/c/qa/revenue/contacts/c1" } },
          dealLinks: { d1: { title: "Big deal", to: "/c/qa/revenue/deals/d1" } },
          preview: props.preview,
          onChanged: async () => undefined,
        }),
      ),
    ),
  );
}

describe("the customer's notes", () => {
  test("always offers a place to write one, and says when there are none", () => {
    const html = notes({ rows: [] });
    assert.match(html, /Add note/);
    assert.match(html, /aria-label="New note"/);
    assert.match(html, /No notes yet/);
  });

  test("shows who wrote each note, with a way to edit or delete it", () => {
    const html = notes({
      rows: [note({ actorUserId: "u1" })],
      members: [
        { userId: "u1", role: "member", financeAccess: "read", email: "a@b.test", name: "Ana" },
      ],
    });
    assert.match(html, /Ana/);
    assert.match(html, /Wants a security review\./);
    assert.match(html, /aria-label="Edit note"/);
    assert.match(html, /aria-label="Delete note"/);
  });

  test("marks one an AI Employee wrote, and keeps its title", () => {
    const html = notes({
      rows: [note({ actorEmployeeId: "e1", subject: "Notes from #acme on Slack" })],
      employees: [{ id: "e1", name: "Scout" } as Employee],
    });
    assert.match(html, /Scout/);
    assert.match(html, /AI Employee/);
    assert.match(html, /Notes from #acme on Slack/);
  });

  test("links a note kept on the account's Deal or Contact to where it lives", () => {
    const html = notes({ rows: [note({ dealId: "d1" }), note({ id: "a2", contactId: "c1" })] });
    assert.match(html, /href="\/c\/qa\/revenue\/deals\/d1"/);
    assert.match(html, /href="\/c\/qa\/revenue\/contacts\/c1"/);
  });

  test("the overview shows the newest few and says there are more", () => {
    const rows = ["a1", "a2", "a3", "a4"].map((id) => note({ id, bodyText: `Note ${id}` }));
    const html = notes({ rows, total: 9, preview: 3 });
    assert.match(html, /Note a3/);
    assert.doesNotMatch(html, /Note a4/);
    assert.match(html, /Showing the 3 newest of 9 notes/);
  });
});
