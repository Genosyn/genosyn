import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { withCodeBars } from "./chatMarkdown";
import { replyTabTitle } from "./chatTabTitle";

describe("the bar over a code block", () => {
  test("names the language and offers to copy", () => {
    const html = withCodeBars('<pre><code class="language-sql">select 1;\n</code></pre>');
    assert.match(html, /<div class="chat-md-code">/);
    assert.match(html, /<span class="chat-md-code-language">sql<\/span>/);
    assert.match(html, /data-copy-code/);
    assert.match(html, /<pre><code class="language-sql">select 1;\n<\/code><\/pre><\/div>$/);
  });

  test("a block with no language keeps the button", () => {
    const html = withCodeBars("<pre><code>plain\n</code></pre>");
    assert.match(html, /data-copy-code/);
    assert.ok(!html.includes("chat-md-code-language"));
  });

  test("leaves everything else, inline code included, as it was", () => {
    const html = "<p>Run <code>npm test</code> first.</p>";
    assert.equal(withCodeBars(html), html);
  });

  test("each block gets its own bar, and the code between them stays its own", () => {
    const html = withCodeBars(
      '<pre><code class="language-a">one</code></pre><p>and</p><pre><code>two</code></pre>',
    );
    assert.equal(html.match(/data-copy-code/g)?.length, 2);
    assert.match(html, /<p>and<\/p>/);
  });

  test("only a language shaped like one reaches the markup", () => {
    const html = withCodeBars('<pre><code class="language-x onload=alert(1)">one</code></pre>');
    assert.ok(!html.includes("chat-md-code-language"));
    assert.ok(!html.includes("data-copy-code"), "not a block this recognizes: left alone");
  });
});

describe("the browser tab while an AI Employee answers", () => {
  test("says it is working, and that a reply landed while nobody was looking", () => {
    const name = "Sam Flinch";
    assert.equal(
      replyTabTitle({ employeeName: name, working: true, readyWhileAway: false }),
      "Working · Sam Flinch",
    );
    assert.equal(
      replyTabTitle({ employeeName: name, working: false, readyWhileAway: true }),
      "Reply ready · Sam Flinch",
    );
    assert.equal(replyTabTitle({ employeeName: name, working: false, readyWhileAway: false }), null);
  });
});
