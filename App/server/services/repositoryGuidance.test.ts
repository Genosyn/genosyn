import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  AGENTS_GUIDE_CANDIDATES,
  AGENTS_GUIDE_FILENAME,
  MAX_AGENTS_GUIDE_BYTES,
  MAX_AGENTS_GUIDE_FILE_BYTES,
  MAX_SCOPED_GUIDANCE_CONTEXT_BYTES,
  readAgentsGuide,
  readContributorGuide,
  readContributorGuidesForPath,
  withRepositoryGuidance,
} from "./repositoryGuidance.js";

let checkout: string;
let scratch: string;
const prose = "# Contributor guide\n\nRun npm run lint before finishing.\n";

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-guidance-"));
  checkout = path.join(scratch, "checkout");
  fs.mkdirSync(checkout);
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

function write(relative: string, body: string | Buffer = prose): void {
  const absolute = path.join(checkout, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, body);
}

describe("contributor-guide discovery", () => {
  test("keeps the established exports and default filename", () => {
    assert.equal(AGENTS_GUIDE_FILENAME, "AGENTS.md");
    assert.deepEqual(AGENTS_GUIDE_CANDIDATES, [
      "AGENTS.md",
      "agents.md",
      "AGENT.md",
      "agent.md",
      "CLAUDE.md",
      "claude.md",
    ]);
    write("AGENTS.md");
    assert.equal(readAgentsGuide(checkout), prose);
  });

  for (const name of [
    "AGENTS.md",
    "agents.md",
    "AGENT.md",
    "agent.md",
    "CLAUDE.md",
    "claude.md",
    "Agents.md",
    "AGent.MD",
    "cLaUdE.Md",
  ]) {
    test(`discovers the actual spelling ${name}`, () => {
      write(name);
      assert.deepEqual(readContributorGuide(checkout), { name, body: prose });
    });
  }

  test("prefers a mixed-case plural guide to canonical singular and Claude guides", () => {
    write("Agents.MD", "plural instructions");
    write("AGENT.md", "singular instructions");
    write("CLAUDE.md", "Claude instructions");
    assert.deepEqual(readContributorGuide(checkout), {
      name: "Agents.MD",
      body: "plural instructions",
    });
  });

  test("prefers a singular guide to the Claude fallback", () => {
    write("agent.md", "singular instructions");
    write("CLAUDE.md", "Claude instructions");
    assert.equal(readContributorGuide(checkout)?.name, "agent.md");
  });

  for (const [names, expected] of [
    [["Agents.md", "agents.md", "AGENTS.md"], "AGENTS.md"],
    [["Agents.md", "agents.md"], "agents.md"],
    [["agents.MD", "AgEnTs.md", "Agents.md"], "AgEnTs.md"],
    [["Claude.md", "claude.md", "CLAUDE.md"], "CLAUDE.md"],
  ] as [string[], string][]) {
    test(`orders coexisting spelling variants as ${expected}`, (t) => {
      for (const name of names) write(name);
      // macOS may alias these names on disk. Supply the entries a Linux
      // checkout can have, and exercise real confined reads for the winner.
      const readdir = fs.readdirSync;
      t.mock.method(fs, "readdirSync", (...args: Parameters<typeof readdir>) => {
        if (String(args[0]) === fs.realpathSync(checkout)) return names;
        return readdir(...args);
      });
      assert.equal(readContributorGuide(checkout)?.name, expected);
    });
  }

  test("continues past unusable higher-priority candidates", () => {
    write("AGENTS.md", " \n\t\r\n");
    fs.mkdirSync(path.join(checkout, "AGENT.md"));
    write("CLAUDE.md", "fallback instructions");
    assert.deepEqual(readContributorGuide(checkout), {
      name: "CLAUDE.md",
      body: "fallback instructions",
    });
  });

  test("does not recurse or mistake similarly named documents for guides", () => {
    write("docs/AGENTS.md");
    write("README.md");
    write("AGENTS.md.backup");
    write("agents.markdown");
    assert.equal(readContributorGuide(checkout), null);
    assert.equal(readAgentsGuide(checkout), null);
  });

  test("reads fresh content and discovers a renamed guide on the next call", () => {
    write("AGENTS.md", "old instructions");
    assert.equal(readContributorGuide(checkout)?.body, "old instructions");
    write("AGENTS.md", "new instructions");
    assert.equal(readContributorGuide(checkout)?.body, "new instructions");
    fs.rmSync(path.join(checkout, "AGENTS.md"));
    write("agent.md", "replacement instructions");
    assert.deepEqual(readContributorGuide(checkout), {
      name: "agent.md",
      body: "replacement instructions",
    });
    fs.rmSync(path.join(checkout, "agent.md"));
    assert.equal(readContributorGuide(checkout), null);
  });
});

describe("bounded contributor-guide reads", () => {
  test("missing, empty, whitespace, and nonexistent checkouts are harmless", () => {
    assert.equal(readAgentsGuide(checkout), null);
    assert.equal(readContributorGuide(path.join(checkout, "missing")), null);
    write("AGENTS.md", "");
    assert.equal(readAgentsGuide(checkout), null);
    write("AGENTS.md", "\ufeff \r\n\t");
    assert.equal(readAgentsGuide(checkout), null);
  });

  test("keeps whitespace, line endings, a BOM, and Unicode in a nonempty guide", () => {
    const body = "\ufeff# Équipe 👩🏽‍💻\r\n\r\n  実行してください: npm run lint\r\n";
    write("AGENTS.md", body);
    assert.equal(readAgentsGuide(checkout), body);
  });

  test("refuses a directory, a dangling link, and a link to a regular file", () => {
    fs.mkdirSync(path.join(checkout, "AGENTS.md"));
    assert.equal(readAgentsGuide(checkout), null);
    fs.rmdirSync(path.join(checkout, "AGENTS.md"));
    fs.symlinkSync("missing.md", path.join(checkout, "AGENTS.md"));
    assert.equal(readAgentsGuide(checkout), null);
    fs.unlinkSync(path.join(checkout, "AGENTS.md"));
    write("guide.md");
    fs.symlinkSync("guide.md", path.join(checkout, "AGENTS.md"));
    assert.equal(readAgentsGuide(checkout), null);
  });

  for (const [description, contents] of [
    ["an early NUL byte", Buffer.from("# Guide\n\0binary")],
    [
      "a NUL beyond the first 8KB",
      Buffer.concat([Buffer.from("a".repeat(9000)), Buffer.from([0])]),
    ],
    ["malformed UTF-8", Buffer.from([0x23, 0x20, 0xff, 0xfe])],
  ] as [string, Buffer][]) {
    test(`refuses ${description} and tries the fallback`, () => {
      write("AGENTS.md", contents);
      write("agent.md");
      assert.equal(readAgentsGuide(checkout), null);
      assert.equal(readContributorGuide(checkout)?.name, "agent.md");
    });
  }

  test("handles unreadable files without failing the turn", (t) => {
    write("AGENTS.md");
    t.mock.method(fs, "openSync", () => {
      throw Object.assign(new Error("Permission denied"), { code: "EACCES" });
    });
    assert.equal(readAgentsGuide(checkout), null);
    assert.equal(readContributorGuide(checkout), null);
  });

  test("refuses files over the hard ceiling before allocating a read", (t) => {
    write("AGENTS.md", "x".repeat(MAX_AGENTS_GUIDE_FILE_BYTES + 1));
    const read = t.mock.method(fs, "readSync");
    assert.equal(readAgentsGuide(checkout), null);
    assert.equal(read.mock.calls.length, 0);
  });

  test("accepts a file exactly at the hard ceiling and bounds its excerpt", () => {
    write("AGENTS.md", "x".repeat(MAX_AGENTS_GUIDE_FILE_BYTES));
    const guide = readAgentsGuide(checkout);
    assert.ok(guide);
    assert.match(guide, /Truncated/);
    assert.ok(Buffer.byteLength(guide) < MAX_AGENTS_GUIDE_BYTES + 500);
  });

  test("handles short reads and closes the file descriptor", (t) => {
    write("AGENTS.md");
    const read = fs.readSync;
    const reader = t.mock.method(
      fs,
      "readSync",
      (fd: number, buffer: Buffer, offset: number, length: number, position: number) =>
        read(fd, buffer, offset, Math.min(length, 7), position),
    );
    const close = t.mock.method(fs, "closeSync");
    assert.equal(readAgentsGuide(checkout), prose);
    assert.ok(reader.mock.calls.length > 2);
    assert.equal(close.mock.calls.length, 1);
  });

  test("caps the read even if the file grows after its size check", (t) => {
    write("AGENTS.md", "short");
    const read = fs.readSync;
    let grew = false;
    t.mock.method(fs, "readSync", (...args: Parameters<typeof read>) => {
      if (!grew) {
        grew = true;
        fs.appendFileSync(
          path.join(checkout, "AGENTS.md"),
          "x".repeat(MAX_AGENTS_GUIDE_FILE_BYTES),
        );
      }
      return read(...args);
    });
    const close = t.mock.method(fs, "closeSync");
    assert.equal(readAgentsGuide(checkout), null);
    assert.equal(close.mock.calls.length, 1);
  });

  test("closes a descriptor when reading fails", (t) => {
    write("AGENTS.md");
    t.mock.method(fs, "readSync", () => {
      throw new Error("Read failed");
    });
    const close = t.mock.method(fs, "closeSync");
    assert.equal(readAgentsGuide(checkout), null);
    assert.equal(close.mock.calls.length, 1);
  });

  test("does not inline a stale file replaced while its descriptor opens", (t) => {
    write("AGENTS.md", "old instructions");
    const open = fs.openSync;
    let replaced = false;
    t.mock.method(fs, "openSync", (...args: Parameters<typeof open>) => {
      const handle = open(...args);
      if (!replaced) {
        replaced = true;
        fs.renameSync(path.join(checkout, "AGENTS.md"), path.join(checkout, "old.md"));
        write("AGENTS.md", "new instructions");
      }
      return handle;
    });
    assert.equal(readAgentsGuide(checkout), null);
    assert.equal(readAgentsGuide(checkout), "new instructions");
  });
});

describe("guide truncation and continuation", () => {
  test("does not truncate a guide exactly at the inline boundary", () => {
    const body = "a".repeat(MAX_AGENTS_GUIDE_BYTES);
    write("AGENTS.md", body);
    assert.equal(readAgentsGuide(checkout), body);
  });

  test("keeps whole lines and gives the precise next unread line", () => {
    write("AGENTS.md", "123456789\n".repeat(10));
    const guide = readAgentsGuide(checkout, "AGENTS.md", { maxInlineBytes: 25 });
    assert.ok(guide !== null, "a valid guide must remain readable when truncated");
    assert.ok(guide.startsWith("123456789\n123456789\n\n[Truncated."));
    assert.match(
      guide,
      /\[Truncated\. Read `AGENTS\.md` with `repository_read_file` for the rest\.\]/,
    );
    assert.match(guide, /path="AGENTS\.md", offset=3, limit=200/);
    assert.match(guide, /until the entire guide has been read/);
  });

  test("rereads a partially included first line from offset one", () => {
    write("AGENTS.md", "a".repeat(100));
    assert.match(
      readAgentsGuide(checkout, "AGENTS.md", { maxInlineBytes: 12 }) ?? "",
      /offset=1, limit=200/,
    );
  });

  test("never splits a multibyte character at the excerpt boundary", () => {
    write("AGENTS.md", "é".repeat(100));
    const body = readAgentsGuide(checkout, "AGENTS.md", { maxInlineBytes: 17 });
    assert.ok(body !== null, "a valid Unicode guide must remain readable when truncated");
    assert.ok(body.startsWith(`${"é".repeat(8)}\n\n[Truncated.`));
    assert.ok(!body.includes("\ufffd"));
  });

  test("preserves legitimate replacement characters in valid UTF-8", () => {
    write("AGENTS.md", "a\ufffdb");
    assert.ok(
      readAgentsGuide(checkout, "AGENTS.md", { maxInlineBytes: 4 })?.startsWith("a\ufffd\n\n"),
    );
  });

  test("uses the ordinary file tool and its checkout-relative reference", () => {
    write("agent.md", prose.repeat(100));
    const body = readContributorGuide(checkout, {
      readTool: "read_file",
      pathPrefix: "repositories/team",
      maxInlineBytes: 30,
    })?.body;
    assert.match(body ?? "", /Read `repositories\/team\/agent\.md` with `read_file`/);
    assert.match(body ?? "", /path="repositories\/team\/agent\.md", offset=3, limit=200/);
    assert.ok(!body?.includes("repository_read_file"));
  });

  test("uses only the bash surface when that is the available coding tool", () => {
    write("AGENTS.md", prose.repeat(100));
    const body = readContributorGuide(checkout, {
      readTool: "bash",
      pathPrefix: "repositories/team",
      maxInlineBytes: 30,
    })?.body;
    assert.match(body ?? "", /Read `repositories\/team\/AGENTS\.md` with `bash`/);
    assert.match(body ?? "", /from line 3 in bounded windows/);
    assert.ok(!body?.includes("read_file"));
  });

  test("clamps caller budgets and can preserve discovery with no excerpt", () => {
    write("AGENTS.md", "a".repeat(MAX_AGENTS_GUIDE_FILE_BYTES));
    for (const maxInlineBytes of [Infinity, NaN, MAX_AGENTS_GUIDE_FILE_BYTES]) {
      const guide = readContributorGuide(checkout, { maxInlineBytes });
      assert.ok(guide && Buffer.byteLength(guide.body) < MAX_AGENTS_GUIDE_BYTES + 500);
    }
    assert.deepEqual(readContributorGuide(checkout, { maxInlineBytes: 0 }), {
      name: "AGENTS.md",
      body: "",
    });
    assert.deepEqual(readContributorGuide(checkout, { maxInlineBytes: -2 }), {
      name: "AGENTS.md",
      body: "",
    });
  });
});

describe("confined ancestor guidance", () => {
  function scopedFixture(): void {
    write("AGENTS.md", "root instructions");
    write("docs/agent.md", "docs instructions");
    write("docs/team/Agents.MD", "team instructions");
    write("docs/team/draft.md", "draft");
    write("unrelated/AGENTS.md", "unrelated instructions");
  }

  test("loads only ancestors, in root-to-deep order, with scope paths", () => {
    scopedFixture();
    assert.deepEqual(readContributorGuidesForPath(checkout, "docs/team/draft.md"), [
      { name: "AGENTS.md", path: "AGENTS.md", body: "root instructions" },
      { name: "agent.md", path: "docs/agent.md", body: "docs instructions" },
      { name: "Agents.MD", path: "docs/team/Agents.MD", body: "team instructions" },
    ]);
  });

  test("handles a directory surface, root spellings, and a new file", () => {
    scopedFixture();
    assert.equal(
      readContributorGuidesForPath(checkout, "docs/team", { isDirectory: true }).length,
      3,
    );
    assert.equal(readContributorGuidesForPath(checkout, "docs/team/new/deeper/file.md").length, 3);
    for (const root of ["", ".", "/"]) {
      assert.deepEqual(readContributorGuidesForPath(checkout, root, { isDirectory: true }), [
        { name: "AGENTS.md", path: "AGENTS.md", body: "root instructions" },
      ]);
    }
  });

  test("applies fallback independently in each directory", () => {
    write("CLAUDE.md", "root instructions");
    write("docs/AGENTS.md", "\n\t");
    write("docs/AGENT.md", "docs instructions");
    assert.deepEqual(
      readContributorGuidesForPath(checkout, "docs/new.md").map((guide) => guide.path),
      ["CLAUDE.md", "docs/AGENT.md"],
    );
  });

  test("budgets the aggregate and preserves deeper paths requiring explicit reads", () => {
    let folder = "";
    for (let index = 0; index < 12; index += 1) {
      write(path.posix.join(folder, "AGENTS.md"), prose.repeat(200));
      folder = path.posix.join(folder, `dir${index}`);
    }
    const guides = readContributorGuidesForPath(checkout, `${folder}/draft.md`);
    assert.equal(guides.length, 12);
    assert.ok(
      guides.reduce((sum, guide) => sum + Buffer.byteLength(guide.body), 0) <=
        MAX_AGENTS_GUIDE_BYTES,
    );
    assert.ok(
      guides.at(-1)?.body === "",
      "deep scopes remain discoverable after the excerpt budget runs out",
    );
    assert.ok(guides.some((guide) => guide.body.includes("Truncated")));
    assert.equal(
      readContributorGuidesForPath(checkout, `${folder}/draft.md`, { maxTotalBytes: 0 }).length,
      12,
    );
  });

  test("scoped continuation references include the ancestor and coding prefix", () => {
    write("docs/agent.md", prose.repeat(100));
    const [guide] = readContributorGuidesForPath(checkout, "docs/new.md", {
      maxInlineBytes: 30,
      readTool: "read_file",
      pathPrefix: "repositories/team",
    });
    assert.equal(guide.path, "docs/agent.md");
    assert.match(guide.body, /path="repositories\/team\/docs\/agent\.md"/);
  });

  test("does not read a guide above the supplied checkout", () => {
    fs.writeFileSync(path.join(scratch, "AGENTS.md"), "outside instructions");
    write("docs/draft.md");
    assert.deepEqual(readContributorGuidesForPath(checkout, "docs/draft.md"), []);
  });

  test("rejects escaped, private, ambiguous, and excessive paths", () => {
    scopedFixture();
    for (const candidate of [
      "../other.md",
      "docs/../other.md",
      "docs//file.md",
      ".git/config",
      ".GIT/config",
      ".ssh/key",
      "docs\0/file.md",
      "docs\\file.md",
      "x".repeat(1001),
    ]) {
      assert.equal(readAgentsGuide(checkout, candidate), null, candidate);
      assert.deepEqual(readContributorGuidesForPath(checkout, candidate), [], candidate);
    }
  });

  test("does not follow a guide or ancestor symlink outside the checkout", () => {
    fs.writeFileSync(path.join(scratch, "AGENTS.md"), "outside instructions");
    fs.symlinkSync(path.join(scratch, "AGENTS.md"), path.join(checkout, "AGENTS.md"));
    assert.equal(readContributorGuide(checkout), null);
    fs.symlinkSync(scratch, path.join(checkout, "linked"));
    assert.deepEqual(readContributorGuidesForPath(checkout, "linked/draft.md"), []);
    assert.equal(readAgentsGuide(checkout, "linked/AGENTS.md"), null);
  });

  test("does not follow an internal symlink to private Git files or another scope", () => {
    write(".git/AGENTS.md", "private instructions");
    write("docs/AGENTS.md", "other scope instructions");
    fs.symlinkSync(".git/AGENTS.md", path.join(checkout, "AGENTS.md"));
    assert.equal(readContributorGuide(checkout), null);
    fs.symlinkSync("docs", path.join(checkout, "alias"));
    assert.deepEqual(readContributorGuidesForPath(checkout, "alias/draft.md"), []);
  });

  test("refreshes nested guide edits, removals, and new guidance", () => {
    scopedFixture();
    assert.equal(readContributorGuidesForPath(checkout, "docs/team/draft.md").length, 3);
    write("docs/agent.md", "updated instructions");
    fs.rmSync(path.join(checkout, "docs/team/Agents.MD"));
    write("docs/team/CLAUDE.md", "new instructions");
    const guides = readContributorGuidesForPath(checkout, "docs/team/draft.md");
    assert.equal(guides[1].body, "updated instructions");
    assert.equal(guides[2].body, "new instructions");
    assert.equal(guides[2].path, "docs/team/CLAUDE.md");
  });
});

describe("guidance in repository tool responses", () => {
  test("preserves an ordinary read unchanged when no guide applies", () => {
    const numbered =
      "   1\tOriginal contents\n\n[Lines 1–1 of 2. Call again with offset=2 to continue.]";
    assert.equal(withRepositoryGuidance(checkout, "draft.md", numbered), numbered);
  });

  test("does not duplicate the requested guide, including repository-root path spellings", () => {
    write("AGENTS.md", "Root instructions");
    const numbered = "   1\tRoot instructions";
    for (const filePath of ["AGENTS.md", "./AGENTS.md", "/AGENTS.md"]) {
      assert.equal(withRepositoryGuidance(checkout, filePath, numbered), numbered);
    }
  });

  test("reserves a full numbered read and its continuation when many large guides apply", () => {
    let folder = "";
    for (let index = 0; index < 10; index += 1) {
      write(path.posix.join(folder, "AGENTS.md"), prose.repeat(200));
      folder = path.posix.join(folder, `dir${index}`);
    }
    const numbered = `${"   1\tRequested content\n".repeat(2100)}\n[Lines 1–2100 of 3000. Call again with offset=2101 to continue.]`;
    const result = withRepositoryGuidance(checkout, `${folder}/draft.md`, numbered);
    assert.ok(result.endsWith(numbered));
    assert.ok(
      Buffer.byteLength(result) - Buffer.byteLength(numbered) <= MAX_SCOPED_GUIDANCE_CONTEXT_BYTES,
    );
    assert.ok(
      result.length < 60_000,
      "guidance must not push the read past the default model tool-result ceiling",
    );
    assert.match(result, /deeper guidance takes precedence/);
    assert.match(result, /Truncated/);
    assert.match(result, /Read `dir0\/dir1\/AGENTS.md` with `repository_read_file`/);
    assert.ok(result.endsWith("offset=2101 to continue.]"));
  });

  test("counts long scope names and defers remaining ancestor reads explicitly", () => {
    let folder = "";
    for (let index = 0; index < 9; index += 1) {
      write(path.posix.join(folder, "AGENT.md"), "Scoped convention.");
      if (index < 8) folder = path.posix.join(folder, `${"a".repeat(100)}${index}`);
    }
    const numbered = "   1\tRequested content";
    const result = withRepositoryGuidance(checkout, `${folder}/draft.md`, numbered);
    assert.ok(result.endsWith(numbered));
    assert.ok(
      Buffer.byteLength(result) - Buffer.byteLength(numbered) <= MAX_SCOPED_GUIDANCE_CONTEXT_BYTES,
    );
    assert.match(result, /Additional ancestor guides were deferred/);
    assert.match(result, /use `repository_list_files` on its ancestor directories/);
    assert.match(result, /Deeper guides still apply within their scope/);
  });

  test("measures multibyte guide bodies against the response budget in bytes", () => {
    let folder = "";
    for (let index = 0; index < 8; index += 1) {
      write(path.posix.join(folder, "AGENTS.md"), "検証を実行してください。\n".repeat(1000));
      folder = path.posix.join(folder, `資料${index}`);
    }
    const numbered = "   1\tRequested content";
    const result = withRepositoryGuidance(checkout, `${folder}/draft.md`, numbered);
    assert.ok(result.endsWith(numbered));
    assert.ok(
      Buffer.byteLength(result) - Buffer.byteLength(numbered) <= MAX_SCOPED_GUIDANCE_CONTEXT_BYTES,
    );
    assert.ok(!result.includes("\ufffd"));
  });
});
