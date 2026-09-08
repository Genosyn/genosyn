import assert from "node:assert/strict";
import { test } from "node:test";
import {
  invitationAuthPath,
  invitationPath,
  invitationTokenFromPath,
  invitationTokenFromSearch,
} from "./invitationNavigation.js";

test("signup, login and verification can return to the same invitation", () => {
  const token = "a1b2c3d4";
  for (const page of ["login", "signup"] as const) {
    const authUrl = new URL(invitationAuthPath(page, token), "https://genosyn.example.test");
    assert.equal(authUrl.pathname, `/${page}`);
    const recovered = invitationTokenFromSearch(authUrl.search);
    assert.equal(recovered, token);
    assert.equal(invitationTokenFromPath(invitationPath(recovered)), token);
  }
});

test("continuation always names a local invitation path", () => {
  const token = "token/with?reserved=characters&plus+value";
  const destination = new URL(invitationPath(token), "https://genosyn.example.test");
  assert.equal(destination.origin, "https://genosyn.example.test");
  assert.equal(destination.search, "");
  assert.equal(invitationTokenFromPath(destination.pathname), token);
  const loginUrl = new URL(invitationAuthPath("login", token), destination.origin);
  assert.equal(invitationTokenFromSearch(loginUrl.search), token);
});

test("ordinary login keeps its usual destination and unusable tokens are ignored", () => {
  assert.equal(invitationPath(null), "/");
  assert.equal(invitationAuthPath("signup", null), "/signup");
  assert.equal(invitationTokenFromSearch("?unrelated=value"), null);
  assert.equal(invitationTokenFromSearch("?invitation="), null);
  assert.equal(invitationTokenFromSearch(`?invitation=${"a".repeat(513)}`), null);
  assert.equal(invitationTokenFromPath("/invite/%"), null);
  assert.equal(invitationTokenFromPath("/settings"), null);
});
