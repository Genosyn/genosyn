import assert from "node:assert/strict";
import { describe, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom";

import { mailtoHref } from "../mail/ComposeEmailModal.js";
import {
  AttendeeList,
  EmailAttendeesButton,
  RsvpSummary,
  type AttendeePerson,
} from "./Attendees.js";

/**
 * The attendee list as people see it: every address, every reply, a link to
 * each Contact, and an Email button that knows when there is nobody to write to.
 */

const h = React.createElement;

const consoleError = console.error.bind(console);
mock.method(console, "error", (...args: unknown[]) => {
  if (String(args[0]).includes("useLayoutEffect does nothing on the server")) return;
  consoleError(...args);
});

const render = (node: React.ReactElement) =>
  renderToStaticMarkup(h(StaticRouter, { location: "/c/acme/meetings" }, node));

const people: AttendeePerson[] = [
  {
    email: "boss@ourco.test",
    name: "The Boss",
    responseStatus: "accepted",
    organizer: true,
    contactId: null,
  },
  {
    email: "sam@acme.test",
    name: "Sam Rivera",
    responseStatus: "declined",
    organizer: false,
    contactId: "contact-1",
  },
  {
    email: "lee@acme.test",
    name: "lee@acme.test",
    responseStatus: "needsAction",
    organizer: false,
    optional: true,
    contactId: null,
    note: "Not a Contact",
  },
  {
    email: "kim@acme.test",
    name: "Kim",
    responseStatus: "tentative",
    organizer: false,
    contactId: null,
  },
];

describe("the attendee list", () => {
  test("shows every address and every reply", () => {
    const html = render(h(AttendeeList, { people, companySlug: "acme", onEmail: () => {} }));

    for (const address of ["boss@ourco.test", "sam@acme.test", "lee@acme.test", "kim@acme.test"]) {
      assert.ok(html.includes(address), `${address} is listed`);
    }
    for (const reply of ["Accepted", "Declined", "Awaiting reply", "Maybe"]) {
      assert.ok(html.includes(reply), `${reply} is shown`);
    }
    assert.ok(html.includes("Organizer"));
    assert.ok(html.includes("Optional"));
    assert.ok(html.includes("lee@acme.test · Not a Contact") === false);
    assert.ok(html.includes("Not a Contact"));
  });

  test("links an attendee who is a Contact to their page", () => {
    const html = render(h(AttendeeList, { people, companySlug: "acme", onEmail: () => {} }));

    assert.ok(html.includes('href="/c/acme/revenue/contacts/contact-1"'));
    assert.equal(html.match(/revenue\/contacts\//g)?.length, 1);
  });

  test("offers a button to email each attendee and copy their address", () => {
    const html = render(h(AttendeeList, { people, companySlug: "acme", onEmail: () => {} }));

    assert.ok(html.includes('aria-label="Email Sam Rivera"'));
    assert.ok(html.includes('aria-label="Copy sam@acme.test"'));
  });

  test("filters by reply once the list is long enough to need it", () => {
    const html = render(h(AttendeeList, { people, companySlug: "acme", onEmail: () => {} }));
    assert.ok(html.includes('aria-label="Show attendees by reply"'));

    const short = render(
      h(AttendeeList, { people: people.slice(0, 2), companySlug: "acme", onEmail: () => {} }),
    );
    assert.ok(!short.includes('aria-label="Show attendees by reply"'));
  });

  test("says so when nobody else is invited", () => {
    const html = render(
      h(AttendeeList, {
        people: [],
        companySlug: "acme",
        onEmail: () => {},
        emptyText: "Just you.",
      }),
    );
    assert.ok(html.includes("Just you."));
  });
});

describe("the reply summary", () => {
  test("counts each reply, coming first", () => {
    const html = render(h(RsvpSummary, { people }));
    const text = html.replace(/<[^>]+>/g, "");
    assert.ok(text.indexOf("1 accepted") < text.indexOf("1 declined"));
    assert.ok(text.includes("1 maybe"));
    assert.ok(text.includes("1 awaiting reply"));
  });
});

describe("Email attendees", () => {
  test("is off when the only person on the invite is you", () => {
    const html = render(
      h(EmailAttendeesButton, {
        people: people.slice(0, 1),
        exclude: ["boss@ourco.test"],
        onCompose: () => {},
      }),
    );
    assert.match(html, /<button[^>]*disabled=""[^>]*>.*Email attendees/);
  });

  test("is on when there is someone to write to", () => {
    const html = render(h(EmailAttendeesButton, { people, exclude: [], onCompose: () => {} }));
    assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>.*Email attendees/);
  });
});

describe("handing a message to the person's own mail app", () => {
  test("keeps every recipient, the subject and the body", () => {
    const href = mailtoHref({
      to: "sam@acme.test, lee@acme.test",
      cc: "kim@acme.test",
      subject: "Quarterly review",
      bodyText: "Hi all,\n\nSee you there",
    });

    assert.equal(
      href,
      "mailto:sam@acme.test,lee@acme.test?cc=kim%40acme.test&subject=Quarterly%20review&body=Hi%20all%2C%0A%0ASee%20you%20there",
    );
  });
});
