import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter, Route, Routes } from "react-router-dom";
import Invite from "./Invite.js";

function invitationPage(authenticated: boolean): string {
  return renderToStaticMarkup(
    React.createElement(
      StaticRouter,
      { location: "/invite/invitation-token" },
      React.createElement(
        Routes,
        null,
        React.createElement(Route, {
          path: "/invite/:token",
          element: React.createElement(Invite, { authenticated }),
        }),
      ),
    ),
  );
}

test("a signed-out invitee can register or sign in without losing the invitation", () => {
  const html = invitationPage(false);
  assert.match(html, /href="\/signup\?invitation=invitation-token"/);
  assert.match(html, /href="\/login\?invitation=invitation-token"/);
  assert.match(html, /email address that received this invitation/);
  assert.doesNotMatch(html, /<button/);
});

test("a signed-in invitee still explicitly accepts before joining", () => {
  const html = invitationPage(true);
  assert.match(html, /<button[^>]*>Accept invitation<\/button>/);
  assert.doesNotMatch(html, /href="\/signup/);
});
