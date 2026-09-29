import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { afterEach, describe, test } from "node:test";

import { overrideRuntimeSettingsForTests } from "./runtimeSettings.js";
import {
  WebToolError,
  chooseFilename,
  downloadWebFile,
  fetchWebPage,
  parseDuckDuckGoResults,
  searchWeb,
} from "./webBrowsing.js";
import { EMPTY_SEARCH_PAGE, SEARCH_CHALLENGE_PAGE } from "../test/webSearchFixtures.js";

/**
 * The web tools.
 *
 * Two things are worth holding still here. The first is the result parser,
 * which is the part that breaks when a search engine changes its markup —
 * covered against captured HTML rather than the live network. The second is
 * that every refusal (an off switch, a bad scheme, a non-public address)
 * happens *before* a request goes out, and comes back as something an
 * employee can read and act on.
 */

/**
 * The web group is a database-backed runtime setting now, so tests reach it
 * through the service's in-process override seam rather than by mutating a
 * config literal. `null` drops every override.
 */
afterEach(() => {
  overrideRuntimeSettingsForTests(null);
});

const RESULT_PAGE = `
<html><body>
  <div class="result results_links">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.irs.gov%2Fpub%2Firs-pdf%2Ffw9.pdf&amp;rut=abc">Form <b>W-9</b> (Rev. March 2024)</a>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.irs.gov%2Fpub%2Firs-pdf%2Ffw9.pdf">Request for Taxpayer Identification Number and Certification.</a>
  </div>
  <div class="result results_links">
    <a rel="nofollow" class="result__a" href="https://www.irs.gov/forms-pubs/about-form-w-9">About Form W-9</a>
    <a class="result__snippet">Information about Form W-9, including recent updates.</a>
  </div>
  <div class="result result--ad">
    <a class="result__a" href="//duckduckgo.com/y.js?ad_provider=x">Sponsored tax filing</a>
  </div>
</body></html>
`;

describe("parsing search results", () => {
  test("unwraps the redirect so the employee sees the real destination", () => {
    const results = parseDuckDuckGoResults(RESULT_PAGE, 5);

    assert.equal(results[0].url, "https://www.irs.gov/pub/irs-pdf/fw9.pdf");
    assert.equal(results[0].title, "Form W-9 (Rev. March 2024)");
    assert.match(results[0].snippet, /Taxpayer Identification Number/);
  });

  test("keeps direct links and drops the search engine's own ad links", () => {
    const results = parseDuckDuckGoResults(RESULT_PAGE, 5);

    assert.deepEqual(
      results.map((r) => r.url),
      ["https://www.irs.gov/pub/irs-pdf/fw9.pdf", "https://www.irs.gov/forms-pubs/about-form-w-9"],
    );
  });

  test("honours the limit and de-duplicates repeated destinations", () => {
    const doubled = RESULT_PAGE + RESULT_PAGE;

    assert.equal(parseDuckDuckGoResults(doubled, 5).length, 2);
    assert.equal(parseDuckDuckGoResults(RESULT_PAGE, 1).length, 1);
  });

  test("markup we do not recognize yields no results rather than junk", () => {
    assert.deepEqual(
      parseDuckDuckGoResults("<html><body><p>nothing here</p></body></html>", 5),
      [],
    );
    assert.deepEqual(parseDuckDuckGoResults("", 5), []);
  });

  test("a result with no readable title is skipped", () => {
    const html = '<a class="result__a" href="https://example.com/x"> </a>';

    assert.deepEqual(parseDuckDuckGoResults(html, 5), []);
  });

  test("reads result attributes in either order with single, double or unquoted values", () => {
    const html = `<div class='result'>
      <a href='https://example.com/first' data-label='a > b' class='extra result__a'>First</a>
      <a href='https://example.com/first' class='result__snippet extra'>First snippet</a>
    </div><div class=result>
      <a href=https://example.com/second class=result__a>Second</a>
      <a class=result__snippet>Second snippet</a>
    </div>`;
    assert.deepEqual(parseDuckDuckGoResults(html, 5), [
      { title: "First", url: "https://example.com/first", snippet: "First snippet" },
      { title: "Second", url: "https://example.com/second", snippet: "Second snippet" },
    ]);
  });

  test("pairs snippets within their result, including skipped ads, duplicates and missing snippets", () => {
    const html = `<div class="result result--ad">
      <a class="result__a" href="//duckduckgo.com/y.js?ad_provider=x">Ad</a>
      <a class="result__snippet">Ad snippet</a>
    </div><div class="result"><div class="result__body">
      <a class="result__a" href="https://example.com/one">One</a>
    </div></div><div class="result">
      <a class="result__a" href="https://example.com/one">Duplicate</a>
      <a class="result__snippet">Duplicate snippet</a>
    </div><div class="result"><div>
      <a class="result__a" href="https://example.com/two">Two</a>
      <a class="result__snippet">Two snippet</a>
    </div></div><a class="result__snippet">Outside any result</a>`;
    assert.deepEqual(parseDuckDuckGoResults(html, 5), [
      { title: "One", url: "https://example.com/one", snippet: "" },
      { title: "Two", url: "https://example.com/two", snippet: "Two snippet" },
    ]);
  });

  test("does not mistake similar class names or commented links for results", () => {
    const html = `<div class="result">
      <a class="not-result__a" href="https://example.com/wrong">Wrong</a>
      <!-- <a class="result__a" href="https://example.com/comment">Comment</a> -->
    </div>`;
    assert.deepEqual(parseDuckDuckGoResults(html, 5), []);
  });
});

describe("search responses distinguish unavailable from empty", () => {
  for (const [label, body, status, contentType] of [
    ["captured HTTP 202 bot challenge", SEARCH_CHALLENGE_PAGE, 202, "text/html"],
    ["HTTP 200 bot challenge", SEARCH_CHALLENGE_PAGE, 200, "text/html"],
    [
      "unrecognized HTML",
      "<html><body>Service temporarily unavailable</body></html>",
      200,
      "text/html",
    ],
    ["empty response", "", 200, "text/html"],
    ["non-HTML response", '{"message":"try later"}', 200, "application/json"],
  ] as const) {
    test(`${label} is a tool error rather than evidence of no matches`, async (t) => {
      t.mock.method(dns, "lookup", async () => [{ address: "8.8.8.8", family: 4 }]);
      const fetch = t.mock.method(
        globalThis,
        "fetch",
        async () => new Response(body, { status, headers: { "content-type": contentType } }),
      );
      await assert.rejects(
        () => searchWeb("forms", 5),
        (error: unknown) => {
          assert.ok(error instanceof WebToolError);
          assert.equal(error.status, 502);
          assert.match(error.message, /search is unavailable/i);
          assert.match(error.message, /does not mean.*no matching/i);
          return true;
        },
      );
      assert.equal(fetch.mock.callCount(), 1, "does not repeatedly attempt a challenge");
    });
  }

  test("preserves explicit genuine empty results", async (t) => {
    t.mock.method(dns, "lookup", async () => [{ address: "8.8.8.8", family: 4 }]);
    t.mock.method(
      globalThis,
      "fetch",
      async () => new Response(EMPTY_SEARCH_PAGE, { headers: { "content-type": "text/html" } }),
    );
    assert.deepEqual(await searchWeb("no matching pages", 5), []);
  });

  test("a challenge takes precedence over an empty-results marker", async (t) => {
    t.mock.method(dns, "lookup", async () => [{ address: "8.8.8.8", family: 4 }]);
    t.mock.method(
      globalThis,
      "fetch",
      async () => new Response(SEARCH_CHALLENGE_PAGE + EMPTY_SEARCH_PAGE),
    );
    await assert.rejects(() => searchWeb("forms", 5), /challenge/i);
  });

  test("normal results remain usable and obey the requested limit", async (t) => {
    t.mock.method(dns, "lookup", async () => [{ address: "8.8.8.8", family: 4 }]);
    t.mock.method(globalThis, "fetch", async (url: URL) => {
      assert.equal(url.origin, "https://html.duckduckgo.com");
      assert.equal(url.searchParams.get("q"), "forms");
      return new Response(RESULT_PAGE, { headers: { "content-type": "text/html" } });
    });
    assert.deepEqual(await searchWeb(" forms ", 1), parseDuckDuckGoResults(RESULT_PAGE, 1));
  });
});

describe("refusals happen before any request goes out", () => {
  test("the master switch turns all three tools off with an explanation", async () => {
    overrideRuntimeSettingsForTests({ web: { enabled: false } });

    for (const call of [
      () => searchWeb("w-9 form", 3),
      () => fetchWebPage("https://example.com"),
      () => downloadWebFile("https://example.com/x.pdf"),
    ]) {
      await assert.rejects(call, (error: unknown) => {
        assert.ok(error instanceof WebToolError);
        assert.equal(error.status, 403);
        assert.match(error.message, /Admin → Runtime/);
        return true;
      });
    }
  });

  test("search can be disabled while direct fetches keep working", async () => {
    overrideRuntimeSettingsForTests({ web: { searchProvider: "disabled" } });

    await assert.rejects(
      () => searchWeb("w-9 form", 3),
      (error: unknown) => {
        assert.ok(error instanceof WebToolError);
        assert.equal(error.status, 403);
        assert.match(error.message, /fetch_web_page/, "the refusal names what still works");
        return true;
      },
    );
  });

  test("an empty query is refused rather than searched for nothing", async () => {
    await assert.rejects(() => searchWeb("   ", 3), /something to search for/i);
  });

  test("non-http schemes are refused", async () => {
    for (const url of ["file:///etc/passwd", "ftp://example.com/x", "javascript:alert(1)"]) {
      await assert.rejects(() => fetchWebPage(url), /http and https/i);
      await assert.rejects(() => downloadWebFile(url), /http and https/i);
    }
  });

  test("a malformed URL says what a usable one looks like", async () => {
    await assert.rejects(() => fetchWebPage("not a url"), /include the scheme/i);
  });

  test("a URL that resolves to a private address never leaves the process", async () => {
    // The outbound guard is what makes these tools safe to hand an AI a link
    // out of a stranger's email; this is that guard, reached through the tool.
    for (const url of ["http://127.0.0.1:8471/admin", "http://169.254.169.254/latest/meta-data/"]) {
      await assert.rejects(
        () => fetchWebPage(url),
        (error: unknown) => {
          assert.ok(error instanceof WebToolError);
          assert.match(error.message, /non-public address/);
          return true;
        },
      );
    }
  });

  test("credentials embedded in a URL are refused", async () => {
    await assert.rejects(
      () => downloadWebFile("https://user:secret@example.com/file.pdf"),
      /embedded credentials/,
    );
  });
});

describe("choosing a filename for a download", () => {
  test("prefers the last path segment of the URL", () => {
    assert.equal(
      chooseFilename(undefined, "https://www.irs.gov/pub/irs-pdf/fw9.pdf", "application/pdf"),
      "fw9.pdf",
    );
  });

  test("an explicit hint wins", () => {
    assert.equal(
      chooseFilename("w9-blank.pdf", "https://example.com/download?id=17", "application/pdf"),
      "w9-blank.pdf",
    );
  });

  test("appends an extension from the content type when there is none", () => {
    assert.equal(
      chooseFilename(undefined, "https://example.com/download", "application/pdf"),
      "download.pdf",
    );
    assert.equal(chooseFilename(undefined, "https://example.com/page", "text/html"), "page.html");
  });

  test("strips path traversal, quotes and control characters", () => {
    assert.equal(
      chooseFilename('../../etc/pa"sswd', "https://example.com/x", "text/plain"),
      "passwd.txt",
    );
    assert.equal(
      chooseFilename("..", "https://example.com/x.bin", "application/octet-stream"),
      "download",
    );
  });

  test("falls back to a usable name for a URL with no path", () => {
    assert.equal(
      chooseFilename(undefined, "https://example.com/", "application/pdf"),
      "download.pdf",
    );
  });

  test("decodes a percent-encoded segment", () => {
    assert.equal(
      chooseFilename(undefined, "https://example.com/New%20Supplier%20Form.pdf", "application/pdf"),
      "New Supplier Form.pdf",
    );
  });
});
