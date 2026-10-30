import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { marked } from "marked";

import {
  financeProductPath,
  matchesFinanceProduct,
} from "../../shared/financeProducts.js";
import { insertResourceReference } from "../components/chat/resourceReferences.js";

describe("Finance product search", () => {
  const product = {
    name: "Starter plan",
    description: "Monthly plan for small teams",
  };

  test("matches every word across the name and description, in any order", () => {
    assert.equal(matchesFinanceProduct(product, "starter"), true);
    assert.equal(matchesFinanceProduct(product, "small teams"), true);
    assert.equal(matchesFinanceProduct(product, "plan teams monthly"), true);
    assert.equal(matchesFinanceProduct(product, "starter annual"), false);
  });

  test("ignores case and surrounding or repeated whitespace", () => {
    assert.equal(matchesFinanceProduct(product, "  STARTER   PLAN  "), true);
    assert.equal(matchesFinanceProduct(product, ""), true, "a blank query lists everything");
    assert.equal(matchesFinanceProduct(product, "   "), true);
  });

  test("treats a missing description as empty, not as a reason to fail", () => {
    assert.equal(matchesFinanceProduct({ name: "Setup fee" }, "setup"), true);
    assert.equal(matchesFinanceProduct({ name: "Setup fee", description: null }, "fee"), true);
    assert.equal(matchesFinanceProduct({ name: "Setup fee", description: null }, "monthly"), false);
  });

  test("opens the catalogue filtered to the exact product name", () => {
    assert.equal(
      financeProductPath("Starter plan"),
      "/finance/products?q=Starter%20plan",
    );
    assert.equal(
      financeProductPath("Plan/Bundle & support"),
      "/finance/products?q=Plan%2FBundle%20%26%20support",
    );
  });

  test("escapes the characters a Markdown link would stop at", () => {
    assert.equal(
      financeProductPath("Support (hourly)"),
      "/finance/products?q=Support%20%28hourly%29",
    );
    assert.equal(financeProductPath("Option A)"), "/finance/products?q=Option%20A%29");
    assert.equal(
      financeProductPath("Don't panic!*"),
      "/finance/products?q=Don%27t%20panic%21%2A",
    );
  });

  test("decodes back to the exact name, whatever it holds", () => {
    for (const name of [
      "Starter plan",
      "Support (hourly)",
      "Option A)",
      "(Legacy) Pro",
      "Don't panic!",
      "50% off*",
      "Plan/Bundle & support",
      "a+b = c?",
      "Café crème",
      "#1 seller",
      "  spaced  out  ",
    ]) {
      const url = new URL(financeProductPath(name), "https://genosyn.test");
      assert.equal(url.pathname, "/finance/products", name);
      assert.equal(url.searchParams.get("q"), name, name);
      assert.equal([...url.searchParams.keys()].join(","), "q", name);
    }
  });

  test("survives the chat composer's Markdown link intact", () => {
    // Choosing a product in the chat picker writes `[#name](path)`, which the
    // conversation renders with marked as ChatMarkdown does.
    for (const name of ["Option A)", "Smile :)", "Support (hourly)", "(Legacy) Pro", "Starter plan"]) {
      const { value } = insertResourceReference({
        value: "#opt",
        caret: 4,
        start: 0,
        companySlug: "acme",
        reference: {
          kind: "catalogProduct",
          id: "product-1",
          label: name,
          sublabel: null,
          path: financeProductPath(name),
        },
      });
      const html = (marked.parse(value, { async: false, gfm: true, breaks: true }) as string).trim();
      const anchors = [...html.matchAll(/<a href="([^"]*)">/g)];
      assert.equal(anchors.length, 1, `${name}: ${html}`);
      const url = new URL(anchors[0][1].replaceAll("&amp;", "&"), "https://genosyn.test");
      assert.equal(url.pathname, "/c/acme/finance/products", name);
      assert.equal(url.searchParams.get("q"), name, name);
      // Nothing of the link is left over as text after it.
      assert.match(html, /<\/a>\s*<\/p>$/, `${name}: ${html}`);
    }
  });

  test("filters the catalogue to the product its link names", () => {
    // What the page does with the `q` a search result opens it with.
    const catalogue = [
      { name: "Option A)", description: "" },
      { name: "Option B", description: "" },
      { name: "Support (hourly)", description: "Billed per hour" },
    ];
    for (const product of catalogue) {
      const q = new URL(financeProductPath(product.name), "https://genosyn.test").searchParams.get(
        "q",
      );
      const visible = catalogue.filter((row) => matchesFinanceProduct(row, q ?? ""));
      assert.ok(visible.includes(product), product.name);
    }
  });
});
