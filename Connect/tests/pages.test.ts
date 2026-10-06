import assert from "node:assert/strict";
import vm from "node:vm";
import { test } from "node:test";
import { consentPage, escapeHtml, landingPage, messagePage, scriptString } from "../src/pages.js";
import { canonicalProtocol } from "../src/protocol.js";

const links = { privacy: null, terms: null };

test("text and attributes are escaped", () => {
  assert.equal(
    escapeHtml(`<a href="x">'&'</a>`),
    "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
  );
});

test("script strings cannot close the script element or split a line", () => {
  const hostile = "</script><script>alert(1)</script>\u2028\u2029&";
  const literal = scriptString(hostile);
  assert.doesNotMatch(literal, /<\/script>/i);
  assert.doesNotMatch(literal, /[\u2028\u2029<>&]/);
  assert.equal(vm.runInNewContext(literal), hostile);
});

test("the consent page escapes everything it is given", () => {
  const html = consentPage({
    providerName: "Google",
    continueLabel: "Continue with Google",
    protocol: canonicalProtocol("google"),
    requestId: "r".repeat(43),
    browserNonce: "n".repeat(43),
    installationOrigin: 'https://nas.example"><img src=x onerror=alert(1)>',
    access: [{ label: "<b>Mail</b>", description: "Reads & sends" }],
    styleNonce: "style",
    scriptNonce: "script",
    links,
  });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;b&gt;Mail&lt;\/b&gt;/);
  assert.match(html, /Reads &amp; sends/);
  assert.equal((html.match(/<script/g) ?? []).length, 1);
  assert.match(html, /<script nonce="script">/);
  assert.match(html, /<style nonce="style">/);
  assert.match(html, /<title>Connect &lt;b&gt;Mail&lt;\/b&gt; · Genosyn Connect<\/title>/);
});

/** Runs the page's script against a fake window to prove the opener handshake. */
function runConsentScript(options: { opener: boolean }) {
  const requestId = "r".repeat(43);
  const html = consentPage({
    providerName: "Google",
    continueLabel: "Continue with Google",
    protocol: canonicalProtocol("google"),
    requestId,
    browserNonce: "n".repeat(43),
    installationOrigin: "https://nas.example",
    access: [],
    styleNonce: "s",
    scriptNonce: "j",
    links,
  });
  const source = /<script nonce="j">([\s\S]*?)<\/script>/.exec(html)![1];
  const elements = {
    "launch-status": { textContent: "", dataset: {} as Record<string, string> },
    "browser-proof": { value: "" },
    continue: { disabled: true },
  };
  const posted: Array<{ message: unknown; origin: string }> = [];
  const opener = options.opener
    ? { postMessage: (message: unknown, origin: string) => posted.push({ message, origin }) }
    : null;
  let listener: ((event: unknown) => void) | undefined;
  const timers: Array<() => void> = [];
  vm.runInNewContext(source, {
    document: { getElementById: (id: keyof typeof elements) => elements[id] },
    window: {
      opener,
      addEventListener: (_type: string, callback: (event: unknown) => void) =>
        (listener = callback),
    },
    setTimeout: (callback: () => void) => timers.push(callback),
    clearTimeout: () => timers.splice(0),
  });
  return { requestId, elements, posted, opener, listener, timers };
}

test("the consent page announces itself only to the installation and accepts its proof only from it", () => {
  const page = runConsentScript({ opener: true });
  // Objects built inside the sandbox have that realm's prototypes; compare their data.
  assert.deepEqual(JSON.parse(JSON.stringify(page.posted)), [
    {
      message: { source: "genosyn-sign-in-ready", requestId: page.requestId },
      origin: "https://nas.example",
    },
  ]);
  const proof = "p".repeat(43);
  const good = {
    source: page.opener,
    origin: "https://nas.example",
    data: { source: "genosyn-sign-in-launch", requestId: page.requestId, proof },
  };
  for (const forged of [
    { ...good, origin: "https://evil.example" },
    { ...good, source: {} },
    { ...good, data: { ...good.data, source: "genosyn-google-sign-in-launch" } },
    { ...good, data: { ...good.data, requestId: "x".repeat(43) } },
    { ...good, data: { ...good.data, proof: "short" } },
    { ...good, data: { ...good.data, proof: "bad proof with spaces".padEnd(43, "!") } },
    { ...good, data: null },
  ]) {
    page.listener!(forged);
    assert.equal(page.elements.continue.disabled, true);
    assert.equal(page.elements["browser-proof"].value, "");
  }
  page.listener!(good);
  assert.equal(page.elements.continue.disabled, false);
  assert.equal(page.elements["browser-proof"].value, proof);
  assert.equal(page.elements["launch-status"].dataset.tone, "ok");
  assert.equal(page.timers.length, 0, "the fallback warning was cancelled");
});

test("a consent page opened without its installation says so and stays disabled", () => {
  const page = runConsentScript({ opener: false });
  assert.equal(page.posted.length, 0);
  assert.equal(page.elements.continue.disabled, true);
  assert.equal(page.elements["launch-status"].dataset.tone, "error");
  assert.match(page.elements["launch-status"].textContent, /start again from there/);
});

test("a consent page whose opener never answers warns after a moment", () => {
  const page = runConsentScript({ opener: true });
  assert.equal(page.timers.length, 1);
  page.timers[0]();
  assert.equal(page.elements["launch-status"].dataset.tone, "error");
  assert.equal(page.elements.continue.disabled, true);
});

test("message and landing pages never script", () => {
  const error = messagePage({ title: "T", detail: "<d>", tone: "error", styleNonce: "s", links });
  assert.doesNotMatch(error, /<script/);
  assert.match(error, /class="tone-error"/);
  assert.match(error, /&lt;d&gt;/);
  const info = messagePage({
    title: "Page not found",
    detail: "d",
    tone: "info",
    styleNonce: "s",
    links,
  });
  assert.doesNotMatch(info, /<script|class="tone-/);
  const landing = landingPage({
    providers: [
      { name: "Google", products: ["Gmail"] },
      { name: "Unconfigured", products: [] },
    ],
    styleNonce: "s",
    links,
  });
  assert.match(landing, /<strong>Google<\/strong><span>Gmail<\/span>/);
  assert.doesNotMatch(landing, /Unconfigured/);
  assert.doesNotMatch(landing, /<script/);
  assert.match(
    landingPage({ providers: [], styleNonce: "s", links }),
    /No Integrations are available here yet/,
  );
});
