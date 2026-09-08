import assert from "node:assert/strict";
import { describe, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { WorkSessionModel } from "../../lib/api.js";
import { WorkSessionModelPicker } from "./WorkSessionModelPicker.js";

const DEFAULT: WorkSessionModel = {
  id: "claude",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  label: "Claude Sonnet",
  status: "connected",
  isActive: true,
};
const ALTERNATIVE: WorkSessionModel = {
  id: "gpt",
  provider: "openai",
  model: "gpt-5.4",
  label: "GPT 5.4",
  status: "connected",
  isActive: false,
};
const DISCONNECTED: WorkSessionModel = {
  id: "local",
  provider: "custom",
  model: "company-local",
  label: "Company local model",
  status: "not_connected",
  isActive: false,
};

function render(overrides: Partial<React.ComponentProps<typeof WorkSessionModelPicker>> = {}) {
  return renderToStaticMarkup(
    React.createElement(WorkSessionModelPicker, {
      models: [DEFAULT, ALTERNATIVE, DISCONNECTED],
      modelId: DEFAULT.id,
      onChange: () => undefined,
      ...overrides,
    }),
  );
}

function option(html: string, id: string) {
  const found = html.match(new RegExp(`<option\\b[^>]*value="${id}"[^>]*>[^<]*</option>`));
  assert.ok(found, `Expected an option for ${id}`);
  return found[0];
}

describe("Work session model picker", () => {
  test("hides the entire picker when the employee has one model", () => {
    assert.equal(render({ models: [DEFAULT] }), "");
  });

  test("also hides a single disconnected model and an empty model list", () => {
    assert.equal(render({ models: [DISCONNECTED], modelId: null }), "");
    assert.equal(render({ models: [], modelId: null }), "");
  });

  test("shows every assigned model, including models that need connecting", () => {
    const html = render();
    for (const model of [DEFAULT, ALTERNATIVE, DISCONNECTED]) option(html, model.id);
    assert.equal((html.match(/<option\b/g) ?? []).length, 3);
    assert.match(html, /AI Model/);
  });

  test("uses the model display label and identifies the default", () => {
    const html = render();
    assert.match(option(html, DEFAULT.id), /Claude Sonnet \(default\)/);
    assert.match(option(html, ALTERNATIVE.id), /GPT 5\.4/);
    assert.doesNotMatch(option(html, ALTERNATIVE.id), /default/);
    assert.doesNotMatch(html, /claude-sonnet-4-6/);
  });

  test("marks disconnected options as unavailable without disabling connected alternatives", () => {
    const html = render();
    assert.match(option(html, DISCONNECTED.id), /disabled=""/);
    assert.match(option(html, DISCONNECTED.id), /Not connected/);
    assert.doesNotMatch(option(html, ALTERNATIVE.id), /disabled/);
    assert.doesNotMatch(option(html, DEFAULT.id), /disabled/);
  });

  test("renders the chosen model independently of the employee default", () => {
    const html = render({ modelId: ALTERNATIVE.id });
    assert.match(option(html, ALTERNATIVE.id), /selected=""/);
    assert.doesNotMatch(option(html, DEFAULT.id), /selected/);
  });

  test("keeps the picker visible when only one of several assigned models is connected", () => {
    const html = render({ models: [DEFAULT, DISCONNECTED] });
    assert.match(html, /role="combobox"/);
    option(html, DISCONNECTED.id);
  });

  test("can disable selection while a Work session is starting", () => {
    const html = render({ disabled: true });
    assert.match(html, /<input\b[^>]*disabled=""/);
    assert.match(html, /<select\b[^>]*disabled=""/);
  });

  test("escapes model labels rather than rendering them as HTML", () => {
    const html = render({
      models: [DEFAULT, { ...ALTERNATIVE, label: '<img src=x onerror="bad()"> & custom' }],
    });
    assert.match(html, /&lt;img src=x onerror=&quot;bad\(\)&quot;&gt; &amp; custom/);
    assert.doesNotMatch(html, /<img\b/);
  });
});
