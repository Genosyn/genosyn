import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { sendViaProvider, type EmailMessage, type EmailProviderConfig } from "./emailTransports.js";

/**
 * How a To or Cc list reaches the REST providers.
 *
 * Both adapters below used to split the list on every comma, so one recipient
 * named `"Doe, Zoë" <doe@example.com>` went out as two broken ones. SendGrid
 * takes bare addresses in `{ email }` objects and refuses an address named
 * twice; Resend takes one string per recipient and reads `Name <address>`
 * itself. `fetch` is stubbed, so each case reads the body the provider would
 * have received.
 */

const realFetch = globalThis.fetch;
let bodies: Record<string, unknown>[] = [];

beforeEach(() => {
  bodies = [];
  globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ id: "message-1" }), { status: 200 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const SENDGRID: EmailProviderConfig = { kind: "sendgrid", config: { apiKey: "SG.test" } };
const RESEND: EmailProviderConfig = { kind: "resend", config: { apiKey: "re_test" } };

function message(over: Partial<EmailMessage>): EmailMessage {
  return {
    to: "ada@example.com",
    subject: "Invoice INV-0001",
    text: "The invoice is attached.",
    fromAddress: "Acme <billing@acme.example.com>",
    ...over,
  };
}

/** The one request body the send made. */
function sentBody(): Record<string, unknown> {
  assert.equal(bodies.length, 1, "expected exactly one provider request");
  return bodies[0];
}

function sendGridPersonalization(): Record<string, unknown> {
  const personalizations = sentBody().personalizations as Record<string, unknown>[];
  assert.equal(personalizations.length, 1);
  return personalizations[0];
}

describe("SendGrid recipients", () => {
  test("a quoted name holding a comma or an escaped quote is one recipient", async () => {
    await sendViaProvider(
      SENDGRID,
      message({
        to: '"Doe, Zoë" <doe@example.com>, Bob <bob@example.com>',
        cc: '"Åsa \\"Q, Jr" <q@example.com>, plain@example.com',
      }),
    );
    assert.deepEqual(sendGridPersonalization(), {
      to: [{ email: "doe@example.com" }, { email: "bob@example.com" }],
      cc: [{ email: "q@example.com" }, { email: "plain@example.com" }],
    });
  });

  test("names each address once, since SendGrid refuses a repeat", async () => {
    await sendViaProvider(
      SENDGRID,
      message({
        to: "Ada <ADA@example.com>, ada@example.com, bob@example.com",
        cc: "ada@example.com, Bob <Bob@Example.com>",
      }),
    );
    // Everyone in Cc is already in To, so the personalization carries no Cc.
    assert.deepEqual(sendGridPersonalization(), {
      to: [{ email: "ada@example.com" }, { email: "bob@example.com" }],
    });
  });

  test("an entry that is not an address fails the send instead of being left out", async () => {
    await assert.rejects(
      () => sendViaProvider(SENDGRID, message({ to: "ada@example.com, not-an-address" })),
      { message: "To contains an invalid email address: not-an-address" },
    );
    await assert.rejects(
      () => sendViaProvider(SENDGRID, message({ cc: '"Doe, Zoë", bob@example.com' })),
      { message: 'Cc contains an invalid email address: "Doe, Zoë"' },
    );
    // The unclosed quote swallows the comma. This used to go to doe alone.
    await assert.rejects(
      () => sendViaProvider(SENDGRID, message({ to: '"Doe <doe@example.com>, bob@example.com' })),
      { message: 'To contains an invalid email address: "Doe <doe@example.com>, bob@example.com' },
    );
    assert.equal(bodies.length, 0, "nothing should reach SendGrid");
  });
});

describe("Resend recipients", () => {
  test("one string per recipient, each as written", async () => {
    await sendViaProvider(
      RESEND,
      message({
        to: '"Doe, Zoë" <doe@example.com>, Bob <bob@example.com>',
        cc: '"Åsa \\"Q, Jr" <q@example.com>, plain@example.com',
      }),
    );
    const body = sentBody();
    assert.deepEqual(body.to, ['"Doe, Zoë" <doe@example.com>', "Bob <bob@example.com>"]);
    assert.deepEqual(body.cc, ['"Åsa \\"Q, Jr" <q@example.com>', "plain@example.com"]);
  });
});
