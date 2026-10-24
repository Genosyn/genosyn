import assert from "node:assert/strict";
import { describe, test } from "node:test";
import postcss from "postcss";
import tailwindcss from "tailwindcss";

import tailwindConfig from "../../tailwind.config.js";
import { AA_NORMAL, contrastOf, relativeLuminance, parseColor } from "./contrast.js";
import {
  AA_TUNED,
  ACCENT,
  SLATE,
  SURFACES,
  TAILWIND_ORIGINAL,
  TEXT,
  THEME_SLATE,
  TINT_50,
  rgbChannels,
  themeColor,
  themeVariables,
  type ThemeName,
} from "./designTokens.js";

const THEMES: ThemeName[] = ["light", "dark"];
const FOCUS_MINIMUM = 3;

const luminance = (hex: string) => relativeLuminance(parseColor(hex)!);

describe("rgbChannels", () => {
  test("turns #rrggbb into the space-separated channels Tailwind reads", () => {
    assert.equal(rgbChannels("#61718a"), "97 113 138");
    assert.equal(rgbChannels("#FFFFFF"), "255 255 255");
    assert.equal(rgbChannels("000000"), "0 0 0");
  });

  test("refuses anything that is not six hex digits", () => {
    for (const value of ["#fff", "#12345g", "rgb(0 0 0)", ""]) {
      assert.throws(() => rgbChannels(value), /Expected a #rrggbb colour/, value);
    }
  });
});

describe("themeVariables", () => {
  test("light and dark set the same properties", () => {
    assert.deepEqual(Object.keys(themeVariables("light")), Object.keys(themeVariables("dark")));
  });

  test("carry each theme's slate and focus colours", () => {
    assert.deepEqual(themeVariables("light"), {
      "--gs-slate-400": rgbChannels(THEME_SLATE.light[400]),
      "--gs-slate-500": rgbChannels(THEME_SLATE.light[500]),
      "--gs-focus": rgbChannels(ACCENT.light.focus),
    });
    assert.equal(themeVariables("dark")["--gs-slate-400"], rgbChannels(SLATE[400]));
  });

  test("themeColor keeps opacity modifiers working", () => {
    assert.equal(themeColor("--gs-slate-500"), "rgb(var(--gs-slate-500) / <alpha-value>)");
  });
});

describe("text roles meet WCAG AA on every surface of their theme", () => {
  for (const theme of THEMES) {
    for (const [role, color] of Object.entries(TEXT[theme])) {
      for (const [surface, background] of Object.entries(SURFACES[theme])) {
        test(`${theme}: ${role} on ${surface}`, () => {
          const ratio = contrastOf(color, background);
          assert.ok(
            ratio >= AA_NORMAL,
            `${role} ${color} on ${surface} ${background} is ${ratio.toFixed(2)}:1`,
          );
        });
      }
    }
  }
});

describe("the theme-aware slate steps", () => {
  test("Tailwind's own values are why they exist", () => {
    assert.ok(contrastOf(SLATE[400], SURFACES.light.card) < AA_NORMAL);
    assert.ok(contrastOf(SLATE[500], SURFACES.dark.card) < AA_NORMAL);
  });

  test("400 stays the quieter step in light mode, 500 the quieter in dark", () => {
    const card = SURFACES.light.card;
    assert.ok(contrastOf(THEME_SLATE.light[400], card) < contrastOf(THEME_SLATE.light[500], card));
    const night = SURFACES.dark.page;
    assert.ok(contrastOf(THEME_SLATE.dark[500], night) < contrastOf(THEME_SLATE.dark[400], night));
  });

  test("they stay between their neighbours, so the scale still reads in order", () => {
    // Light: lighter than slate-600, darker than slate-300.
    for (const step of [400, 500] as const) {
      assert.ok(luminance(THEME_SLATE.light[step]) > luminance(SLATE[600]));
      assert.ok(luminance(THEME_SLATE.light[step]) < luminance(SLATE[300]));
      assert.ok(luminance(THEME_SLATE.dark[step]) > luminance(SLATE[600]));
      assert.ok(luminance(THEME_SLATE.dark[step]) < luminance(SLATE[300]));
    }
  });
});

describe("AA-tuned steps", () => {
  const light = [SURFACES.light.card, SURFACES.light.page, SURFACES.light.sunken];
  for (const [hue, steps] of Object.entries(AA_TUNED)) {
    for (const [step, color] of Object.entries(steps)) {
      const original = (TAILWIND_ORIGINAL as Record<string, Record<string, string>>)[hue][step];
      test(`${hue}-${step} is a nudge darker than Tailwind's, never lighter`, () => {
        assert.ok(luminance(color) < luminance(original), `${color} vs ${original}`);
      });
      if (step === "600") {
        test(`${hue}-600 passes AA as text on white, the page, wells and its own tint`, () => {
          for (const background of [...light, TINT_50[hue as keyof typeof TINT_50]]) {
            const ratio = contrastOf(color, background);
            assert.ok(ratio >= AA_NORMAL, `${color} on ${background} is ${ratio.toFixed(2)}:1`);
          }
          // Tailwind's own value did not — or the nudge would be pointless.
          assert.ok(contrastOf(original, SURFACES.light.card) < AA_NORMAL + 0.5);
        });
      }
    }
  }

  test("white text passes AA on the tuned indigo-500", () => {
    assert.ok(contrastOf("#ffffff", AA_TUNED.indigo[500]) >= AA_NORMAL);
    assert.ok(contrastOf("#ffffff", TAILWIND_ORIGINAL.indigo[500]) < AA_NORMAL);
  });
});

describe("the accent", () => {
  for (const theme of THEMES) {
    test(`${theme}: white text on a primary button passes AA`, () => {
      assert.ok(contrastOf("#ffffff", ACCENT[theme].solid) >= AA_NORMAL);
    });
    for (const [surface, background] of Object.entries(SURFACES[theme])) {
      test(`${theme}: link text and focus ring read on ${surface}`, () => {
        assert.ok(contrastOf(ACCENT[theme].text, background) >= AA_NORMAL);
        assert.ok(contrastOf(ACCENT[theme].focus, background) >= FOCUS_MINIMUM);
      });
    }
  }
});

describe("tailwind.config.ts", () => {
  const colors = tailwindConfig.theme.extend.colors as Record<string, Record<string, string> | string>;

  test("reads slate 400/500 and the focus colour from the theme variables", () => {
    const slate = colors.slate as Record<string, string>;
    assert.equal(slate[400], themeColor("--gs-slate-400"));
    assert.equal(slate[500], themeColor("--gs-slate-500"));
    assert.equal(colors.focus, themeColor("--gs-focus"));
  });

  test("keeps Tailwind's other slate steps exactly", () => {
    const slate = colors.slate as Record<string, string>;
    for (const step of [50, 100, 200, 300, 600, 700, 800, 900, 950] as const) {
      assert.equal(slate[step], SLATE[step], `slate-${step}`);
    }
  });

  test("uses every tuned step and leaves the rest of each hue alone", () => {
    for (const [hue, steps] of Object.entries(AA_TUNED)) {
      const scale = colors[hue] as Record<string, string>;
      for (const [step, color] of Object.entries(steps)) assert.equal(scale[step], color);
      assert.ok(scale["50"] && scale["900"], `${hue} keeps its full scale`);
    }
    assert.equal((colors.emerald as Record<string, string>)["700"], "#047857");
  });

  test("emits both themes' variables and points the utilities at them", async () => {
    const result = await postcss([
      tailwindcss({
        ...tailwindConfig,
        content: [
          {
            raw: '<p class="text-slate-400 dark:text-slate-500 bg-slate-500/10 text-emerald-600 outline-focus"></p>',
            extension: "html",
          },
        ],
      }),
    ]).process("@tailwind base; @tailwind utilities;", { from: undefined });
    const css = result.css.replace(/\s+/g, " ");
    const light400 = rgbChannels(THEME_SLATE.light[400]);
    const dark500 = rgbChannels(THEME_SLATE.dark[500]);
    assert.ok(css.includes(`--gs-slate-400: ${light400};`), "light slate-400 variable");
    assert.match(css, /:root\.dark \{[^}]*--gs-slate-400: 148 163 184;/);
    assert.ok(
      new RegExp(`:root\\.dark \\{[^}]*--gs-slate-500: ${dark500};`).test(css),
      "dark slate-500 variable",
    );
    assert.match(css, /:root \{[^}]*--gs-slate-400:/);
    assert.match(css, /\.text-slate-400 \{[^}]*color: rgb\(var\(--gs-slate-400\) \/ var\(--tw-text-opacity/);
    assert.match(
      css,
      /\.dark\\:text-slate-500:is\(\.dark \*\) \{[^}]*color: rgb\(var\(--gs-slate-500\)/,
    );
    assert.match(css, /\.bg-slate-500\\\/10 \{[^}]*background-color: rgb\(var\(--gs-slate-500\) \/ 0\.1\)/);
    assert.match(css, /\.text-emerald-600 \{[^}]*rgb\(4 128 92/);
    assert.match(css, /\.outline-focus \{[^}]*outline-color: rgb\(var\(--gs-focus\) \/ 1\)/);
  });
});
