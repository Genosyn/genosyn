import assert from "node:assert/strict";
import { before, describe, test } from "node:test";

import { DOCS_FLAT, DOCS_NAV, findPageMeta } from "../client/docs/nav.js";
import { PRODUCT_CATEGORIES, PRODUCTS, findProduct } from "../client/products/data.js";
import { SHOWCASE_USE_CASES, getUseCasesForProduct } from "../client/products/useCases.js";

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
  test("registers every product and docs route exactly once", () => {
    const routes = siteMeta.allRoutes();
    const paths = routes.map((route) => route.path);
    assert.equal(new Set(paths).size, paths.length);
    assert.equal(
      routes.length,
      3 + PRODUCTS.length + DOCS_FLAT.length,
      "home + products + enterprise + generated product/docs routes",
    );
    for (const path of [
      "/",
      "/products",
      "/enterprise",
      ...PRODUCTS.map((product) => `/products/${product.slug}`),
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

  test("puts the build version into homepage structured data", () => {
    const home = siteMeta.findRouteHead("/");
    assert.match(JSON.stringify(home?.jsonLd), /9\.9\.9-test/);
  });

  test("the compact LLM index links every product and docs page", () => {
    const text = siteMeta.llmsTxt();
    assert.match(text, /^# Genosyn/m);
    assert.doesNotMatch(text, /\bundefined\b/);
    for (const product of PRODUCTS) {
      assert.match(text, new RegExp(`https://genosyn\\.com/products/${product.slug}`));
    }
    for (const page of DOCS_FLAT) {
      assert.ok(text.includes(`https://genosyn.com${page.path}`), page.path);
    }
  });

  test("the full LLM reference includes every product, capability list, and FAQ", () => {
    const text = siteMeta.llmsFullTxt();
    assert.doesNotMatch(text, /\bundefined\b/);
    for (const product of PRODUCTS) {
      assert.ok(text.includes(`## ${product.name} (`), product.slug);
      assert.ok(text.includes(product.intro), product.slug);
      for (const feature of product.features) assert.ok(text.includes(feature.title));
      for (const faq of product.faqs) assert.ok(text.includes(faq.q));
    }
  });
});
