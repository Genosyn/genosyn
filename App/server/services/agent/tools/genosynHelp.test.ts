import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { createGenosynHelpSource } from "./genosynHelp.js";

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "genosyn-help-"));
  await mkdir(path.join(root, "App", "server"), { recursive: true });
  await writeFile(
    path.join(root, "App", "server", "feature.ts"),
    "export const helpSurface = true;\nsecond line\n",
  );
  await writeFile(path.join(root, "ROADMAP.md"), "# Roadmap\nHelp surface\n");
  await writeFile(
    path.join(root, "App", "config.ts"),
    'export const config = { sessionSecret: "instance-secret" };\n',
  );
  await writeFile(path.join(root, ".env.production"), "SECRET=environment-secret\n");
  await writeFile(path.join(root, "App", "vite.config.ts"), "export default {};\n");
  await writeFile(
    path.join(root, ".genosyn-help-manifest"),
    [
      "App/server/feature.ts",
      "App/config.ts",
      "App/vite.config.ts",
      ".env.production",
      "ROADMAP.md",
      "",
    ].join("\n"),
  );
  return root;
}

describe("Genosyn Help source tools", () => {
  test("list, search, and read the supplied source snapshot", async () => {
    const root = await fixture();
    const source = createGenosynHelpSource(root);
    const byName = new Map(source.tools.map((tool) => [tool.name, tool]));

    const listed = await byName.get("list_genosyn_source")!.run({ path: "App/server" });
    assert.equal(listed.isError, undefined);
    assert.match(listed.content, /feature\.ts/);

    const searched = await byName
      .get("search_genosyn_source")!
      .run({ query: "helpSurface", path: "App" });
    assert.equal(searched.isError, undefined);
    assert.match(searched.content, /App\/server\/feature\.ts:1/);

    const read = await byName
      .get("read_genosyn_source")!
      .run({ path: "App/server/feature.ts", offset: 2, limit: 1 });
    assert.equal(read.isError, undefined);
    assert.equal(read.content, "second line");
  });

  test("rejects traversal and symlinks outside the snapshot", async () => {
    const root = await fixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), "genosyn-help-outside-"));
    await writeFile(path.join(outside, "secret.txt"), "not part of Genosyn");
    await symlink(outside, path.join(root, "outside"));
    const read = createGenosynHelpSource(root).tools.find(
      (tool) => tool.name === "read_genosyn_source",
    )!;

    const traversal = await read.run({ path: "../secret.txt" });
    assert.equal(traversal.isError, true);
    assert.match(traversal.content, /escapes/);

    const linked = await read.run({ path: "outside/secret.txt" });
    assert.equal(linked.isError, true);
    assert.match(linked.content, /outside/);
  });

  test("never lists, reads, or searches secret-bearing configuration", async () => {
    const root = await fixture();
    await symlink(
      path.join(root, "App", "config.ts"),
      path.join(root, "App", "server", "linked.ts"),
    );
    const source = createGenosynHelpSource(root);
    const byName = new Map(source.tools.map((tool) => [tool.name, tool]));

    const listed = await byName.get("list_genosyn_source")!.run({ path: "App" });
    assert.equal(listed.isError, undefined);
    assert.doesNotMatch(listed.content, /(^|\n)config\.ts($|\n)/);
    assert.match(listed.content, /vite\.config\.ts/);

    for (const secretPath of ["App/config.ts", ".env.production", "App/server/linked.ts"]) {
      const read = await byName.get("read_genosyn_source")!.run({ path: secretPath });
      assert.equal(read.isError, true);
      assert.match(read.content, /unavailable|public release snapshot/);
    }

    const searched = await byName
      .get("search_genosyn_source")!
      .run({ query: "instance-secret", path: "." });
    assert.equal(searched.isError, undefined);
    assert.equal(searched.content, "(no matches)");

    const directSearch = await byName
      .get("search_genosyn_source")!
      .run({ query: "secret", path: "App/config.ts" });
    assert.equal(directSearch.isError, true);
    assert.match(directSearch.content, /unavailable|public release snapshot/);
  });

  test("never exposes data, live config, manifest, or unlisted files", async () => {
    const root = await fixture();
    await mkdir(path.join(root, "App", "data", "nested"), { recursive: true });
    await writeFile(path.join(root, "App", "data", ".instance-secrets.json"), "ROOT_SECRET");
    await writeFile(path.join(root, "App", "data", "nested", "token.txt"), "NESTED_SECRET");
    await writeFile(path.join(root, "App", "config.ts"), "encryptionSecret: 'CONFIG_SECRET'");
    await writeFile(path.join(root, "App", "server", "private.ts"), "UNTRACKED_SECRET");

    const source = createGenosynHelpSource(root);
    const byName = new Map(source.tools.map((tool) => [tool.name, tool]));
    const read = byName.get("read_genosyn_source")!;
    for (const requested of [
      "App/data/.instance-secrets.json",
      "App/data/nested/token.txt",
      "App/config.ts",
      ".genosyn-help-manifest",
      "App/server/private.ts",
    ]) {
      const result = await read.run({ path: requested });
      assert.equal(result.isError, true, requested);
      assert.doesNotMatch(
        result.content,
        /ROOT_SECRET|NESTED_SECRET|CONFIG_SECRET|UNTRACKED_SECRET/,
      );
    }

    const listed = await byName.get("list_genosyn_source")!.run({ path: "App" });
    assert.equal(listed.isError, undefined);
    assert.doesNotMatch(listed.content, /(^|\n)(?:data\/|config\.ts|private\.ts)($|\n)/);

    const search = await byName.get("search_genosyn_source")!.run({ query: "SECRET", path: "App" });
    assert.equal(search.isError, undefined);
    assert.equal(search.content, "(no matches)");
  });

  test("returns explicit errors when the release has no source snapshot", async () => {
    const source = createGenosynHelpSource(null);
    const result = await source.tools[0].run({});
    assert.equal(result.isError, true);
    assert.match(result.content, /not available/);
    assert.match(source.prompt, /does not contain/);
  });
});
