import assert from "node:assert/strict";
import { describe, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom";

import type { BoardLetterSummary, Company } from "../../lib/api.js";
import { BoardLetterCard, showsBoardLetter } from "./BoardLetterCard.js";

/**
 * The letter to the board on Home: its number and month, its summary, the
 * status, audit and trace badges the Letters pages use, and a way to the
 * letter. The server sends a letter only to owners and admins; the card holds
 * the same line, so a Member is never offered one.
 */

const owner = {
  id: "company",
  slug: "acme",
  name: "Acme",
  mission: "",
  vision: "",
  role: "owner",
  financeAccess: "full",
  requireTwoFactor: false,
} satisfies Company;
const admin = { ...owner, role: "admin" } satisfies Company;
const member = { ...owner, role: "member" } satisfies Company;

function letter(overrides: Partial<BoardLetterSummary> = {}): BoardLetterSummary {
  return {
    id: "letter-3",
    number: 3,
    month: "2026-09",
    monthLabel: "September 2026",
    status: "ready",
    auditStatus: "clean",
    summary: "September grew 41% and the Goal moved to 6,200 roofs.",
    untracedCount: 0,
    findingsCount: 0,
    writer: { id: "ada", name: "Ada", role: "Chief executive", slug: "ada", avatarKey: null },
    auditor: { id: "otto", name: "Otto", role: "Auditor", slug: "otto", avatarKey: null },
    triggerKind: "schedule",
    attempts: 1,
    retryAt: null,
    errorMessage: "",
    createdAt: "2026-10-01T06:00:00.000Z",
    writtenAt: "2026-10-01T06:01:00.000Z",
    auditedAt: "2026-10-01T06:02:00.000Z",
    deliveredAt: "2026-10-01T06:02:00.000Z",
    ...overrides,
  };
}

function render(
  shown: BoardLetterSummary | null,
  { company = owner as Company, unreadCount = 1 } = {},
): string {
  return renderToStaticMarkup(
    React.createElement(
      StaticRouter,
      { location: "/c/acme" },
      React.createElement(BoardLetterCard, {
        company,
        letter: shown,
        unreadCount,
        onDismiss: () => undefined,
      }),
    ),
  )
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
}

function text(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

describe("the letter to the board on Home", () => {
  test("shows its number and month, its summary, its badges, and the way to it", () => {
    const html = render(letter());
    const visible = text(html);
    assert.match(visible, /Letter to the board 1 All letters/);
    assert.match(visible, /No\. 3 September 2026/);
    assert.match(visible, /September grew 41% and the Goal moved to 6,200 roofs\./);
    assert.match(visible, /Audited · no exceptions/);
    assert.match(visible, /Every number traced/);
    assert.match(visible, /Ada · audited by Otto/);
    assert.ok(html.includes('href="/c/acme/tldrs/letters/3"'), "links to the letter");
    assert.ok(html.includes('href="/c/acme/tldrs/letters"'), "links to every letter");
    assert.match(visible, /Read the letter/);
    assert.ok(html.includes('aria-label="Dismiss Letter No. 3"'));
    assert.doesNotMatch(visible, /more unread/);
  });

  test("carries the auditor's exceptions and the numbers the trace could not match", () => {
    const visible = text(
      render(letter({ auditStatus: "exceptions", findingsCount: 2, untracedCount: 1 })),
    );
    assert.match(visible, /Audited · 2 exceptions/);
    assert.match(visible, /1 number untraced/);
    assert.match(visible, /Ada · audited by Otto/);
  });

  test("never reads a letter nobody audited as audited", () => {
    for (const [auditStatus, auditor, badge] of [
      ["unverified", letter().auditor, "Not audited"],
      ["not_appointed", null, "No auditor appointed"],
    ] as const) {
      const visible = text(render(letter({ auditStatus, auditor })));
      assert.match(visible, new RegExp(badge), auditStatus);
      assert.doesNotMatch(visible, /Audited ·|audited by/, auditStatus);
    }
  });

  test("shows a letter the auditor is reading again as it stands now", () => {
    const html = render(letter({ status: "auditing", auditStatus: "pending" }));
    assert.match(text(html), /With the auditor/);
    assert.match(html, /\banimate-spin\b/);
    assert.doesNotMatch(text(html), /audited by/);
  });

  test("says how many more wait, in the plural only when there are several", () => {
    assert.match(text(render(letter(), { unreadCount: 2 })), /1 more unread letter$/);
    assert.match(text(render(letter(), { unreadCount: 4 })), /3 more unread letters$/);
  });

  test("still reads when a letter has no summary or its writer was deleted", () => {
    const visible = text(
      render(letter({ summary: "", writer: { ...letter().writer, id: null, name: "" } })),
    );
    assert.match(visible, /The letter for September 2026 is ready to read\./);
    assert.match(visible, /A former AI Employee · audited by Otto/);
  });

  test("is shown to owners and admins, and never to a Member", () => {
    assert.ok(render(letter(), { company: admin }).includes("Letter to the board"));
    assert.equal(render(letter(), { company: member }), "");
    assert.equal(render(null), "");
    assert.equal(showsBoardLetter(owner, letter()), true);
    assert.equal(showsBoardLetter(admin, letter()), true);
    assert.equal(showsBoardLetter(member, letter()), false);
    assert.equal(showsBoardLetter(owner, null), false);
    // A payload from before letters reached Home has no field at all.
    assert.equal(showsBoardLetter(owner, undefined), false);
  });
});
