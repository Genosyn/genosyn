import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import {
  buildWhatsAppTemplateMessage,
  isWhatsAppAuthFailure,
  normalizeWhatsAppRecipient,
  whatsappErrorMessage,
  whatsappProvider,
  WHATSAPP_GRAPH_VERSION,
} from "./whatsapp.js";
import { ConnectionAuthError } from "../types.js";
import type { IntegrationRuntimeContext } from "../types.js";

/**
 * WhatsApp is the one surface where the platform silently changes what an AI
 * Employee is allowed to say. Inside 24 hours of someone's last message, free
 * text; outside it, approved templates only. An employee that has not been
 * told promises the update and then cannot send it, so the rule is asserted
 * here as copy that must exist, not merely as behaviour.
 */

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const TOKEN = "EAAGtestingtoken0001";

function config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    phoneNumberId: "123456789012345",
    accessToken: TOKEN,
    verifyToken: "verify-me",
    appSecret: "app-secret",
    ...overrides,
  };
}

function runtime(overrides: Record<string, unknown> = {}): IntegrationRuntimeContext {
  return {
    authMode: "apikey",
    config: config(overrides),
    connectionId: "connection-1",
    companyId: "company-1",
    employeeId: "employee-1",
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type Captured = { url: URL; init: RequestInit | undefined; body: unknown };

function captureFetch(response: () => Response): Captured[] {
  const calls: Captured[] = [];
  globalThis.fetch = (async (input, init) => {
    const raw = typeof init?.body === "string" ? init.body : null;
    calls.push({
      url: new URL(String(input)),
      init,
      body: raw ? JSON.parse(raw) : undefined,
    });
    return response();
  }) as typeof fetch;
  return calls;
}

function tool(name: string) {
  const found = whatsappProvider.tools.find((t) => t.name === name);
  assert.ok(found, `${name} must exist`);
  return found;
}

describe("catalog", () => {
  test("is a Communication integration on an API key", () => {
    assert.equal(whatsappProvider.catalog.provider, "whatsapp");
    assert.equal(whatsappProvider.catalog.name, "WhatsApp");
    assert.equal(whatsappProvider.catalog.category, "Communication");
    assert.equal(whatsappProvider.catalog.authMode, "apikey");
    assert.equal(whatsappProvider.catalog.icon, "MessageCircle");
    assert.equal(whatsappProvider.catalog.enabled, true);
  });

  test("collects all four halves of the Meta credential", () => {
    const fields = whatsappProvider.catalog.fields ?? [];
    assert.deepEqual(
      fields.map((f) => f.key),
      ["phoneNumberId", "accessToken", "verifyToken", "appSecret"],
    );
    assert.ok(fields.every((f) => f.required));
    // Three of the four are secrets; the phone number id is not, and masking
    // it would only stop an operator checking they pasted the right one.
    assert.deepEqual(
      fields.map((f) => f.type),
      ["text", "password", "password", "password"],
    );
  });

  test("each hint names the screen the value is on", () => {
    const hints = Object.fromEntries(
      (whatsappProvider.catalog.fields ?? []).map((f) => [f.key, f.hint ?? ""]),
    );
    assert.match(hints.phoneNumberId, /API Setup/);
    assert.match(hints.accessToken, /System User token/);
    assert.match(hints.accessToken, /not the 24-hour test token/);
    assert.match(hints.verifyToken, /webhook configuration/);
    assert.match(hints.appSecret, /App Secret/);
    assert.match(hints.appSecret, /verify every delivery/);
  });

  test("the catalog copy warns about the 24-hour rule before anyone connects", () => {
    const copy = `${whatsappProvider.catalog.tagline} ${whatsappProvider.catalog.description ?? ""}`;
    assert.match(copy, /24 hours/);
    assert.match(copy, /template/i);
    assert.match(copy, /approved/i);
    // Inbound is webhook-only, so an instance with no public URL is a dead
    // end and the card has to say so.
    assert.match(copy, /HTTPS URL/);
  });

  test("the copy says AI Employee, never bot or assistant", () => {
    const copy = `${whatsappProvider.catalog.tagline} ${whatsappProvider.catalog.description ?? ""}`;
    assert.match(copy, /AI Employee/);
    assert.doesNotMatch(copy, /\bbot\b/i);
    assert.doesNotMatch(copy, /\bassistant\b/i);
    assert.doesNotMatch(copy, /\bagent\b/i);
  });
});

describe("the 24-hour rule in tool descriptions", () => {
  test("send_message says its window closes and names the way out", () => {
    const description = tool("send_message").description;
    assert.match(description, /24-hour window/);
    assert.match(description, /free-form text/);
    assert.match(description, /131047/);
    assert.match(description, /send_template/);
    // The failure mode this sentence exists to prevent.
    assert.match(description, /never promise a proactive update/i);
  });

  test("send_template explains that it is the only way out, and cannot be authored here", () => {
    const description = tool("send_template").description;
    assert.match(description, /24 hours/);
    assert.match(description, /only thing WhatsApp accepts outside/i);
    assert.match(description, /WhatsApp Manager/);
    assert.match(description, /review/);
    assert.match(description, /say so rather than promising/i);
  });

  test("send_template requires everything Meta needs to match a template", () => {
    const schema = tool("send_template").inputSchema;
    assert.deepEqual(schema.required, ["to", "templateName", "languageCode"]);
    assert.equal(schema.additionalProperties, false);
    // A template with no placeholders must be sent with no parameters, so
    // this one is deliberately optional.
    assert.ok(schema.properties.bodyParameters);
    assert.match(JSON.stringify(schema.properties.languageCode), /en_US/);
  });

  test("send_message takes exactly a recipient and a body", () => {
    const schema = tool("send_message").inputSchema;
    assert.deepEqual(schema.required, ["to", "text"]);
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(Object.keys(schema.properties), ["to", "text"]);
  });

  test("no third tool has crept in", () => {
    assert.deepEqual(
      whatsappProvider.tools.map((t) => t.name),
      ["send_message", "send_template"],
    );
  });
});

describe("normalizeWhatsAppRecipient", () => {
  test("accepts the way people actually write a number", () => {
    assert.equal(normalizeWhatsAppRecipient("+15550101234"), "15550101234");
    assert.equal(normalizeWhatsAppRecipient("15550101234"), "15550101234");
    assert.equal(normalizeWhatsAppRecipient("+1 (555) 010-1234"), "15550101234");
    assert.equal(normalizeWhatsAppRecipient("  +44 20 7946 0958 "), "442079460958");
    assert.equal(normalizeWhatsAppRecipient("+81.3.1234.5678"), "81312345678");
  });

  test("holds the E.164 length bounds", () => {
    assert.equal(normalizeWhatsAppRecipient(`+${"9".repeat(15)}`), "9".repeat(15));
    assert.throws(() => normalizeWhatsAppRecipient(`+${"9".repeat(16)}`), /E\.164/);
    assert.throws(() => normalizeWhatsAppRecipient("+123456"), /E\.164/);
  });

  test("refuses anything that is not digits", () => {
    assert.throws(() => normalizeWhatsAppRecipient("+1555010123x"), /is not a phone number/);
    assert.throws(() => normalizeWhatsAppRecipient("call the office"), /is not a phone number/);
    // Arabic-Indic digits look like a number and are not one to Meta.
    assert.throws(() => normalizeWhatsAppRecipient("١٥٥٥٠١٠١٢٣٤"), /is not a phone number/);
    assert.throws(() => normalizeWhatsAppRecipient("+1 555 010 1234 ext 22"), /is not a phone number/);
  });

  test("a missing or non-string recipient is named as such", () => {
    assert.throws(() => normalizeWhatsAppRecipient(undefined), /`to` is required/);
    assert.throws(() => normalizeWhatsAppRecipient(""), /`to` is required/);
    assert.throws(() => normalizeWhatsAppRecipient("   "), /`to` is required/);
    // A JSON number would have dropped a leading zero long before it got here.
    assert.throws(() => normalizeWhatsAppRecipient(15550101234), /`to` is required/);
    assert.throws(() => normalizeWhatsAppRecipient({ to: "+15550101234" }), /`to` is required/);
  });

  test("the error quotes what was passed, so the typo is visible", () => {
    assert.throws(() => normalizeWhatsAppRecipient("  +1 555 CALL  "), /"\+1 555 CALL"/);
  });
});

describe("buildWhatsAppTemplateMessage", () => {
  test("a template with no placeholders carries no components at all", () => {
    const message = buildWhatsAppTemplateMessage({
      to: "15550101234",
      templateName: "weekly_digest",
      languageCode: "en_US",
    });
    assert.deepEqual(message, {
      messaging_product: "whatsapp",
      to: "15550101234",
      type: "template",
      template: { name: "weekly_digest", language: { code: "en_US" } },
    });
  });

  test("an empty parameter list is an omission, not an empty array", () => {
    const message = buildWhatsAppTemplateMessage({
      to: "15550101234",
      templateName: "weekly_digest",
      languageCode: "en_US",
      bodyParameters: [],
    });
    assert.equal((message.template as Record<string, unknown>).components, undefined);
  });

  test("parameters become positional body components in order", () => {
    const message = buildWhatsAppTemplateMessage({
      to: "15550101234",
      templateName: "order_update",
      languageCode: "pt_BR",
      bodyParameters: ["Ada", "1042", "quinta-feira"],
    });
    assert.deepEqual(message.template, {
      name: "order_update",
      language: { code: "pt_BR" },
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: "Ada" },
            { type: "text", text: "1042" },
            { type: "text", text: "quinta-feira" },
          ],
        },
      ],
    });
  });

  test("numbers and booleans are stringified rather than refused", () => {
    const message = buildWhatsAppTemplateMessage({
      to: "15550101234",
      templateName: "stock_alert",
      languageCode: "en_US",
      bodyParameters: [42, true],
    });
    const components = (message.template as Record<string, unknown>).components as unknown[];
    assert.deepEqual((components[0] as Record<string, unknown>).parameters, [
      { type: "text", text: "42" },
      { type: "text", text: "true" },
    ]);
  });

  test("unicode survives untouched", () => {
    const message = buildWhatsAppTemplateMessage({
      to: "15550101234",
      templateName: "greeting",
      languageCode: "ja_JP",
      bodyParameters: ["こんにちは 👋", "Ådne"],
    });
    const components = (message.template as Record<string, unknown>).components as unknown[];
    assert.deepEqual((components[0] as Record<string, unknown>).parameters, [
      { type: "text", text: "こんにちは 👋" },
      { type: "text", text: "Ådne" },
    ]);
  });

  test("a malformed parameter list is refused before it reaches Meta", () => {
    const base = { to: "15550101234", templateName: "t", languageCode: "en_US" };
    assert.throws(
      () => buildWhatsAppTemplateMessage({ ...base, bodyParameters: "Ada" }),
      /must be an array of strings/,
    );
    assert.throws(
      () => buildWhatsAppTemplateMessage({ ...base, bodyParameters: ["Ada", { name: "Ada" }] }),
      /bodyParameters\[1\]/,
    );
  });
});

describe("whatsappErrorMessage", () => {
  test("the 24-hour refusal is explained, not passed through raw", () => {
    const message = whatsappErrorMessage(
      400,
      { error: { message: "Message failed to send.", code: 131047 } },
      "",
    );
    assert.match(message, /^WhatsApp: Message failed to send\. \(code 131047\)/);
    assert.match(message, /24 hours/);
    assert.match(message, /send_template/);
  });

  test("names the fixable causes it knows", () => {
    assert.match(
      whatsappErrorMessage(400, { error: { message: "x", code: 132001 } }, ""),
      /WhatsApp Manager/,
    );
    assert.match(
      whatsappErrorMessage(400, { error: { message: "x", code: 131026 } }, ""),
      /not reachable on WhatsApp/,
    );
    assert.match(
      whatsappErrorMessage(400, { error: { message: "x", code: 132000 } }, ""),
      /placeholder count/,
    );
    assert.match(
      whatsappErrorMessage(401, { error: { message: "x", code: 190 } }, ""),
      /expired or revoked/,
    );
    assert.match(
      whatsappErrorMessage(400, { error: { message: "x", code: 130429 } }, ""),
      /throttling/,
    );
  });

  test("an unrecognised 429 still says it was rate limited", () => {
    assert.match(whatsappErrorMessage(429, { error: { message: "Too many" } }, ""), /Rate limited/);
    // A code with a hint of its own does not also collect the generic note.
    assert.doesNotMatch(
      whatsappErrorMessage(429, { error: { message: "x", code: 130429 } }, ""),
      /Rate limited/,
    );
  });

  test("falls back to the raw body, then to the status", () => {
    assert.equal(whatsappErrorMessage(502, null, "<html>bad gateway</html>"), "WhatsApp: <html>bad gateway</html>");
    assert.equal(whatsappErrorMessage(500, null, ""), "WhatsApp: HTTP 500");
    assert.equal(whatsappErrorMessage(500, "not an object", "  "), "WhatsApp: HTTP 500");
    // An HTML error page is not worth 40kB of log line.
    assert.equal(whatsappErrorMessage(502, null, "x".repeat(1000)).length, "WhatsApp: ".length + 300);
  });
});

describe("isWhatsAppAuthFailure", () => {
  test("only a dead credential marks the Connection unusable", () => {
    assert.equal(isWhatsAppAuthFailure(401, undefined), true);
    assert.equal(isWhatsAppAuthFailure(400, 190), true);
    // A refused template or an unreachable number is one bad call, not a
    // broken Connection — turning the number red for those would train
    // operators to ignore the pill.
    assert.equal(isWhatsAppAuthFailure(400, 131047), false);
    assert.equal(isWhatsAppAuthFailure(404, undefined), false);
    assert.equal(isWhatsAppAuthFailure(429, 130429), false);
  });
});

describe("validateApiKey", () => {
  test("reads the number back from Meta and hints at it", async () => {
    const calls = captureFetch(() =>
      json({ display_phone_number: "+1 555 010 1234", verified_name: "Acme Support", id: "1" }),
    );
    const result = await whatsappProvider.validateApiKey!({
      phoneNumberId: " 123456789012345 ",
      accessToken: ` ${TOKEN} `,
      verifyToken: " verify-me ",
      appSecret: " app-secret ",
    });

    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url.origin + calls[0].url.pathname,
      `https://graph.facebook.com/${WHATSAPP_GRAPH_VERSION}/123456789012345`,
    );
    assert.equal(calls[0].url.searchParams.get("fields"), "display_phone_number,verified_name");
    assert.equal(calls[0].init?.method, "GET");
    assert.equal(new Headers(calls[0].init?.headers).get("authorization"), `Bearer ${TOKEN}`);

    assert.deepEqual(result.config, {
      phoneNumberId: "123456789012345",
      accessToken: TOKEN,
      verifyToken: "verify-me",
      appSecret: "app-secret",
      displayPhoneNumber: "+1 555 010 1234",
      verifiedName: "Acme Support",
    });
    assert.equal(result.accountHint, "Acme Support · +1 555 010 1234 · EAA…0001");
  });

  test("a number Meta has not verified still gets a usable hint", async () => {
    captureFetch(() => json({ display_phone_number: "+1 555 010 1234" }));
    const result = await whatsappProvider.validateApiKey!({
      phoneNumberId: "123456789012345",
      accessToken: TOKEN,
      verifyToken: "verify-me",
      appSecret: "app-secret",
    });
    assert.equal(result.accountHint, "+1 555 010 1234 · EAA…0001");
    assert.equal((result.config as Record<string, unknown>).verifiedName, undefined);
  });

  test("every missing field is named before anything leaves the machine", async () => {
    const calls = captureFetch(() => json({}));
    const complete = {
      phoneNumberId: "1",
      accessToken: TOKEN,
      verifyToken: "v",
      appSecret: "s",
    };
    for (const [key, label] of [
      ["phoneNumberId", "Phone number ID"],
      ["accessToken", "Access token"],
      ["verifyToken", "Verify token"],
      ["appSecret", "App secret"],
    ]) {
      await assert.rejects(
        whatsappProvider.validateApiKey!({ ...complete, [key]: "  " }),
        new RegExp(`${label} is required`),
      );
    }
    assert.equal(calls.length, 0);
  });

  test("a revoked token is reported as a credential problem", async () => {
    captureFetch(() =>
      json({ error: { message: "Error validating access token", code: 190 } }, 401),
    );
    const err = await whatsappProvider
      .validateApiKey!({
        phoneNumberId: "123456789012345",
        accessToken: TOKEN,
        verifyToken: "v",
        appSecret: "s",
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    assert.ok(err instanceof ConnectionAuthError);
    assert.match(err.message, /expired or revoked/);
    assert.equal(err.connectionStatus, "expired");
  });

  test("a phone number id cannot climb out of the path", async () => {
    const calls = captureFetch(() => json({ verified_name: "Acme" }));
    await whatsappProvider.validateApiKey!({
      phoneNumberId: "../me?fields=id&x=",
      accessToken: TOKEN,
      verifyToken: "v",
      appSecret: "s",
    });
    assert.equal(
      calls[0].url.pathname,
      `/${WHATSAPP_GRAPH_VERSION}/..%2Fme%3Ffields%3Did%26x%3D`,
    );
  });
});

describe("checkStatus", () => {
  test("a reachable number is connected", async () => {
    captureFetch(() => json({ verified_name: "Acme Support" }));
    assert.deepEqual(await whatsappProvider.checkStatus!(runtime()), { ok: true });
  });

  test("a revoked token reads as expired, a bad request as an error", async () => {
    captureFetch(() => json({ error: { message: "gone", code: 190 } }, 401));
    const expired = await whatsappProvider.checkStatus!(runtime());
    assert.equal(expired.ok, false);
    assert.equal(expired.status, "expired");

    captureFetch(() => json({ error: { message: "Unsupported get request", code: 100 } }, 400));
    const broken = await whatsappProvider.checkStatus!(runtime());
    assert.equal(broken.ok, false);
    assert.equal(broken.status, "error");
    assert.match(broken.message!, /Unsupported get request \(code 100\)/);
  });

  test("a Connection with no token says so instead of calling Meta", async () => {
    const calls = captureFetch(() => json({}));
    const result = await whatsappProvider.checkStatus!(runtime({ accessToken: "" }));
    assert.equal(result.ok, false);
    assert.match(result.message!, /no WhatsApp access token/);
    assert.equal(calls.length, 0);
  });
});

describe("invokeTool", () => {
  test("send_message posts the Cloud API text shape", async () => {
    const calls = captureFetch(() => json({ messages: [{ id: "wamid.OUT" }] }));
    const result = await whatsappProvider.invokeTool(
      "send_message",
      { to: "+1 (555) 010-1234", text: "Runway is 14 months." },
      runtime(),
    );

    assert.equal(
      calls[0].url.href,
      `https://graph.facebook.com/${WHATSAPP_GRAPH_VERSION}/123456789012345/messages`,
    );
    assert.equal(calls[0].init?.method, "POST");
    assert.equal(new Headers(calls[0].init?.headers).get("content-type"), "application/json");
    assert.deepEqual(calls[0].body, {
      messaging_product: "whatsapp",
      to: "15550101234",
      type: "text",
      text: { body: "Runway is 14 months." },
    });
    assert.deepEqual(result, { messages: [{ id: "wamid.OUT" }] });
  });

  test("send_message refuses an empty body before spending a call", async () => {
    const calls = captureFetch(() => json({}));
    await assert.rejects(
      whatsappProvider.invokeTool("send_message", { to: "+15550101234", text: "   " }, runtime()),
      /`text` is required/,
    );
    assert.equal(calls.length, 0);
  });

  test("send_message surfaces the closed window as advice", async () => {
    captureFetch(() =>
      json(
        {
          error: {
            message: "Message failed to send because more than 24 hours have passed.",
            code: 131047,
          },
        },
        400,
      ),
    );
    await assert.rejects(
      whatsappProvider.invokeTool(
        "send_message",
        { to: "+15550101234", text: "Just checking in." },
        runtime(),
      ),
      /send_template/,
    );
  });

  test("send_template posts the template shape", async () => {
    const calls = captureFetch(() => json({ messages: [{ id: "wamid.TPL" }] }));
    await whatsappProvider.invokeTool(
      "send_template",
      {
        to: "+15550101234",
        templateName: " order_update ",
        languageCode: " en_US ",
        bodyParameters: ["Ada", 1042],
      },
      runtime(),
    );
    assert.deepEqual(calls[0].body, {
      messaging_product: "whatsapp",
      to: "15550101234",
      type: "template",
      template: {
        name: "order_update",
        language: { code: "en_US" },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: "Ada" },
              { type: "text", text: "1042" },
            ],
          },
        ],
      },
    });
  });

  test("send_template names the argument it is missing", async () => {
    const calls = captureFetch(() => json({}));
    await assert.rejects(
      whatsappProvider.invokeTool(
        "send_template",
        { to: "+15550101234", languageCode: "en_US" },
        runtime(),
      ),
      /`templateName` is required/,
    );
    await assert.rejects(
      whatsappProvider.invokeTool(
        "send_template",
        { to: "+15550101234", templateName: "order_update" },
        runtime(),
      ),
      /`languageCode` is required/,
    );
    assert.equal(calls.length, 0);
  });

  test("an unknown tool name is refused by name", async () => {
    await assert.rejects(
      whatsappProvider.invokeTool("send_image", {}, runtime()),
      /Unknown WhatsApp tool: send_image/,
    );
  });

  test("a Connection missing its phone number id cannot post anywhere", async () => {
    const calls = captureFetch(() => json({}));
    await assert.rejects(
      whatsappProvider.invokeTool(
        "send_message",
        { to: "+15550101234", text: "hello" },
        runtime({ phoneNumberId: "" }),
      ),
      /no WhatsApp phone number ID/,
    );
    assert.equal(calls.length, 0);
  });
});
