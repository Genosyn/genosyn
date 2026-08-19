import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { diffTotals, parseDiff } from "./parseDiff";

/**
 * The gutter numbers are the part worth pinning down. Everything else in the
 * diff view degrades gracefully when the parser is wrong, but a line number
 * that is off by one sends someone editing the wrong line of a real file.
 */

const MODIFIED = `diff --git a/src/app.ts b/src/app.ts
index 1c2d3e4..5f6a7b8 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -10,6 +10,7 @@ export function boot() {
   const app = express();
   app.use(json());
-  app.listen(3000);
+  app.listen(port);
+  logger.info("listening");
   return app;
 }
`;

describe("parseDiff", () => {
  test("numbers both sides of a modification independently", () => {
    const [file] = parseDiff(MODIFIED);
    assert.equal(file.path, "src/app.ts");
    assert.equal(file.status, "modified");
    assert.equal(file.additions, 2);
    assert.equal(file.deletions, 1);

    const [hunk] = file.hunks;
    assert.equal(hunk.heading, "export function boot() {");
    assert.deepEqual(
      hunk.lines.map((line) => [line.type, line.oldNumber, line.newNumber]),
      [
        ["context", 10, 10],
        ["context", 11, 11],
        ["remove", 12, null],
        ["add", null, 12],
        ["add", null, 13],
        ["context", 13, 14],
        ["context", 14, 15],
      ],
    );
  });

  test("does not append a phantom line for the patch's trailing newline", () => {
    const [file] = parseDiff(MODIFIED);
    assert.equal(file.hunks[0].lines.at(-1)?.content, "}");
  });

  test("reads an added file from its /dev/null pre-image", () => {
    const [file] = parseDiff(
      `diff --git a/NOTES.md b/NOTES.md
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/NOTES.md
@@ -0,0 +1,2 @@
+# Notes
+First line.
`,
    );
    assert.equal(file.status, "added");
    assert.equal(file.oldPath, null);
    assert.equal(file.newPath, "NOTES.md");
    assert.equal(file.additions, 2);
  });

  test("reads a deleted file", () => {
    const [file] = parseDiff(
      `diff --git a/old.txt b/old.txt
deleted file mode 100644
index e69de29..0000000
--- a/old.txt
+++ /dev/null
@@ -1,1 +0,0 @@
-gone
`,
    );
    assert.equal(file.status, "deleted");
    assert.equal(file.path, "old.txt");
    assert.equal(file.deletions, 1);
  });

  test("keeps both sides of a pure rename", () => {
    const [file] = parseDiff(
      `diff --git a/src/a.ts b/src/b.ts
similarity index 100%
rename from src/a.ts
rename to src/b.ts
`,
    );
    assert.equal(file.status, "renamed");
    assert.equal(file.oldPath, "src/a.ts");
    assert.equal(file.newPath, "src/b.ts");
    assert.equal(file.hunks.length, 0);
  });

  test("flags a binary file instead of inventing hunks for it", () => {
    const [file] = parseDiff(
      `diff --git a/logo.png b/logo.png
index 1111111..2222222 100644
Binary files a/logo.png and b/logo.png differ
`,
    );
    assert.equal(file.binary, true);
    assert.equal(file.hunks.length, 0);
  });

  test('"no newline at end of file" advances neither cursor', () => {
    const [file] = parseDiff(
      `diff --git a/x b/x
--- a/x
+++ b/x
@@ -1,2 +1,2 @@
 keep
-old
\\ No newline at end of file
+new
\\ No newline at end of file
`,
    );
    const numbered = file.hunks[0].lines.filter((line) => line.type !== "meta");
    assert.deepEqual(
      numbered.map((line) => [line.oldNumber, line.newNumber]),
      [
        [1, 1],
        [2, null],
        [null, 2],
      ],
    );
  });

  test("splits a multi-file patch and totals it", () => {
    const files = parseDiff(
      MODIFIED +
        `diff --git a/README.md b/README.md
index aaa..bbb 100644
--- a/README.md
+++ b/README.md
@@ -1,2 +1,2 @@
-# Old
+# New
 body
`,
    );
    assert.equal(files.length, 2);
    assert.deepEqual(
      files.map((file) => file.path),
      ["src/app.ts", "README.md"],
    );
    assert.deepEqual(diffTotals(files), { additions: 3, deletions: 2 });
  });

  test("survives a patch truncated mid-hunk", () => {
    const files = parseDiff(
      `diff --git a/big.ts b/big.ts
--- a/big.ts
+++ b/big.ts
@@ -1,4 +1,4 @@
 one
-two
+TWO`,
    );
    assert.equal(files.length, 1);
    assert.equal(files[0].hunks[0].lines.length, 3);
  });

  test("returns nothing for an empty patch", () => {
    assert.deepEqual(parseDiff(""), []);
  });
});
