import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { conferenceForEvent, providerForUrl } from "./conference.js";

/**
 * Conference detection is pure, and it is the decision the whole recorder
 * hangs off: `none` means "nothing to join" to the auto-record policy, so a
 * miss here is a call nobody records and a false positive is a bot pointed at
 * a wiki page.
 */
describe("providerForUrl", () => {
  test("names the hosts we know", () => {
    assert.equal(providerForUrl("https://meet.google.com/abc-defg-hij"), "meet");
    assert.equal(providerForUrl("https://acme.zoom.us/j/123456"), "zoom");
    assert.equal(providerForUrl("https://zoom.us/j/123456"), "zoom");
    assert.equal(providerForUrl("https://teams.microsoft.com/l/meetup-join/x"), "teams");
    assert.equal(providerForUrl("https://acme.webex.com/meet/x"), "webex");
  });

  test("matches on a dot boundary, so a lookalike host is not Zoom", () => {
    assert.equal(providerForUrl("https://notzoom.us/j/1"), null);
    assert.equal(providerForUrl("https://zoom.us.evil.example/j/1"), null);
  });

  test("prefers the longest suffix", () => {
    assert.equal(providerForUrl("https://x.webex.com.cn/meet/y"), "webex");
  });

  test("an unparseable URL is not a provider", () => {
    assert.equal(providerForUrl("not a url"), null);
  });
});

describe("conferenceForEvent", () => {
  test("structured conferenceData wins over everything", () => {
    const result = conferenceForEvent({
      conferenceData: {
        entryPoints: [
          { entryPointType: "phone", uri: "tel:+15551234" },
          { entryPointType: "video", uri: "https://meet.google.com/aaa-bbbb-ccc" },
        ],
      },
      hangoutLink: "https://meet.google.com/zzz-zzzz-zzz",
      location: "https://acme.zoom.us/j/9",
    });
    assert.deepEqual(result, {
      provider: "meet",
      url: "https://meet.google.com/aaa-bbbb-ccc",
    });
  });

  test("a phone-only entry point is not a conference to join", () => {
    const result = conferenceForEvent({
      conferenceData: { entryPoints: [{ entryPointType: "phone", uri: "tel:+15551234" }] },
    });
    assert.equal(result.provider, "none");
  });

  test("falls back to hangoutLink", () => {
    const result = conferenceForEvent({ hangoutLink: "https://meet.google.com/xyz-xyzw-xyz" });
    assert.equal(result.provider, "meet");
  });

  test("a named link in the description beats an unnamed link in the location", () => {
    const result = conferenceForEvent({
      location: "https://notion.so/agenda-page",
      description: "Agenda: https://notion.so/x\nJoin: https://acme.zoom.us/j/42",
    });
    assert.deepEqual(result, { provider: "zoom", url: "https://acme.zoom.us/j/42" });
  });

  test("an unnamed URL in the location is still a call", () => {
    const result = conferenceForEvent({ location: "https://jitsi.acme.test/standup" });
    assert.deepEqual(result, { provider: "other", url: "https://jitsi.acme.test/standup" });
  });

  test("an unnamed URL in the description alone is not — descriptions are mostly documents", () => {
    const result = conferenceForEvent({ description: "Read https://notion.so/the-brief first" });
    assert.equal(result.provider, "none");
  });

  test("trailing sentence punctuation is not part of the URL", () => {
    const result = conferenceForEvent({
      description: "Join at https://acme.zoom.us/j/42.",
    });
    assert.equal(result.url, "https://acme.zoom.us/j/42");
  });

  test("an event with nothing in it has no conference", () => {
    assert.deepEqual(conferenceForEvent({}), { provider: "none", url: "" });
  });
});
