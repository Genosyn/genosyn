import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { PRODUCT_INTEGRATION_KEYS } from "../../client/lib/productIntegrations.js";
import { SECTION_BY_KEY, type SectionKey } from "../../client/lib/sections.js";
import {
  PALETTE_SUBPAGES,
  PRODUCT_INTEGRATION_SUBPAGES,
  SECTION_SUBPAGES,
  type SubpageItem,
} from "../../client/lib/subpages.js";

/**
 * The subpage catalogue (`client/lib/subpages.ts`) and the router
 * (`client/App.tsx`) must agree, in both directions:
 *
 * - every catalogued page is a real route, so neither a section rail nor the
 *   ⌘K palette can link somewhere that silently bounces to Home (the company
 *   catch-all is a quiet `<Navigate to="">`);
 * - every static company route is catalogued, or listed below as deliberately
 *   left out — so a page added to the router without a catalogue entry fails
 *   here instead of quietly never turning up in search.
 *
 * Source-scanning in the `server/client/` house style: there is no browser
 * router to mount in a node test, so the route tree is read from App.tsx.
 */

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function readAppFile(relativePath: string): string {
  return fs.readFileSync(path.join(appRoot, relativePath), "utf8");
}

/**
 * Static routes the catalogue leaves out on purpose, by path prefix. Anything
 * else static in the company router must be a section or a catalogued page.
 */
const DELIBERATELY_UNLISTED: Record<string, string> = {
  admin:
    "Admin is an instance-operator surface the palette deliberately leaves out; " +
    "it is reached from the avatar menu and the G D chord.",
  onboarding:
    "The one-time guided launch. It opens after creating a company and from the " +
    "owner-only Home banner, and appears in no nav by design (SetupBanner.tsx).",
};

// ─────────────────────────── a tiny route reader ───────────────────────────

type RouteRecord = {
  /** Full path under `/c/:companySlug`, without leading slash ("" is Home). */
  fullPath: string;
  /** The element is a bare `<Navigate …>` — a redirect, not a page. */
  redirect: boolean;
  /** For an index redirect, the absolute path it sends you to. */
  redirectTarget: string | null;
  /** Has a `:param`, `*`, or a template we can't expand. */
  dynamic: boolean;
};

/** The JSX between `CompanyRoutes`' `<Routes>` and its `</Routes>`. */
function companyRoutesSource(app: string): string {
  const fn = app.indexOf("function CompanyRoutes(");
  assert.ok(fn >= 0, "App.tsx must declare CompanyRoutes");
  const open = app.indexOf("<Routes>", fn);
  const close = app.indexOf("</Routes>", open);
  assert.ok(open > fn && close > open, "CompanyRoutes must render one <Routes> block");
  const body = app.slice(open + "<Routes>".length, close);
  assert.equal(body.includes("<Routes"), false, "CompanyRoutes must not nest <Routes>");
  return body;
}

/** Index just past the closing quote/backtick that matches `src[start]`. */
function skipString(src: string, start: number): number {
  const quote = src[start];
  let i = start + 1;
  while (i < src.length && src[i] !== quote) i += src[i] === "\\" ? 2 : 1;
  return i + 1;
}

/**
 * Reads one `<Route …>` opening tag from `start` (at the `<`). Returns the
 * tag's text, where it ends, and whether it closes itself. Attribute values
 * in braces can hold JSX of their own (`element={<Navigate … />}`), so `>` only
 * ends the tag outside every brace and string.
 */
function readTag(src: string, start: number): { text: string; end: number; selfClosing: boolean } {
  let depth = 0;
  let i = start + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(src, i);
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (depth === 0 && ch === ">") {
      const selfClosing = src[i - 1] === "/";
      return { text: src.slice(start, i + 1), end: i + 1, selfClosing };
    }
    i++;
  }
  throw new Error(`unterminated <Route> at ${start}`);
}

/** The value of `name=` at the tag's top level: a string, or a braced expression. */
function attribute(tag: string, name: string): string | null {
  let depth = 0;
  for (let i = 0; i < tag.length; i++) {
    const ch = tag[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(tag, i) - 1;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (depth === 0 && tag.startsWith(`${name}=`, i) && /\s/.test(tag[i - 1])) {
      const at = i + name.length + 1;
      if (tag[at] === '"') return tag.slice(at + 1, skipString(tag, at) - 1);
      if (tag[at] === "{") {
        let d = 0;
        for (let j = at; j < tag.length; j++) {
          if (tag[j] === '"' || tag[j] === "'" || tag[j] === "`") {
            j = skipString(tag, j) - 1;
            continue;
          }
          if (tag[j] === "{") d++;
          else if (tag[j] === "}" && --d === 0) return tag.slice(at + 1, j).trim();
        }
      }
    }
  }
  return null;
}

/** Does the tag carry the bare boolean attribute `index`? */
function hasIndex(tag: string): boolean {
  return /^<Route\s+(?:[^>]*\s)?index(?=[\s/>])/.test(tag.replace(/\{[^{}]*\}/g, "{}"));
}

/** `path` values, with the product-integrations template expanded. */
function pathVariants(raw: string | null): { path: string; dynamic: boolean }[] {
  if (raw === null) return [{ path: "", dynamic: false }];
  const template = raw.startsWith("`") && raw.endsWith("`") ? raw.slice(1, -1) : raw;
  if (template.includes("${product}")) {
    return PRODUCT_INTEGRATION_KEYS.map((key) => ({
      path: template.replace("${product}", key),
      dynamic: false,
    }));
  }
  const dynamic = template.includes("${") || /(^|\/)[:*]/.test(template) || template === "*";
  return [{ path: template, dynamic }];
}

function join(parent: string, child: string): string {
  return [parent, child].filter(Boolean).join("/");
}

/** Every `<Route>` under CompanyRoutes, with full paths resolved through nesting. */
function readCompanyRoutes(app: string): RouteRecord[] {
  const src = companyRoutesSource(app);
  const records: RouteRecord[] = [];
  // Each open (non-self-closing) route pushes the full paths its children nest under.
  const stack: { paths: string[]; dynamic: boolean }[] = [{ paths: [""], dynamic: false }];
  const token = /<Route(?=[\s/>])|<\/Route>/g;
  let match: RegExpExecArray | null;
  while ((match = token.exec(src))) {
    if (match[0] === "</Route>") {
      stack.pop();
      assert.ok(stack.length >= 1, "unbalanced </Route>");
      continue;
    }
    const tag = readTag(src, match.index);
    token.lastIndex = tag.end;
    const parent = stack[stack.length - 1];
    const index = hasIndex(tag.text);
    const element = attribute(tag.text, "element") ?? "";
    const redirect = /^<Navigate\b/.test(element);
    const to = redirect ? /\bto="([^"]+)"/.exec(element)?.[1] ?? null : null;
    const variants = index ? [{ path: "", dynamic: false }] : pathVariants(attribute(tag.text, "path"));

    const childPaths: string[] = [];
    for (const parentPath of parent.paths) {
      for (const variant of variants) {
        const fullPath = join(parentPath, variant.path);
        const dynamic = parent.dynamic || variant.dynamic;
        childPaths.push(fullPath);
        records.push({
          fullPath,
          redirect,
          redirectTarget:
            index && to && !to.startsWith("/") && !to.includes("${") ? join(fullPath, to) : null,
          dynamic,
        });
      }
    }
    if (!tag.selfClosing) {
      stack.push({ paths: childPaths, dynamic: parent.dynamic || variants.some((v) => v.dynamic) });
    }
  }
  assert.equal(stack.length, 1, "every <Route> must close");
  return records;
}

// ────────────────────────────────── tests ──────────────────────────────────

const app = readAppFile("client/App.tsx");
const routes = readCompanyRoutes(app);

/** Static paths that render something other than a redirect. */
const routable = new Set(routes.filter((r) => !r.dynamic && !r.redirect).map((r) => r.fullPath));

const allPages: SubpageItem[] = [
  ...Object.values(SECTION_SUBPAGES).flatMap((pages) => pages ?? []),
  ...PRODUCT_INTEGRATION_SUBPAGES,
];

/** `/finance/recurring-invoices?x=1` → `finance/recurring-invoices`. */
function routePath(catalogued: string): string {
  return catalogued.split("?")[0].replace(/^\/+/, "");
}

describe("subpage catalogue ↔ client router", () => {
  test("reads the company route tree, nesting and templates included", () => {
    assert.ok(routes.length > 150, `parsed ${routes.length} routes`);
    for (const fullPath of [
      "",
      "finance",
      "finance/recurring-invoices",
      "finance/recurring-invoices/new",
      "settings/email/logs",
      "account/security",
      "mail/rules",
      "tldrs/settings",
      "workspace/integrations",
      "finance/integrations",
      "admin/users",
    ]) {
      assert.ok(routable.has(fullPath), `${fullPath || "(home)"} must be a routable path`);
    }
    const legacy = routes.find((r) => r.fullPath === "finance/customers");
    assert.equal(legacy?.redirect, true, "legacy redirects are recognised as redirects");
    assert.ok(
      routes.some((r) => r.fullPath === "finance/invoices/:invoiceSlug" && r.dynamic),
      "parameterised routes are recognised as dynamic",
    );
    assert.ok(
      routes.some((r) => r.fullPath === "settings/email" && r.redirectTarget === "settings/email/providers"),
      "index redirects resolve to their default tab",
    );
  });

  test("points every catalogued page at a real route", () => {
    for (const page of allPages) {
      const target = routePath(page.path);
      assert.ok(
        routable.has(target),
        `${page.path} (${page.label}) is not a route in client/App.tsx — it would bounce to Home`,
      );
    }
  });

  test("points every section at a real route", () => {
    for (const section of Object.values(SECTION_BY_KEY)) {
      assert.ok(routable.has(routePath(section.path)), `${section.key} → ${section.path}`);
    }
  });

  test("lists every static company route, or leaves it out on purpose", () => {
    const covered = new Set<string>([
      ...Object.values(SECTION_BY_KEY).map((s) => routePath(s.path)),
      ...allPages.map((p) => routePath(p.path)),
    ]);
    // A default tab is reached through the entry that opens its parent:
    // Settings → Email lands on Email providers.
    for (const r of routes) if (r.redirectTarget && covered.has(r.fullPath)) covered.add(r.redirectTarget);

    const unlisted = [...routable].filter((fullPath) => {
      if (covered.has(fullPath)) return false;
      const top = fullPath.split("/")[0];
      return !(top in DELIBERATELY_UNLISTED);
    });
    assert.deepEqual(
      unlisted,
      [],
      "Static routes missing from client/lib/subpages.ts — add each to the catalogue " +
        "(so its rail and the ⌘K palette can find it) or, if it must stay out of " +
        "navigation, to DELIBERATELY_UNLISTED here with the reason.",
    );
  });

  test("keeps the deliberately unlisted list honest", () => {
    for (const prefix of Object.keys(DELIBERATELY_UNLISTED)) {
      assert.ok(
        [...routable].some((p) => p === prefix || p.startsWith(`${prefix}/`)),
        `${prefix} is no longer a route; drop it from DELIBERATELY_UNLISTED`,
      );
      assert.equal(
        PALETTE_SUBPAGES.some((p) => routePath(p.path).split("/")[0] === prefix),
        false,
        `${prefix} is meant to stay out of the palette`,
      );
    }
  });
});

describe("rails drawn from the catalogue", () => {
  const CATALOGUE_RAILS: Record<string, SectionKey> = {
    "client/pages/FinanceLayout.tsx": "finance",
    "client/pages/RevenueLayout.tsx": "revenue",
    "client/pages/MarketingLayout.tsx": "marketing",
    "client/pages/MeetingsLayout.tsx": "meetings",
    "client/pages/CustomersLayout.tsx": "customers",
    "client/pages/SignatureLayout.tsx": "signatures",
    "client/pages/TldrsLayout.tsx": "tldrs",
    "client/pages/VaultLayout.tsx": "vault",
    "client/pages/SettingsLayout.tsx": "settings",
    "client/pages/AccountLayout.tsx": "account",
    "client/pages/MailLayout.tsx": "mail",
  };

  test("renders each static rail from the catalogue, with no hand-written links", () => {
    for (const [file, section] of Object.entries(CATALOGUE_RAILS)) {
      const source = readAppFile(file);
      assert.match(
        source,
        new RegExp(`<SectionRailLinks section="${section}"`),
        `${file} must draw its rail with SectionRailLinks`,
      );
      // A hand-written link here would be a page the palette can't find.
      assert.doesNotMatch(source, /<SidebarLink\b/, `${file} must not hand-write rail links`);
    }
  });

  test("lists exactly the mail folders the Email rail draws", () => {
    const layout = readAppFile("client/pages/MailLayout.tsx");
    const drawn = [...layout.matchAll(/<FolderLink[\s\S]*?view="([a-z]+)"/g)].map((m) => m[1]);
    assert.ok(drawn.includes("inbox") && drawn.length >= 7, `parsed folders: ${drawn.join(", ")}`);
    const catalogued = (SECTION_SUBPAGES.mail ?? [])
      .filter((p) => p.path.startsWith("/mail?view="))
      .map((p) => new URLSearchParams(p.path.split("?")[1]).get("view"));
    // Inbox is the section's own landing page, so it isn't repeated as a page.
    assert.deepEqual(catalogued, drawn.filter((view) => view !== "inbox"));
  });

  test("keeps the self-drawn rails' fixed links in the catalogue", () => {
    // Tasks draws its review queue by hand (it carries a live count).
    assert.match(readAppFile("client/pages/TasksLayout.tsx"), /tasks\/review/);
    assert.ok(allPages.some((p) => p.path === "/tasks/review"));
  });
});
