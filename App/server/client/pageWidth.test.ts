import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pagesRoot = path.join(appRoot, "client/pages");

function readAppFile(relativePath: string): string {
  return fs.readFileSync(path.join(appRoot, relativePath), "utf8");
}

function pageFiles(directory = pagesRoot): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return pageFiles(absolutePath);
    return entry.isFile() && entry.name.endsWith(".tsx") ? [absolutePath] : [];
  });
}

function relativePagePath(absolutePath: string): string {
  return path.relative(appRoot, absolutePath).split(path.sep).join("/");
}

const sectionRepresentatives: Record<string, string[]> = {
  essentials: [
    "client/pages/Home.tsx",
    "client/pages/Inbox.tsx",
    "client/pages/Approvals.tsx",
  ],
  mail: [
    "client/pages/MailThreadList.tsx",
    "client/pages/MailRules.tsx",
    "client/pages/MailHandovers.tsx",
  ],
  peopleAndWork: [
    "client/pages/EmployeesLayout.tsx",
    "client/pages/RoutinesIndex.tsx",
    "client/pages/SkillsIndex.tsx",
    "client/pages/PipelinesIndex.tsx",
  ],
  dataAndKnowledge: [
    "client/pages/BaseRecordPage.tsx",
    "client/pages/ResourcesIndex.tsx",
    "client/pages/RepositoriesIndex.tsx",
    "client/pages/ExploreIndex.tsx",
  ],
  customersAndGrowth: [
    "client/pages/CustomersIndex.tsx",
    "client/pages/RevenueIndex.tsx",
    "client/pages/RevenueDeals.tsx",
    "client/pages/RevenueDataQuality.tsx",
    "client/pages/MarketingPages.tsx",
  ],
  finance: [
    "client/pages/FinanceIndex.tsx",
    "client/pages/FinanceInvoices.tsx",
    "client/pages/FinanceTransactions.tsx",
    "client/pages/FinanceReports.tsx",
  ],
  administration: [
    "client/pages/SettingsLayout.tsx",
    "client/pages/AccountLayout.tsx",
    "client/pages/AdminLayout.tsx",
  ],
};

describe("wide operational page layout", () => {
  test("defines one full-width shell with shrink-safe sizing", () => {
    const css = readAppFile("client/styles/index.css");
    const shell = css.match(/\.page-shell\s*\{(?<body>[^}]+)\}/)?.groups?.body;

    assert.ok(shell, "client/styles/index.css must define .page-shell");
    assert.match(shell, /@apply\s+mx-auto\s+w-full\s+min-w-0\s+max-w-none;/);
  });

  test("uses the shared shell throughout every major product section", () => {
    for (const [section, files] of Object.entries(sectionRepresentatives)) {
      for (const file of files) {
        assert.match(
          readAppFile(file),
          /\bpage-shell\b/,
          `${section} representative ${file} must use the wide page shell`,
        );
      }
    }
  });

  test("keeps broad coverage instead of fixing only one inbox screen", () => {
    const adopters = pageFiles()
      .filter((file) => /\bpage-shell\b/.test(fs.readFileSync(file, "utf8")))
      .map(relativePagePath);

    assert.ok(
      adopters.length >= 75,
      `expected at least 75 operational page files to use page-shell, found ${adopters.length}`,
    );
  });

  test("does not combine the full-width shell with a conflicting width cap", () => {
    const conflicts = pageFiles().flatMap((file) => {
      const lines = fs.readFileSync(file, "utf8").split("\n");
      return lines
        .map((line, index) => ({ line, lineNumber: index + 1 }))
        .filter(
          ({ line }) =>
            /\bpage-shell\b/.test(line) &&
            /\bmax-w-(?!none\b)(?:\[[^\]]+\]|[a-z0-9-]+)\b/.test(line),
        )
        .map(({ lineNumber }) => `${relativePagePath(file)}:${lineNumber}`);
    });

    assert.deepEqual(conflicts, []);
  });

  test("removes legacy desktop caps except from intentional focused experiences", () => {
    const legacyCap =
      /\bmx-auto\s+(?:w-full\s+)?max-w-(?:4xl|5xl|6xl|7xl)\b|\bmax-w-\[96rem\]\b/;
    const cappedFiles = pageFiles()
      .filter((file) => legacyCap.test(fs.readFileSync(file, "utf8")))
      .map(relativePagePath)
      .sort();

    assert.deepEqual(cappedFiles, [
      "client/pages/MailThreadView.tsx",
      "client/pages/Onboarding.tsx",
      "client/pages/ResourceDetail.tsx",
    ]);
  });

  test("makes every mail-list mode full width, including draft review", () => {
    const source = readAppFile("client/pages/MailThreadList.tsx");

    assert.match(source, /page-shell flex min-h-full flex-col/);
    assert.doesNotMatch(source, /draftsReview\s*\?\s*"max-w-/);
    assert.doesNotMatch(source, /max-w-\[96rem\]|max-w-5xl/);
  });

  test("preserves focused line lengths where width improves readability", () => {
    const focusedSurfaces = [
      ["client/pages/MailThreadView.tsx", /\bmax-w-4xl\b/],
      ["client/pages/ResourceDetail.tsx", /\bmax-w-4xl\b/],
      ["client/pages/NoteDetail.tsx", /max-w-\[820px\]/],
      ["client/pages/EmployeeChat.tsx", /\bmax-w-3xl\b/],
      ["client/pages/Onboarding.tsx", /\bmax-w-5xl\b/],
      ["client/pages/Login.tsx", /\bmax-w-sm\b/],
    ] as const;

    for (const [file, expectedCap] of focusedSurfaces) {
      const source = readAppFile(file);
      assert.match(source, expectedCap, `${file} must retain its focused width`);
      assert.doesNotMatch(source, /\bpage-shell\b/, `${file} must not use the operational shell`);
    }
  });

  test("centers onboarding within the full application pane", () => {
    const source = readAppFile("client/pages/Onboarding.tsx");

    // The guide owns the whole pane, so it must BE the scroll container the
    // rest of the app gets from `ContextualLayout` rather than a plain div
    // inside it — otherwise the shell scrolls, the top bar drifts, and the
    // "Skip to main content" link has no target on the first authenticated
    // screen anyone ever sees. It also uses the product's slate-900 dark
    // canvas, not slate-950, so the top bar still reads as chrome.
    assert.match(
      source,
      /id="main-content"[\s\S]*?className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-slate-50 dark:bg-slate-900"/,
    );
    assert.match(source, /className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 lg:py-12"/);
  });

  test("keeps the main application pane shrink-safe around full-width children", () => {
    const shell = readAppFile("client/components/AppShell.tsx");

    assert.match(
      shell,
      /id="main-content"[\s\S]*?className="min-h-0 min-w-0 flex-1 overflow-y-auto/,
    );
  });
});
