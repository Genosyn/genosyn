import assert from "node:assert/strict";
import { describe, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Route, Routes, StaticRouter } from "react-router-dom";

import { DialogProvider } from "../components/ui/Dialog.js";
import type { Company, Me } from "../lib/api.js";
import { SettingsCompany } from "./Settings.js";
import SettingsLayout from "./SettingsLayout.js";

/**
 * Settings → Company, as each kind of Member sees it: owners and admins get a
 * Time zone field showing the company's current choice, and everyone else gets
 * the page without it. Effects do not run in a server render, so this checks
 * what the first paint draws, which is what the form starts from.
 */

const h = React.createElement;

// `Select` measures its menu in a layout effect, which React warns does
// nothing on the server. True, beside the point here, and repeated for every
// render that draws one, so it would bury any warning that matters.
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

const me = {
  id: "me",
  email: "me@example.com",
  name: "Me",
  handle: null,
  avatarKey: null,
  isMasterAdmin: false,
  emailVerified: true,
  emailVerificationRequired: false,
} satisfies Me;

function renderCompany(company: Company): string {
  return renderToStaticMarkup(
    h(
      DialogProvider,
      null,
      h(
        StaticRouter,
        { location: "/c/acme/settings/company" },
        h(
          Routes,
          null,
          h(
            Route,
            {
              path: "/c/:companySlug/settings",
              element: h(SettingsLayout, { company, me, onCompaniesChanged: () => {} }),
            },
            h(Route, { path: "company", element: h(SettingsCompany) }),
          ),
        ),
      ),
    ),
  );
}

/** The combobox the field draws, with the value it currently shows. */
function timeZoneInput(html: string): string | null {
  const match = /<input[^>]*id="([^"]+)"[^>]*>/g;
  for (const input of html.matchAll(match)) {
    const id = input[1];
    if (new RegExp(`<label[^>]*for="${id}"[^>]*>Time zone</label>`).test(html)) {
      return /value="([^"]*)"/.exec(input[0])?.[1] ?? "";
    }
  }
  return null;
}

describe("Settings → Company time zone", () => {
  test("shows owners and admins the zone the company is on", () => {
    for (const role of ["owner", "admin"] as const) {
      const html = renderCompany({ ...owner, role, timezone: "Europe/Berlin" });
      assert.equal(timeZoneInput(html), "Europe/Berlin", role);
    }
  });

  test("reads Server time for a company that has not picked one, and says where the browser is", () => {
    for (const company of [owner, { ...owner, timezone: "" }]) {
      const html = renderCompany(company);
      assert.equal(timeZoneInput(html), "Server time");
      assert.match(html, /Your browser is in [A-Za-z_]+/);
    }
    // Once a zone is chosen the nudge goes away.
    assert.doesNotMatch(
      renderCompany({ ...owner, timezone: "Asia/Tokyo" }),
      /Your browser is in/,
    );
  });

  test("offers Server time first, then the zones by region", () => {
    const html = renderCompany({ ...owner, timezone: "Europe/Berlin" });
    assert.match(html, /<option value="">Server time<\/option>/);
    assert.match(html, /<optgroup label="Europe">/);
    assert.match(html, /<option value="Europe\/Berlin"[^>]*>Europe\/Berlin<\/option>/);
    assert.match(html, /<option value="America\/New_York"[^>]*>America\/New_York<\/option>/);
    assert.match(html, /<option value="UTC"[^>]*>UTC<\/option>/);
  });

  test("still offers a saved zone the browser's own list spells differently", () => {
    // Chrome lists `Asia/Calcutta`; the server accepts both spellings.
    const html = renderCompany({ ...owner, timezone: "Asia/Kolkata" });
    assert.equal(timeZoneInput(html), "Asia/Kolkata");
    assert.match(html, /<option value="Asia\/Kolkata"[^>]*>Asia\/Kolkata<\/option>/);
  });

  test("explains what the clock covers", () => {
    const html = renderCompany({ ...owner, timezone: "Europe/Berlin" });
    assert.match(html, /Routines run on this clock/);
    assert.match(html, /Pipelines and recurring invoices\s+always use server time/);
  });

  test("leaves it out for a plain Member, who cannot change it", () => {
    const html = renderCompany({ ...owner, role: "member", timezone: "Europe/Berlin" });
    assert.equal(timeZoneInput(html), null);
    assert.doesNotMatch(html, /Routines run on this clock/);
    // The rest of the page is still there.
    assert.match(html, /Mission/);
  });
});

describe("Settings → Company Advanced", () => {
  /**
   * The page's Advanced toggle button's own markup — not the Settings rail's
   * Advanced group beside it, which carries `data-rail-advanced`.
   */
  function advancedToggle(html: string): string | null {
    for (const match of html.matchAll(/<button\b[^>]*>(?:(?!<\/button>)[\s\S])*<\/button>/g)) {
      if (/>Advanced</.test(match[0]) && !/data-rail-advanced/.test(match[0])) return match[0];
    }
    return null;
  }

  /** The panel the toggle controls, from its opening tag on. */
  function advancedPanel(html: string): string | null {
    const id = /aria-controls="([^"]+)"/.exec(advancedToggle(html) ?? "")?.[1];
    if (!id) return null;
    const at = html.indexOf(`id="${id}"`);
    return at === -1 ? null : html.slice(html.lastIndexOf("<div", at));
  }

  test("tucks the web address and two-factor rule under one closed Advanced disclosure", () => {
    for (const role of ["owner", "admin"] as const) {
      const html = renderCompany({ ...owner, role });
      const toggle = advancedToggle(html);
      assert.ok(toggle, `${role}: there is an Advanced disclosure`);
      assert.match(toggle!, /aria-expanded="false"/, `${role}: closed by default`);
      const panel = advancedPanel(html);
      assert.ok(panel, `${role}: its panel is mounted, so the line can report it`);
      assert.match(panel!, /^<div[^>]*hidden=""/, `${role}: and hidden until opened`);
      assert.match(panel!, />Web address<\/label>/);
      assert.match(panel!, /Require two-factor authentication/);
    }
  });

  test("says what is set inside on its closed line", () => {
    assert.match(
      advancedToggle(renderCompany(owner)) ?? "",
      /Web address \/c\/acme · Two-factor sign-in optional/,
    );
    assert.match(
      advancedToggle(renderCompany({ ...owner, requireTwoFactor: true })) ?? "",
      /Web address \/c\/acme · Two-factor sign-in required/,
    );
  });

  test("keeps the basics up front, with no Slug label or data-directory note", () => {
    const html = renderCompany(owner);
    const panelAt = html.indexOf(advancedPanel(html) ?? "\u0000");
    for (const label of ["Name", "Mission", "Vision", "Time zone"]) {
      const at = html.search(new RegExp(`>${label}</label>`));
      assert.ok(at !== -1 && at < panelAt, `${label} sits before Advanced`);
    }
    assert.doesNotMatch(html, />Slug<\/label>/);
    assert.doesNotMatch(html, /data\/companies\//);
  });

  test("leaves Advanced out for a plain Member, who can change neither", () => {
    const html = renderCompany({ ...owner, role: "member" });
    assert.equal(advancedToggle(html), null);
    assert.doesNotMatch(html, /Web address/);
    assert.doesNotMatch(html, /Require two-factor authentication/);
  });
});
