import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { withDamagedEntry, zipOf } from "../test/zipFixtures.js";
import { readZipFile, ZipReadError } from "./zipFile.js";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("readZipFile", () => {
  let dir = "";

  before(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "genosyn-zip-"));
  });

  after(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  async function write(name: string, bytes: Buffer): Promise<string> {
    const abs = path.join(dir, name);
    await fs.promises.writeFile(abs, bytes);
    return abs;
  }

  test("lists the entries, and reads and extracts each", async () => {
    const abs = await write(
      "book.zip",
      await zipOf({ "chapters/one.txt": "first", "two.txt": "second" }),
    );
    const dest = path.join(dir, "two.txt");
    const read = await readZipFile(abs, async (zip) => {
      await zip.extract(zip.entries[1], dest, { mode: 0o600 });
      return {
        paths: zip.entries.map((entry) => entry.path),
        first: (await zip.read(zip.entries[0])).toString("utf8"),
      };
    });
    assert.deepEqual(read, { paths: ["chapters/one.txt", "two.txt"], first: "first" });
    assert.equal(await fs.promises.readFile(dest, "utf8"), "second");
    assert.equal((await fs.promises.stat(dest)).mode & 0o777, 0o600);
  });

  test("a file that goes missing once listed fails every read after, never the App", async () => {
    const abs = await write("gone.zip", await zipOf({ "one.txt": "first", "two.txt": "second" }));
    await readZipFile(abs, async (zip) => {
      fs.unlinkSync(abs);
      await assert.rejects(
        zip.read(zip.entries[0]),
        (err) => err instanceof ZipReadError && /ENOENT/.test(err.message),
      );
      await assert.rejects(zip.extract(zip.entries[1], path.join(dir, "two.txt")), ZipReadError);
    });
  });

  test("a damaged entry fails as unreadable, and a destination that can't be written as itself", async () => {
    const damaged = await write(
      "damaged.zip",
      withDamagedEntry(await zipOf({ "one.txt": "first" })),
    );
    await assert.rejects(
      readZipFile(damaged, async (zip) => zip.read(zip.entries[0])),
      ZipReadError,
    );

    const abs = await write("whole.zip", await zipOf({ "one.txt": "first" }));
    await readZipFile(abs, async (zip) => {
      const unwritable = path.join(dir, "no-such-folder", "one.txt");
      const failure = await zip.extract(zip.entries[0], unwritable).catch((err: unknown) => err);
      assert.ok(
        !(failure instanceof ZipReadError),
        "a destination's failure was blamed on the zip",
      );
      assert.equal((failure as NodeJS.ErrnoException).code, "ENOENT");
      // The zip itself still reads.
      assert.equal((await zip.read(zip.entries[0])).toString("utf8"), "first");
    });
  });

  test("an error on the archive's end once it has been read changes nothing", async (t) => {
    const abs = await write("tail.zip", await zipOf({ "one.txt": "first" }));
    const create = fs.createReadStream;
    const opened: fs.ReadStream[] = [];
    t.mock.method(fs, "createReadStream", (...args: Parameters<typeof create>) => {
      const stream = create(...args);
      opened.push(stream);
      return stream;
    });

    const listed = await readZipFile(abs, async (zip) => {
      // The first stream read the end of the central directory. unzipper
      // hands that one's errors to a parser that stopped listening once it
      // was read, so a disk error closing it would have thrown, uncaught.
      await new Promise<void>((resolve) =>
        setImmediate(() => {
          opened[0].emit(
            "error",
            Object.assign(new Error("EIO: i/o error, close"), { code: "EIO" }),
          );
          resolve();
        }),
      );
      return zip.entries.map((entry) => entry.path);
    });
    assert.deepEqual(listed, ["one.txt"]);
  });

  test("closes everything it opened before returning, however the read ended", async () => {
    const openFiles = () => fs.readdirSync("/dev/fd").length;
    const whole = await write(
      "whole.zip",
      await zipOf({ "one.txt": "first", "two.txt": "second" }),
    );
    // Too large to be read to its end before the damage stops the read.
    const damaged = await write(
      "damaged-large.zip",
      withDamagedEntry(await zipOf({ "noise.bin": randomBytes(4 << 20) })),
    );
    await readZipFile(whole, async (zip) => zip.entries);

    const before = openFiles();
    await readZipFile(whole, async (zip) => {
      for (const entry of zip.entries) await zip.read(entry);
    });
    await assert.rejects(
      readZipFile(damaged, async (zip) => zip.read(zip.entries[0])),
      ZipReadError,
    );
    await assert.rejects(
      readZipFile(whole, async (zip) => {
        fs.unlinkSync(whole);
        return zip.read(zip.entries[0]);
      }),
      ZipReadError,
    );
    assert.equal(openFiles(), before, "a read left a file open");
  });
});

function sources(dir: string): string[] {
  return fs.readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) return name === "node_modules" ? [] : sources(full);
    return /\.(?:ts|tsx|mjs)$/.test(name) ? [full] : [];
  });
}

test("unzipper is imported only here, and by Microsoft Ads for a report it holds in memory", () => {
  // An archive in memory has no file underneath to fail; one on disk is read
  // through readZipFile, so that nothing it opens can stop the App.
  const importers = sources(serverDir)
    .filter((file) => /^import\b[^;]*\bfrom "unzipper";/m.test(fs.readFileSync(file, "utf8")))
    .map((file) => path.relative(serverDir, file).split(path.sep).join("/"))
    .sort();
  assert.deepEqual(importers, ["integrations/providers/microsoft-ads.ts", "lib/zipFile.ts"]);
});
