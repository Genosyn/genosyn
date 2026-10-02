import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  minimumNodeMajor,
  nodeRequirementNote,
  repositoryNodeRequirement,
} from "./repositoryNodeVersion.js";

function checkout(files: Record<string, string>): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "node-version-"));
  for (const [name, body] of Object.entries(files))
    fs.writeFileSync(path.join(directory, name), body);
  return directory;
}

test("the lowest major a version or range accepts", () => {
  for (const [spec, major] of [
    [">=26", 26],
    [">= 26.0.0", 26],
    ["^26.1.0", 26],
    ["~26.2", 26],
    ["26.x", 26],
    ["v26.2.0", 26],
    ["26", 26],
    [">25", 26],
    [">25.1", 25],
    [">=20 <27", 20],
    ["^18 || ^20 || >=22", 18],
  ] as const) {
    assert.equal(minimumNodeMajor(spec), major, spec);
  }
  for (const alias of ["lts/*", "lts/iron", "node", ""]) {
    assert.equal(minimumNodeMajor(alias), null, alias);
  }
});

// 2026-10-02: the OneUptime repository requires Node 26, the Genosyn image
// ships Node 22, and an audit's work session could not run the repository's
// tests to show its canonical-tag fix worked.
test("a repository that needs a newer Node than the runtime is noticed", () => {
  const oneuptime = checkout({ "package.json": JSON.stringify({ engines: { node: ">=26" } }) });
  assert.deepEqual(repositoryNodeRequirement(oneuptime, 22), {
    major: 26,
    spec: ">=26",
    source: "package.json engines.node",
  });
  const nvmrc = checkout({ ".nvmrc": "v26.2.0\n" });
  assert.equal(repositoryNodeRequirement(nvmrc, 22)?.source, ".nvmrc");
  const nodeVersion = checkout({ ".node-version": "26\n" });
  assert.equal(repositoryNodeRequirement(nodeVersion, 22)?.major, 26);
});

test("a repository the runtime's Node satisfies, or that names no version, needs nothing", () => {
  assert.equal(
    repositoryNodeRequirement(
      checkout({ "package.json": JSON.stringify({ engines: { node: ">=18" } }) }),
      22,
    ),
    null,
  );
  assert.equal(repositoryNodeRequirement(checkout({ "package.json": "{}" }), 22), null);
  assert.equal(repositoryNodeRequirement(checkout({ ".nvmrc": "lts/*" }), 22), null);
  assert.equal(repositoryNodeRequirement(checkout({ "package.json": "not json" }), 22), null);
  assert.equal(repositoryNodeRequirement(checkout({}), 22), null);
  assert.equal(
    repositoryNodeRequirement(
      checkout({
        "package.json": JSON.stringify({ engines: { node: ">=18" } }),
        ".nvmrc": "26",
      }),
      22,
    ),
    null,
    "package.json engines decide before a stricter local .nvmrc",
  );
});

test("the note shows the exact npx form and forbids weakening the requirement", () => {
  const note = nodeRequirementNote({
    major: 26,
    spec: ">=26",
    source: "package.json engines.node",
  });
  assert.match(note, /^### Node version/);
  assert.match(note, /`npx -y -p node@26 -- npm test`/);
  assert.match(note, /Do not change the repository's Node requirement/);
  assert.match(note, new RegExp(`this environment runs Node ${process.versions.node}`));
});
