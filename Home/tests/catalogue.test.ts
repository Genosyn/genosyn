import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { DOCS_FLAT, DOCS_NAV, findPageMeta } from "../client/docs/nav.js";
import { PRODUCT_CATEGORIES, PRODUCTS, findProduct } from "../client/products/data.js";
import { ROLES, ROLE_DISCIPLINES, findRole } from "../client/roles/data.js";
import { SHOWCASE_USE_CASES, getUseCasesForProduct } from "../client/products/useCases.js";
import * as VISION from "../client/vision/data.js";

type SiteMetaModule = typeof import("../client/lib/siteMeta.js");
let siteMeta: SiteMetaModule;

before(async () => {
  (globalThis as typeof globalThis & { __APP_VERSION__: string }).__APP_VERSION__ = "9.9.9-test";
  siteMeta = await import("../client/lib/siteMeta.js");
});

describe("product catalogue", () => {
  test("has unique stable slugs and complete card/page copy", () => {
    assert.ok(PRODUCTS.length >= 14, `expected the full product suite, got ${PRODUCTS.length}`);
    assert.equal(new Set(PRODUCTS.map((product) => product.slug)).size, PRODUCTS.length);
    for (const product of PRODUCTS) {
      assert.match(product.slug, /^[a-z][a-z0-9-]*$/);
      assert.equal(findProduct(product.slug), product);
      assert.ok(PRODUCT_CATEGORIES.includes(product.category), `${product.slug}: bad category`);
      for (const value of [
        product.name,
        product.tagline,
        product.taglineAccent,
        product.summary,
        product.seoTitle,
        product.description,
        product.intro,
        product.employees.heading,
        product.employees.body,
      ]) {
        assert.ok(value.trim(), `${product.slug}: empty copy`);
      }
      assert.ok(product.checks.length >= 3, `${product.slug}: too few hero checks`);
      assert.ok(product.features.length >= 3, `${product.slug}: too few features`);
      assert.ok(
        product.employees.bullets.length >= 2,
        `${product.slug}: too few employee examples`,
      );
      assert.ok(product.faqs.length >= 2, `${product.slug}: too few FAQs`);
      assert.ok(product.keywords.length > 0, `${product.slug}: no search terms`);
      assert.equal(new Set(product.keywords).size, product.keywords.length);
    }
    assert.equal(findProduct("missing-product"), undefined);
  });

  test("points product documentation links at real docs pages", () => {
    const docs = new Set(DOCS_FLAT.map((page) => page.path));
    for (const product of PRODUCTS) {
      if (product.docsPath) {
        assert.ok(docs.has(product.docsPath), `${product.slug}: missing ${product.docsPath}`);
      }
    }
  });

  test("shows concrete team use cases on every product page", () => {
    for (const product of PRODUCTS) {
      assert.ok(
        getUseCasesForProduct(product.slug).length >= 3,
        `${product.slug}: too few use cases`,
      );
    }
    for (const role of [
      "Sales Development Rep",
      "Software Engineer",
      "Customer Support Specialist",
    ]) {
      assert.ok(
        SHOWCASE_USE_CASES.some((useCase) => useCase.role === role),
        `${role}: missing from homepage showcase`,
      );
    }
  });
});

describe("role catalogue", () => {
  test("has unique stable slugs and complete page copy", () => {
    assert.ok(ROLES.length >= 6, `expected a full roster, got ${ROLES.length}`);
    assert.equal(new Set(ROLES.map((role) => role.slug)).size, ROLES.length);
    assert.equal(new Set(ROLES.map((role) => role.person)).size, ROLES.length);
    for (const role of ROLES) {
      assert.match(role.slug, /^[a-z][a-z0-9-]*$/);
      assert.equal(findRole(role.slug), role);
      assert.ok(ROLE_DISCIPLINES.includes(role.discipline), `${role.slug}: bad discipline`);
      for (const value of [
        role.name,
        role.short,
        role.noun,
        role.person,
        role.headline,
        role.headlineMuted,
        role.summary,
        role.seoTitle,
        role.description,
        role.intro,
        role.reclaims,
        role.shipped,
      ]) {
        assert.ok(value.trim(), `${role.slug}: empty copy`);
      }
      assert.ok(role.capabilities.length >= 3, `${role.slug}: too few capabilities`);
      assert.ok(role.faqs.length >= 2, `${role.slug}: too few FAQs`);
      assert.ok(role.outputs.length >= 2, `${role.slug}: too few outputs`);
      assert.ok(role.decisions.length >= 1, `${role.slug}: no escalated decisions`);
      assert.ok(role.skills.length >= 3, `${role.slug}: too few Skills`);
      assert.ok(role.routines.length >= 3, `${role.slug}: too few Routines`);
      assert.ok(role.grants.length >= 2, `${role.slug}: too few Grants`);
      assert.equal(new Set(role.keywords).size, role.keywords.length);
    }
    assert.equal(findRole("missing-role"), undefined);
  });

  // The day is the page. A schedule that is not in order, or that never stops
  // for a human, is the version of this claim nobody believes.
  test("tells a whole working day, in order, with at least one escalation", () => {
    for (const role of ROLES) {
      assert.ok(role.day.length >= 6, `${role.slug}: too few hours in the day`);
      const times = role.day.map((moment) => moment.at);
      assert.deepEqual(times, [...times].sort((a, b) => a - b), `${role.slug}: day is out of order`);
      assert.equal(new Set(role.day.map((m) => m.time)).size, role.day.length);
      for (const moment of role.day) {
        assert.match(moment.time, /^\d{2}:\d{2}$/, `${role.slug}: ${moment.time} is not a clock`);
        assert.ok(moment.at >= 0 && moment.at < 24, `${role.slug}: ${moment.time} is off the clock`);
        assert.ok(moment.title.trim() && moment.body.trim() && moment.where.trim());
      }
      assert.ok(
        role.day.some((moment) => moment.kind === "decision" || moment.kind === "approval"),
        `${role.slug}: a day with nothing escalated`,
      );
    }
  });

  // AGENTS.md §3 draws two lines this registry is uniquely placed to cross,
  // because it is a wall of new product prose written in one sitting. A
  // Decision is the employee choosing to ask and performs no side effect, so
  // labelling one "approve / reject" collapses it into an Approval; and
  // "Pipeline" belongs to the M10 DAG primitive, so a Routine card carrying
  // that word is the one place a reader could genuinely confuse the two.
  test("keeps Decisions and Approvals apart, and leaves Pipeline to M10", () => {
    for (const role of ROLES) {
      for (const decision of role.decisions) {
        assert.doesNotMatch(
          decision,
          /\b(approve|approved|approval|reject|rejected)\b/i,
          `${role.slug}: a Decision phrased as an Approval — "${decision}"`,
        );
      }
      for (const routine of role.routines) {
        assert.doesNotMatch(
          routine.name,
          /\bpipelines?\b/i,
          `${role.slug}: Routine "${routine.name}" borrows the Pipelines noun`,
        );
      }
    }
  });

  test("only claims products that exist", () => {
    for (const role of ROLES) {
      assert.ok(role.products.length >= 2, `${role.slug}: too few products`);
      for (const slug of role.products) {
        assert.ok(findProduct(slug), `${role.slug}: unknown product ${slug}`);
      }
    }
  });
});

// The vision page is a story about the future, which is exactly why its
// arithmetic and its vocabulary are checked: a vision that does not add up, or
// that quietly renames the product's nouns, undermines the pages that are true.
describe("vision", () => {
  const { LETTERS } = VISION;

  test("tells the letters in order, and keeps the Goal's arithmetic", () => {
    const numbers = LETTERS.map((letter) => letter.number);
    assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b));
    assert.equal(new Set(numbers).size, numbers.length);
    // The Goal starts counting at the first letter with a year behind it, and
    // every later letter should sit on (roughly) 40% a year from there.
    const base = LETTERS.find((letter) => letter.number === 12);
    assert.ok(base, "no year-one letter to compound from");
    for (const letter of LETTERS.filter((item) => item.number > base.number)) {
      const years = (letter.number - base.number) / 12;
      const rate = Math.pow(letter.revenue / base.revenue, 1 / years) - 1;
      assert.ok(rate > 0.38 && rate < 0.45, `No. ${letter.number} implies ${(rate * 100).toFixed(1)}% a year`);
      assert.ok(letter.growth !== null && letter.growth >= 0.38, `No. ${letter.number}: growth off the Goal`);
    }
    for (const letter of LETTERS) {
      assert.ok(letter.body.length >= 2, `No. ${letter.number}: too short`);
      assert.ok(letter.decidedWithoutYou > 0);
    }
  });

  // The vision is a company that runs itself, so the board is asked rarely: a
  // board with a question in every letter is a manager by another name.
  test("asks the board rarely, and only as choices, never approvals", () => {
    const decisions = LETTERS.flatMap((letter) => (letter.decision ? [letter.decision] : []));
    assert.ok(decisions.length >= 1, "no letter shows what an owner is still asked");
    assert.ok(
      decisions.length <= Math.floor(LETTERS.length / 2),
      `${decisions.length} of ${LETTERS.length} letters ask the board something`,
    );
    for (const decision of decisions) {
      assert.ok(decision.options.length >= 2 && decision.options.length <= 4);
      for (const text of [decision.question, ...decision.options.map((option) => option.label)]) {
        assert.doesNotMatch(
          text,
          /\b(approve|approved|approval|reject|rejected)\b/i,
          `a board Decision phrased as an Approval — "${text}"`,
        );
      }
    }
  });

  test("uses the product's nouns, and links only to real docs", () => {
    const copy = JSON.stringify(VISION);
    assert.doesNotMatch(copy, /\b(agents?|bots?|assistants?|tasks?|pipelines?|OKRs?|KPIs?)\b/i);
    const docs = new Set(DOCS_FLAT.map((page) => page.path));
    for (const keep of VISION.BOARD_KEEPS) {
      if (keep.docsPath) assert.ok(docs.has(keep.docsPath), `${keep.name}: ${keep.docsPath}`);
    }
    for (const stage of VISION.ROAD) {
      for (const item of stage.items) {
        if (item.href) assert.ok(docs.has(item.href), `${item.label}: ${item.href}`);
      }
    }
  });
});

describe("documentation navigation", () => {
  test("has unique section labels and unique canonical page paths", () => {
    assert.equal(new Set(DOCS_NAV.map((section) => section.label)).size, DOCS_NAV.length);
    assert.equal(new Set(DOCS_FLAT.map((page) => page.path)).size, DOCS_FLAT.length);
    assert.equal(DOCS_FLAT[0]?.path, "/docs");
    for (const section of DOCS_NAV) {
      assert.ok(section.label.trim());
      assert.ok(section.pages.length > 0, `${section.label} is empty`);
      for (const page of section.pages) {
        assert.match(page.path, /^\/docs(?:\/[a-z0-9-]+)?$/);
        assert.ok(page.title.trim());
        assert.ok(page.blurb?.trim(), `${page.path} has no navigation summary`);
        assert.equal(findPageMeta(page.path), page);
      }
    }
    assert.equal(findPageMeta("/docs/not-real"), undefined);
  });
});

describe("route metadata and LLM indexes", () => {
  test("registers every role, product and docs route exactly once", () => {
    const routes = siteMeta.allRoutes();
    const paths = routes.map((route) => route.path);
    assert.equal(new Set(paths).size, paths.length);
    assert.equal(
      routes.length,
      4 + PRODUCTS.length + ROLES.length + DOCS_FLAT.length,
      "home + vision + products + roles + generated product/role/docs routes",
    );
    for (const path of [
      "/",
      "/vision",
      "/products",
      "/roles",
      ...PRODUCTS.map((product) => `/products/${product.slug}`),
      ...ROLES.map((role) => `/roles/${role.slug}`),
      ...DOCS_FLAT.map((page) => page.path),
    ]) {
      const route = siteMeta.findRouteHead(`${path === "/" ? "" : path}/`);
      assert.equal(route?.path, path);
      assert.ok(route?.title.trim(), `${path}: no title`);
      assert.ok(route?.description.trim(), `${path}: no description`);
      assert.ok(route?.jsonLd.length, `${path}: no structured data`);
    }
    assert.equal(siteMeta.findRouteHead("/not-real"), undefined);
  });

  test("does not sell the eight worked roles as the whole roster", () => {
    const hub = siteMeta.findRouteHead("/roles");
    assert.ok(hub, "/roles is not registered");
    for (const text of [hub.description, siteMeta.llmsTxt()]) {
      assert.doesNotMatch(
        text,
        /every role Genosyn ships with/i,
        "the roles hub claims an exhaustive roster it does not have",
      );
    }
  });

  test("puts the build version into homepage structured data", () => {
    const home = siteMeta.findRouteHead("/");
    assert.match(JSON.stringify(home?.jsonLd), /9\.9\.9-test/);
  });

  test("the /products snippet names every product it links to", () => {
    const products = siteMeta.findRouteHead("/products");
    for (const product of PRODUCTS) {
      assert.ok(
        products?.description.includes(product.name),
        `/products description omits ${product.name}`,
      );
    }
  });

  // Both hero previews are pictures of the product, not real UI, and both are
  // mounted inside the page's own <main>. A <main> of their own is an HTML
  // conformance error and leaves screen readers two "main" regions to choose
  // between. (Their other landmark elements are fine — each preview keeps its
  // mock chrome under an aria-hidden wrapper.)
  test("hero preview mocks never render a nested <main>", () => {
    for (const file of [
      "../client/sections/CompanyPreview.tsx",
      "../client/products/ProductPrototype.tsx",
    ]) {
      const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      assert.doesNotMatch(code, /<main[\s>]/, `${file}: renders a <main> inside the page <main>`);
    }
  });

  test("every product hero docs CTA points at a real docs page", () => {
    const docsPaths = new Set(DOCS_FLAT.map((page) => page.path));
    for (const product of PRODUCTS) {
      if (product.docsPath === null) continue;
      assert.ok(
        docsPaths.has(product.docsPath),
        `${product.slug}: docsPath ${product.docsPath} is not a docs page`,
      );
    }
  });

  test("the compact LLM index links every role, product and docs page", () => {
    const text = siteMeta.llmsTxt();
    assert.match(text, /^# Genosyn/m);
    assert.doesNotMatch(text, /\bundefined\b/);
    assert.ok(text.includes("https://genosyn.com/vision"), "/vision");
    for (const role of ROLES) {
      assert.match(text, new RegExp(`https://genosyn\\.com/roles/${role.slug}`));
    }
    for (const product of PRODUCTS) {
      assert.match(text, new RegExp(`https://genosyn\\.com/products/${product.slug}`));
    }
    for (const page of DOCS_FLAT) {
      assert.ok(text.includes(`https://genosyn.com${page.path}`), page.path);
    }
  });

  test("the full LLM reference includes every role, product, capability list, and FAQ", () => {
    const text = siteMeta.llmsFullTxt();
    assert.doesNotMatch(text, /\bundefined\b/);
    for (const role of ROLES) {
      assert.ok(text.includes(`## Role: ${role.name} (`), role.slug);
      assert.ok(text.includes(role.intro), role.slug);
      for (const moment of role.day) assert.ok(text.includes(moment.title), role.slug);
      for (const faq of role.faqs) assert.ok(text.includes(faq.q), role.slug);
    }
    for (const product of PRODUCTS) {
      assert.ok(text.includes(`## ${product.name} (`), product.slug);
      assert.ok(text.includes(product.intro), product.slug);
      for (const feature of product.features) assert.ok(text.includes(feature.title));
      for (const faq of product.faqs) assert.ok(text.includes(faq.q));
    }
  });
});
