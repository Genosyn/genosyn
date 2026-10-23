import assert from "node:assert/strict";
import { test } from "node:test";

import { apiKeyCurlExample, apiReferenceUrl, companyApiBaseUrl } from "./apiAccess";

const ID = "3f2b7c1e-8a4d-4c6b-9e1f-0a2b3c4d5e6f";

test("the base URL names the company's own path", () => {
  assert.equal(
    companyApiBaseUrl("https://genosyn.example", ID),
    `https://genosyn.example/api/companies/${ID}`,
  );
});

test("a trailing slash on the origin does not double up", () => {
  assert.equal(
    companyApiBaseUrl("http://192.168.1.20:8471/", ID),
    `http://192.168.1.20:8471/api/companies/${ID}`,
  );
  assert.equal(apiReferenceUrl("https://genosyn.example//"), "https://genosyn.example/api/docs");
});

test("an id is encoded, never interpreted as path", () => {
  assert.equal(
    companyApiBaseUrl("https://x.example", "a/b c"),
    "https://x.example/api/companies/a%2Fb%20c",
  );
});

test("the first request asks who the key acts as, with the real company and token", () => {
  const token = `gen_${"A".repeat(43)}`;
  assert.equal(
    apiKeyCurlExample("https://genosyn.example", ID, token),
    `curl -H "Authorization: Bearer ${token}" \\\n  https://genosyn.example/api/companies/${ID}/me`,
  );
});

test("the reference lives at /api/docs", () => {
  assert.equal(apiReferenceUrl("https://genosyn.example"), "https://genosyn.example/api/docs");
});
