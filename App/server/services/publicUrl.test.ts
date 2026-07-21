import assert from "node:assert/strict";
import test from "node:test";
import { defaultPublicUrl, normalizePublicUrl } from "./publicUrl.js";

test("normalizes a public URL to its origin", () => {
  assert.equal(normalizePublicUrl(" https://Genosyn.Example.com:8443/ "), "https://genosyn.example.com:8443");
  assert.equal(normalizePublicUrl("http://localhost:8471"), "http://localhost:8471");
});

test("rejects public URLs that are not plain http(s) origins", () => {
  assert.throws(() => normalizePublicUrl("ftp://example.com"), /http or https/);
  assert.throws(() => normalizePublicUrl("https://user:pass@example.com"), /credentials/);
  assert.throws(() => normalizePublicUrl("https://example.com/app"), /without a path/);
  assert.throws(() => normalizePublicUrl("https://example.com/?from=admin"), /without a path/);
});

test("defaults to the local server port", () => {
  assert.equal(defaultPublicUrl(), "http://localhost:8471");
});
