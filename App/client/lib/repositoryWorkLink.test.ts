import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  collectRepositoryWorkTargets,
  collectTranscriptWorkTargets,
  parseRepositoryWorkHref,
  parseRepositoryWorkPath,
  repositoryWorkHref,
  shouldOpenWorkLinkInPanel,
} from "./repositoryWorkLink";

/**
 * Recognising a Repository work session in a chat transcript.
 *
 * Everything downstream of this is a panel opening or a page navigating, so
 * both kinds of mistake matter: a link we fail to recognise throws the reader
 * out of the conversation, and a link we recognise too eagerly swallows an
 * ordinary navigation they asked for.
 */

const COMPANY = "acme";
const ORIGIN = "https://genosyn.example.com";
const SESSION = "7d0b1f2e-4c3a-4a11-9d55-0f9b1c2d3e4f";

describe("parseRepositoryWorkPath", () => {
  test("reads the repository and session out of a session path", () => {
    assert.deepEqual(
      parseRepositoryWorkPath(`/c/acme/repositories/oneuptime/ai/${SESSION}`, COMPANY),
      {
        repositorySlug: "oneuptime",
        sessionId: SESSION,
      },
    );
  });

  test("ignores the session list, which is a page and not a session", () => {
    assert.equal(parseRepositoryWorkPath("/c/acme/repositories/oneuptime/ai", COMPANY), null);
  });

  test("ignores every other repository route", () => {
    for (const path of [
      "/c/acme/repositories",
      "/c/acme/repositories/oneuptime",
      "/c/acme/repositories/oneuptime/files",
      "/c/acme/repositories/oneuptime/access",
      `/c/acme/repositories/oneuptime/ai/${SESSION}/files`,
      "/c/acme/employees/ada/chat",
    ]) {
      assert.equal(parseRepositoryWorkPath(path, COMPANY), null, path);
    }
  });

  test("ignores another company's session", () => {
    assert.equal(parseRepositoryWorkPath(`/c/other/repositories/x/ai/${SESSION}`, COMPANY), null);
  });

  test("matches the company slug without caring about case or stray spacing", () => {
    assert.ok(parseRepositoryWorkPath(`/c/ACME/repositories/x/ai/${SESSION}`, "acme"));
    assert.ok(parseRepositoryWorkPath(`/c/acme/repositories/x/ai/${SESSION}`, " Acme "));
  });

  test("keeps the repository slug exactly as it was written", () => {
    const target = parseRepositoryWorkPath(`/c/acme/repositories/OneUptime/ai/${SESSION}`, COMPANY);
    assert.equal(target?.repositorySlug, "OneUptime");
  });

  test("survives a trailing slash and percent-encoding", () => {
    assert.deepEqual(
      parseRepositoryWorkPath(`/c/acme/repositories/one%2Duptime/ai/${SESSION}/`, COMPANY),
      {
        repositorySlug: "one-uptime",
        sessionId: SESSION,
      },
    );
  });

  test("refuses a segment that decodes into more than one segment", () => {
    // The segment count is checked on the encoded path, so `%2F` gets past it
    // and then decodes into a slash. Callers interpolate these straight into
    // API paths, so `../../` must never come back out of here.
    assert.equal(
      parseRepositoryWorkPath("/c/acme/repositories/docs/ai/..%2F..%2F..%2Fusers", COMPANY),
      null,
    );
    assert.equal(parseRepositoryWorkPath("/c/acme/repositories/a%2Fb/ai/abc", COMPANY), null);
    assert.equal(parseRepositoryWorkPath("/c/acme/repositories/docs/ai/a%5Cb", COMPANY), null);
  });

  test("refuses a relative segment", () => {
    assert.equal(parseRepositoryWorkPath("/c/acme/repositories/docs/ai/%2E%2E", COMPANY), null);
    assert.equal(parseRepositoryWorkPath("/c/acme/repositories/%2E/ai/abc", COMPANY), null);
  });

  test("refuses control characters", () => {
    assert.equal(parseRepositoryWorkPath("/c/acme/repositories/docs/ai/a%00b", COMPANY), null);
    assert.equal(parseRepositoryWorkPath("/c/acme/repositories/docs/ai/a%0Ab", COMPANY), null);
  });

  test("does not treat a malformed escape as a reason to throw", () => {
    assert.deepEqual(
      parseRepositoryWorkPath(`/c/acme/repositories/one%zz/ai/${SESSION}`, COMPANY),
      {
        repositorySlug: "one%zz",
        sessionId: SESSION,
      },
    );
  });
});

describe("parseRepositoryWorkHref", () => {
  test("reads the relative link an employee is told to write", () => {
    assert.deepEqual(
      parseRepositoryWorkHref(`/c/acme/repositories/oneuptime/ai/${SESSION}`, COMPANY, ORIGIN),
      { repositorySlug: "oneuptime", sessionId: SESSION },
    );
  });

  test("reads the whole address a human pastes back in", () => {
    assert.deepEqual(
      parseRepositoryWorkHref(
        `${ORIGIN}/c/acme/repositories/oneuptime/ai/${SESSION}`,
        COMPANY,
        ORIGIN,
      ),
      { repositorySlug: "oneuptime", sessionId: SESSION },
    );
  });

  test("leaves another host's link to navigate normally", () => {
    assert.equal(
      parseRepositoryWorkHref(
        `https://phishing.example/c/acme/repositories/oneuptime/ai/${SESSION}`,
        COMPANY,
        ORIGIN,
      ),
      null,
    );
  });

  test("treats a protocol-relative link as another host", () => {
    assert.equal(
      parseRepositoryWorkHref(
        `//elsewhere.example/c/acme/repositories/x/ai/${SESSION}`,
        COMPANY,
        ORIGIN,
      ),
      null,
    );
  });

  test("ignores schemes that are not the web", () => {
    for (const href of [
      `mailto:someone@example.com?body=/c/acme/repositories/x/ai/${SESSION}`,
      `javascript:location='/c/acme/repositories/x/ai/${SESSION}'`,
      `data:text/html,/c/acme/repositories/x/ai/${SESSION}`,
    ]) {
      assert.equal(parseRepositoryWorkHref(href, COMPANY, ORIGIN), null, href);
    }
  });

  test("drops a query string and a fragment", () => {
    assert.deepEqual(
      parseRepositoryWorkHref(
        `/c/acme/repositories/oneuptime/ai/${SESSION}?tab=changes#top`,
        COMPANY,
      ),
      { repositorySlug: "oneuptime", sessionId: SESSION },
    );
  });

  test("ignores a relative href, which the app never writes", () => {
    assert.equal(parseRepositoryWorkHref(`repositories/oneuptime/ai/${SESSION}`, COMPANY), null);
  });

  test("ignores nothing at all", () => {
    assert.equal(parseRepositoryWorkHref(null, COMPANY), null);
    assert.equal(parseRepositoryWorkHref(undefined, COMPANY), null);
    assert.equal(parseRepositoryWorkHref("", COMPANY), null);
    assert.equal(parseRepositoryWorkHref("   ", COMPANY), null);
  });

  test("accepts any web host when no origin is supplied", () => {
    assert.ok(
      parseRepositoryWorkHref(
        `https://anywhere.example/c/acme/repositories/x/ai/${SESSION}`,
        COMPANY,
      ),
    );
  });

  test("round-trips the href the panel links back out with", () => {
    const target = { repositorySlug: "oneuptime", sessionId: SESSION };
    assert.deepEqual(parseRepositoryWorkHref(repositoryWorkHref(COMPANY, target), COMPANY), target);
  });
});

describe("collectRepositoryWorkTargets", () => {
  test("finds the markdown link the tool prescribes", () => {
    // The exact sentence `start_repository_work_session` tells the model to
    // write. If this ever stops parsing, the panel silently stops opening.
    const reply =
      "I've started the implementation in a dedicated branch based on `master`. " +
      `Review progress and the eventual diff here: [oneuptime → AI work](/c/acme/repositories/oneuptime/ai/${SESSION})`;
    assert.deepEqual(collectRepositoryWorkTargets(reply, COMPANY), [
      { repositorySlug: "oneuptime", sessionId: SESSION },
    ]);
  });

  test("finds a bare link a Member pasted in", () => {
    assert.deepEqual(
      collectRepositoryWorkTargets(
        `have a look at ${ORIGIN}/c/acme/repositories/docs/ai/${SESSION}`,
        COMPANY,
      ),
      [{ repositorySlug: "docs", sessionId: SESSION }],
    );
  });

  test("does not swallow the punctuation that ends the sentence", () => {
    assert.deepEqual(
      collectRepositoryWorkTargets(`It is at /c/acme/repositories/docs/ai/${SESSION}.`, COMPANY),
      [{ repositorySlug: "docs", sessionId: SESSION }],
    );
  });

  test("keeps every distinct session, oldest first, and each one once", () => {
    const text =
      `[a](/c/acme/repositories/one/ai/session-a) then [b](/c/acme/repositories/two/ai/session-b) ` +
      `and [a again](/c/acme/repositories/one/ai/session-a)`;
    assert.deepEqual(collectRepositoryWorkTargets(text, COMPANY), [
      { repositorySlug: "one", sessionId: "session-a" },
      { repositorySlug: "two", sessionId: "session-b" },
    ]);
  });

  test("ignores links that are not a work session", () => {
    const text = [
      "/c/acme/repositories/one",
      "/c/acme/repositories/one/files",
      "/c/acme/repositories/one/ai",
      "/c/acme/employees/ada/chat",
      "/c/other/repositories/one/ai/session-a",
      "https://github.com/genosyn/genosyn/pull/12",
    ].join(" and ");
    assert.deepEqual(collectRepositoryWorkTargets(text, COMPANY), []);
  });

  test("cannot be walked into from another host's URL", () => {
    // Scanning for `/c/` alone used to re-enter a rejected URL at its inner
    // path and come back out with something that read as same-origin.
    for (const text of [
      `https://evil.example/foo/c/acme/repositories/x/ai/${SESSION}`,
      `https://evil.example/a/b/c/acme/repositories/x/ai/${SESSION}`,
      `http://evil.example:8080/redirect?to=/c/acme/repositories/x/ai/${SESSION}`,
    ]) {
      assert.deepEqual(collectRepositoryWorkTargets(text, COMPANY, ORIGIN), [], text);
    }
  });

  test("does not read a path out of a non-web URI", () => {
    assert.deepEqual(
      collectRepositoryWorkTargets(
        `mailto:someone@example.com?body=/c/acme/repositories/x/ai/${SESSION}`,
        COMPANY,
        ORIGIN,
      ),
      [],
    );
    assert.deepEqual(
      collectRepositoryWorkTargets(
        `javascript:fetch("/c/acme/repositories/x/ai/${SESSION}")`,
        COMPANY,
        ORIGIN,
      ),
      [],
    );
  });

  test("reads a link written the ways chat actually writes them", () => {
    const cases = [
      `[docs → AI work](/c/acme/repositories/docs/ai/${SESSION})`,
      `/c/acme/repositories/docs/ai/${SESSION}`,
      `Started — /c/acme/repositories/docs/ai/${SESSION} is where you review it.`,
      `- /c/acme/repositories/docs/ai/${SESSION}`,
      `line one\n/c/acme/repositories/docs/ai/${SESSION}`,
      `(see /c/acme/repositories/docs/ai/${SESSION})`,
      `${ORIGIN}/c/acme/repositories/docs/ai/${SESSION}`,
    ];
    for (const text of cases) {
      assert.deepEqual(
        collectRepositoryWorkTargets(text, COMPANY, ORIGIN),
        [{ repositorySlug: "docs", sessionId: SESSION }],
        text,
      );
    }
  });

  test("still finds our own links among hostile ones", () => {
    const text =
      `not this https://evil.example/foo/c/acme/repositories/x/ai/nope ` +
      `but this [docs → AI work](/c/acme/repositories/docs/ai/${SESSION})`;
    assert.deepEqual(collectRepositoryWorkTargets(text, COMPANY, ORIGIN), [
      { repositorySlug: "docs", sessionId: SESSION },
    ]);
  });

  test("scans a long message without pathological backtracking", () => {
    // A long unbroken run of scheme-legal characters with no colon in it is
    // the shape that made an unbounded scheme quantifier quadratic: 80 000
    // characters took twenty seconds. It has to be *this* input — repeating
    // "/c/" is answered by the path alternative immediately and passes under
    // either version.
    const hostile = "a".repeat(80000);
    const started = process.hrtime.bigint();
    assert.deepEqual(collectRepositoryWorkTargets(hostile, COMPANY, ORIGIN), []);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(elapsedMs < 1000, `scanning took ${elapsedMs}ms`);
  });

  test("still finds the link at the end of a very long message", () => {
    const text = `${"x".repeat(50000)} [docs → AI work](/c/acme/repositories/docs/ai/${SESSION})`;
    assert.deepEqual(collectRepositoryWorkTargets(text, COMPANY, ORIGIN), [
      { repositorySlug: "docs", sessionId: SESSION },
    ]);
  });

  test("respects the origin when one is given", () => {
    const text = `https://elsewhere.example/c/acme/repositories/one/ai/${SESSION}`;
    assert.deepEqual(collectRepositoryWorkTargets(text, COMPANY, ORIGIN), []);
    assert.equal(collectRepositoryWorkTargets(text, COMPANY).length, 1);
  });

  test("finds nothing in an ordinary reply", () => {
    assert.deepEqual(
      collectRepositoryWorkTargets("Done — the numbers are in the note.", COMPANY),
      [],
    );
    assert.deepEqual(collectRepositoryWorkTargets("", COMPANY), []);
  });
});

describe("collectTranscriptWorkTargets", () => {
  test("reads a whole thread in order and reports each session once", () => {
    const messages = [
      "Can you fix the flaky test?",
      `Started: [oneuptime → AI work](/c/acme/repositories/oneuptime/ai/session-a)`,
      "Thanks",
      `Also started the docs pass: [docs → AI work](/c/acme/repositories/docs/ai/session-b)`,
      `Both are here: /c/acme/repositories/oneuptime/ai/session-a and /c/acme/repositories/docs/ai/session-b`,
    ];
    assert.deepEqual(collectTranscriptWorkTargets(messages, COMPANY), [
      { repositorySlug: "oneuptime", sessionId: "session-a" },
      { repositorySlug: "docs", sessionId: "session-b" },
    ]);
  });

  test("skips empty messages without tripping over them", () => {
    assert.deepEqual(collectTranscriptWorkTargets(["", "   ", ""], COMPANY), []);
    assert.deepEqual(collectTranscriptWorkTargets([], COMPANY), []);
  });
});

describe("shouldOpenWorkLinkInPanel", () => {
  test("takes over a plain left click", () => {
    assert.equal(shouldOpenWorkLinkInPanel({ button: 0 }), true);
    assert.equal(shouldOpenWorkLinkInPanel({}), true);
    assert.equal(shouldOpenWorkLinkInPanel({ button: 0, anchorTarget: "_self" }), true);
    assert.equal(shouldOpenWorkLinkInPanel({ button: 0, anchorTarget: "" }), true);
  });

  test("leaves the browser's own new-tab gestures alone", () => {
    assert.equal(shouldOpenWorkLinkInPanel({ metaKey: true }), false);
    assert.equal(shouldOpenWorkLinkInPanel({ ctrlKey: true }), false);
    assert.equal(shouldOpenWorkLinkInPanel({ shiftKey: true }), false);
    assert.equal(shouldOpenWorkLinkInPanel({ altKey: true }), false);
    assert.equal(shouldOpenWorkLinkInPanel({ button: 1 }), false);
    assert.equal(shouldOpenWorkLinkInPanel({ button: 2 }), false);
  });

  test("leaves an anchor that already says where it opens", () => {
    assert.equal(shouldOpenWorkLinkInPanel({ anchorTarget: "_blank" }), false);
    assert.equal(shouldOpenWorkLinkInPanel({ anchorTarget: "  _BLANK " }), false);
    assert.equal(shouldOpenWorkLinkInPanel({ anchorTarget: "reports" }), false);
  });

  test("does not fight a handler that already dealt with the click", () => {
    assert.equal(shouldOpenWorkLinkInPanel({ defaultPrevented: true }), false);
  });
});
