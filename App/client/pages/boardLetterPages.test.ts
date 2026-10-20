import assert from "node:assert/strict";
import { describe, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Route, Routes, StaticRouter } from "react-router-dom";

import { DialogProvider } from "../components/ui/Dialog.js";
import type { Company } from "../lib/api.js";
import { canOpenSubpage, subpageAt } from "../lib/subpages.js";
import BoardLetterPage from "./BoardLetter.js";
import BoardLettersPage from "./BoardLetters.js";
import TldrsLayout from "./TldrsLayout.js";

/**
 * Letters to the board, reached by anyone. The server answers a Member's
 * every letter request with 403, so the pages must not even mount for one:
 * a Member gets a note, and the rail never offers the link. Owners and admins
 * get the page, loading. Effects do not run in a server render, so what is
 * checked is whether the part of the page that loads data mounted at all.
 */

const h = React.createElement;

const consoleError = console.error.bind(console);
mock.method(console, "error", (...args: unknown[]) => {
  if (String(args[0]).includes("useLayoutEffect does nothing on the server")) return;
  consoleError(...args);
});

const owner = {
  id: "company",
  slug: "acme",
  name: "Acme",
  mission: "",
  vision: "",
  role: "owner",
  financeAccess: "full",
  requireTwoFactor: false,
} satisfies Company;
const admin = { ...owner, role: "admin" } satisfies Company;
const member = { ...owner, role: "member" } satisfies Company;
const memberWithFinance = { ...member, financeAccess: "full" } satisfies Company;

const NOTE = "Only owners and admins read the letters";

function decode(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
}

function render(at: string, company: Company): string {
  return decode(
    renderToStaticMarkup(
      h(
        DialogProvider,
        null,
        h(
          StaticRouter,
          { location: `/c/acme/${at}` },
          h(
            Routes,
            null,
            h(
              Route,
              { path: "/c/:companySlug/tldrs", element: h(TldrsLayout, { company }) },
              h(Route, { path: "letters", element: h(BoardLettersPage) }),
              h(Route, { path: "letters/:number", element: h(BoardLetterPage) }),
            ),
          ),
        ),
      ),
    ),
  );
}

function main(html: string): string {
  const match = /<main\b[\s\S]*<\/main>/.exec(html);
  assert.ok(match, "the layout must render a main pane");
  return match[0];
}

const loading = (html: string) => /\banimate-spin\b/.test(html);

describe("letters to the board", () => {
  test("are owner and admin pages in the catalogue", () => {
    assert.deepEqual(subpageAt("/tldrs/letters").access, { admin: true });
    assert.equal(canOpenSubpage(subpageAt("/tldrs/letters"), memberWithFinance), false);
  });

  test("give a Member a note in place of the list and the letter, Finance access or not", () => {
    for (const company of [member, memberWithFinance]) {
      for (const at of ["tldrs/letters", "tldrs/letters/3"]) {
        const html = main(render(at, company));
        assert.ok(html.includes(NOTE), `${at} for ${company.role}`);
        assert.equal(loading(html), false, `${at} loads nothing for a Member`);
        assert.equal(html.includes("Written by"), false);
      }
    }
  });

  test("open for owners and admins, loading", () => {
    for (const company of [owner, admin]) {
      const list = main(render("tldrs/letters", company));
      assert.equal(list.includes(NOTE), false);
      assert.ok(list.includes("Letters to the board"));
      assert.ok(loading(list));
      const letter = main(render("tldrs/letters/3", company));
      assert.equal(letter.includes(NOTE), false);
      assert.ok(letter.includes("No. 3"));
      assert.ok(loading(letter));
    }
  });

  test("appear in the rail only for those who can open them", () => {
    const link = 'href="/c/acme/tldrs/letters"';
    assert.ok(render("tldrs/letters", owner).includes(link));
    assert.ok(render("tldrs/letters", admin).includes(link));
    assert.equal(render("tldrs/letters", member).includes(link), false);
  });
});
