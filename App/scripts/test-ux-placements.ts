/**
 * Real Chrome coverage for where settings live, on the real App, after the
 * "natural and simple" pass: every setting sits with the thing it configures,
 * and what most people never touch waits under one Advanced disclosure that is
 * closed by default and says on its line what is set inside.
 *
 * - Settings and Revenue rails lead with everyday pages, group the rest, and
 *   tuck pages visited now and then under a closed Advanced group that names
 *   them on hover and opens by itself on one of its pages — desktop and phone.
 * - Decision routing lives on Decision stack → Settings under Advanced, not
 *   behind a button on the stack.
 * - Settings → Company leads with name, mission, vision and time zone; the web
 *   address and two-factor rule wait under Advanced.
 * - A Workspace channel's incoming webhook waits under Advanced in its settings.
 * - Admin → General, Admin → Integrations and Admin → Email transport each
 *   show the basics, with the rest on closed lines that say what is set.
 * - Recruiting → Settings keeps each applicant email's Send it switch in view
 *   and its editor behind one line.
 * - Settings → Email is Notification email, so nobody looking for their inbox
 *   lands on SMTP providers.
 * - The Admin rail keeps its SQL console and migration ledger under Advanced.
 * - At phone width each of those pages keeps its Advanced closed with its
 *   line, opens it, and never scrolls sideways.
 *
 * Screenshots land in output/playwright. Run with `npm run test:ux-placements`.
 */
import assert from "node:assert/strict";
import type { Locator, Page } from "playwright-core";
import type {
  CustomJavaScriptSettings,
  DecisionPolicyRule,
  DecisionStackSettings,
  Employee,
  GlobalEmailTransport,
  InstanceSettings,
  OauthAppDescriptor,
} from "../client/lib/api";
import type { RecruitingSettingsDto } from "../client/lib/recruiting";
import type { WorkspaceChannel } from "../client/lib/workspace";
import {
  DEFAULT_CONFIRMATION_EMAIL_BODY,
  DEFAULT_CONFIRMATION_EMAIL_SUBJECT,
  DEFAULT_REJECTION_EMAIL_BODY,
  DEFAULT_REJECTION_EMAIL_SUBJECT,
  DEFAULT_SCREENING_INSTRUCTIONS,
} from "../shared/recruiting";
import { API, ME, hoursAgo, noSidewaysScroll, startApp, type ApiRoute } from "./appFixture";

const app = await startApp("Where settings live");

// ───────────────────────────── helpers ─────────────────────────────

/** The closed Advanced toggle a section rail draws. */
const railAdvanced = (scope: Page | Locator) =>
  scope.locator("button[data-rail-advanced]").first();

/** The desktop rail. */
const desktopRail = (page: Page) => page.locator("aside").first();

/** Text of every link in `scope`, in order. */
async function linkTexts(scope: Locator): Promise<string[]> {
  return (await scope.getByRole("link").allTextContents()).map((text) => text.trim());
}

/**
 * A Disclosure's toggle, found by its title — in the page's main pane, since
 * the section rail beside it may have an Advanced toggle of its own.
 */
const disclosure = (scope: Page | Locator, title: string) =>
  ("goto" in scope ? scope.locator("main") : scope)
    .getByRole("button", { name: new RegExp(`^${title}`) })
    .first();

/** The toggle is closed and its line reads exactly `summary`. */
async function closedWith(toggle: Locator, summary: string, label: string) {
  assert.equal(await toggle.getAttribute("aria-expanded"), "false", `${label} starts closed`);
  await toggle.getByText(summary, { exact: true }).waitFor();
}

/** These pages scroll inside their own pane; stretch the window first so a shot shows it all. */
async function shotWhole(page: Page, name: string) {
  const width = page.viewportSize()?.width ?? 1280;
  const height = await page.evaluate(() => {
    const panes = [
      document.documentElement,
      ...document.querySelectorAll<HTMLElement>("main, .page-shell, .overflow-y-auto"),
    ];
    return Math.max(...panes.map((pane) => pane.scrollHeight)) + 120;
  });
  await page.setViewportSize({ width, height: Math.min(height, 6000) });
  await app.shot(page, name);
}

/** Routes most pages here can do without, answered quietly. */
const QUIET: ApiRoute[] = [
  ["GET", /\/standdowns\/active$/, () => ({ standdown: null })],
  ["GET", /\/standdowns$/, () => ({ standdowns: [] })],
  [
    "GET",
    `${API}/navigation/waiting`,
    () => ({ approvals: 0, revisions: 0, initiatives: 0, todoReviews: 0, financeProposals: 0 }),
  ],
];

const ALEX: Employee = {
  id: "alex",
  companyId: "company",
  name: "Alex Rivera",
  slug: "alex",
  role: "Account manager",
  avatarKey: null,
  model: null,
  modelCount: 0,
};
const RILEY: Employee = { ...ALEX, id: "riley", name: "Riley Chen", slug: "riley", role: "Bookkeeper" };

// ─────────────────────── Settings and Revenue rails ───────────────────────

const SETTINGS_EVERYDAY = [
  "Company",
  "Members",
  "Teams",
  "Policies",
  "Usage",
  "Integrations",
  "Phone numbers",
  "Browsers",
  "Notification email",
  "API keys",
  "Environment secrets",
];
const SETTINGS_ADVANCED = ["Tags", "Single sign-on", "Audit log", "System Health"];

await app.check(
  "Settings rail: everyday pages under Company, Connections and Developers; the rest under a closed Advanced",
  async () => {
    const view = await app.open({ path: "/c/acme/settings/company", routes: QUIET });
    const { page } = view;
    const rail = desktopRail(page);
    await rail.getByRole("link", { name: "Notification email" }).waitFor();
    assert.deepEqual(await linkTexts(rail), SETTINGS_EVERYDAY);
    for (const heading of ["Company", "Connections", "Developers"]) {
      await rail.getByText(heading, { exact: true }).first().waitFor();
    }
    const advanced = railAdvanced(rail);
    assert.equal(await advanced.getAttribute("aria-expanded"), "false");
    assert.equal(await advanced.getAttribute("title"), SETTINGS_ADVANCED.join(", "));
    // There is no "Email" any more: the rail says what the page is for.
    assert.equal(await rail.getByRole("link", { name: "Email", exact: true }).count(), 0);

    // Opening the group shows its pages, after everything else.
    await view.click(advanced);
    assert.equal(await advanced.getAttribute("aria-expanded"), "true");
    assert.deepEqual(await linkTexts(rail), [...SETTINGS_EVERYDAY, ...SETTINGS_ADVANCED]);
    await shotWhole(page, "ux-settings-rail-open");

    // It stays open while moving around the section, and closes again on a click.
    await view.click(rail.getByRole("link", { name: "Tags" }));
    await view.landedOn("/c/acme/settings/tags");
    assert.equal(await railAdvanced(rail).getAttribute("aria-expanded"), "true");
    await page.close();
  },
);

await app.check("Settings rail: a deep link to an Advanced page opens the group, with that page lit", async () => {
  const view = await app.open({
    path: "/c/acme/settings/tags",
    routes: [...QUIET, ["GET", `${API}/tags`, () => []]],
  });
  const { page } = view;
  const rail = desktopRail(page);
  const advanced = railAdvanced(rail);
  await rail.getByRole("link", { name: "Tags" }).waitFor();
  assert.equal(await advanced.getAttribute("aria-expanded"), "true");
  assert.equal(
    await rail.getByRole("link", { name: "Tags" }).getAttribute("aria-current"),
    "page",
  );
  await page.close();
});

await app.check("Settings rail: a Member's Advanced group names only what they can open", async () => {
  const view = await app.open({ path: "/c/acme/settings/company", routes: QUIET, role: "member" });
  const { page } = view;
  const rail = desktopRail(page);
  await rail.getByRole("link", { name: "Notification email" }).waitFor();
  assert.equal(await railAdvanced(rail).getAttribute("title"), "Tags, System Health");
  assert.equal(await rail.getByRole("link", { name: "Usage" }).count(), 0, "Usage is admin-only");
  await page.close();
});

await app.check("Settings rail on a phone: the drawer has the same groups and closed Advanced", async () => {
  const view = await app.open({ path: "/c/acme/settings/company", routes: QUIET, touch: true });
  const { page } = view;
  await page.getByRole("button", { name: "Open sidebar" }).click();
  const drawer = page.locator("div.fixed aside");
  await drawer.getByRole("link", { name: "Notification email" }).waitFor();
  const advanced = railAdvanced(drawer);
  assert.equal(await advanced.getAttribute("aria-expanded"), "false");
  await advanced.click();
  await drawer.getByRole("link", { name: "Audit log" }).waitFor();
  await noSidewaysScroll(page, "the Settings drawer");
  await app.shot(page, "ux-settings-rail-phone");
  await page.close();
});

await app.check("Notification email: the page and its breadcrumb say what it is for", async () => {
  const view = await app.open({
    path: "/c/acme/settings/email/providers",
    routes: [
      ...QUIET,
      ["GET", `${API}/email/providers/catalog`, () => []],
      ["GET", `${API}/email/providers`, () => []],
    ],
  });
  const { page } = view;
  await page.getByRole("heading", { name: "Notification email", level: 1 }).waitFor();
  await page.getByLabel("Breadcrumb").getByText("Notification email").waitFor();
  await page.getByText(/Your inbox is connected in the Email section instead/).waitFor();
  await page.close();
});

const REVENUE_EVERYDAY = [
  "Insights",
  "Follow-ups",
  "Deals",
  "Accounts",
  "Contacts",
  "Partnerships",
  "Sequences",
  "Signals",
];
const REVENUE_ADVANCED = ["Activities", "Suppressions", "Imports", "Data quality", "AI access", "Setup"];

await app.check("Revenue rail: everyday pages first, Outreach together, the rest under a closed Advanced", async () => {
  const view = await app.open({ path: "/c/acme/revenue/follow-ups", routes: QUIET });
  const { page } = view;
  const rail = desktopRail(page);
  await rail.getByRole("link", { name: "Signals" }).waitFor();
  const links = await linkTexts(rail);
  // The product Integrations link closes every product rail.
  assert.deepEqual(links.slice(0, REVENUE_EVERYDAY.length), REVENUE_EVERYDAY);
  assert.equal(links.filter((text) => REVENUE_ADVANCED.includes(text)).length, 0);
  await rail.getByText("Outreach", { exact: true }).waitFor();
  const advanced = railAdvanced(rail);
  assert.equal(await advanced.getAttribute("aria-expanded"), "false");
  assert.equal(await advanced.getAttribute("title"), REVENUE_ADVANCED.join(", "));
  await page.close();

  // A deep link to Setup opens the group with Setup lit.
  const deep = await app.open({ path: "/c/acme/revenue/setup", routes: QUIET });
  const deepRail = desktopRail(deep.page);
  await deepRail.getByRole("link", { name: "Setup" }).waitFor();
  assert.equal(await railAdvanced(deepRail).getAttribute("aria-expanded"), "true");
  assert.equal(
    await deepRail.getByRole("link", { name: "Setup" }).getAttribute("aria-current"),
    "page",
  );
  await shotWhole(deep.page, "ux-revenue-rail-advanced-open");
  await deep.page.close();
});

// ─────────────────────────── Decision stack ───────────────────────────

function decisionRoutes(rules: DecisionPolicyRule[]): ApiRoute[] {
  const settings: DecisionStackSettings = {
    enabled: true,
    instructions: "Only ask us about spending over $500.",
    usingDefaultInstructions: false,
    pendingDecisions: 0,
    canManage: true,
  };
  return [
    ...QUIET,
    ["GET", `${API}/decision-stack/settings`, () => settings],
    ["GET", `${API}/decision-policies`, () => rules],
    ["GET", `${API}/employees`, () => [ALEX, RILEY]],
    ["GET", `${API}/decisions`, () => []],
    ["GET", `${API}/approvals`, () => []],
  ];
}

await app.check("Decision stack: routing sits under Advanced in its Settings, not behind a button on the stack", async () => {
  const stack = await app.open({ path: "/c/acme/decisions", routes: decisionRoutes([]) });
  await stack.page.getByRole("heading", { name: "Decision stack", exact: true }).waitFor();
  assert.equal(await stack.page.getByRole("button", { name: "Routing", exact: true }).count(), 0);
  await stack.page.close();

  const view = await app.open({
    path: "/c/acme/decisions/settings",
    routes: decisionRoutes([
      {
        id: "rule-1",
        askingEmployeeId: "alex",
        deciderKind: "employee",
        deciderEmployeeId: "riley",
        sortOrder: 0,
        enabled: true,
        createdAt: hoursAgo(10),
      },
    ]),
  });
  const { page } = view;
  const advanced = disclosure(page, "Advanced");
  await closedWith(advanced, "1 routing rule", "Advanced");
  assert.equal(await page.getByRole("heading", { name: "Routing", exact: true }).count(), 0);
  // The basics are up front.
  await page.getByRole("switch", { name: "Let AI Employees add decisions" }).waitFor();
  await page.getByRole("textbox", { name: "Instructions", exact: true }).waitFor();
  await view.click(advanced);
  await page.getByRole("heading", { name: "Routing", exact: true }).waitFor();
  await page.getByRole("listitem").filter({ hasText: "Riley Chen" }).getByText("Alex Rivera").waitFor();
  await shotWhole(page, "ux-decision-settings-routing");
  await page.close();
});

// ─────────────────────────── Settings → Company ───────────────────────────

await app.check("Settings → Company: the basics up front, web address and two-factor under a closed Advanced", async () => {
  const view = await app.open({ path: "/c/acme/settings/company", routes: QUIET });
  const { page } = view;
  for (const label of ["Name", "Mission", "Vision"]) {
    await page.getByLabel(label, { exact: true }).waitFor();
  }
  await page.getByRole("combobox", { name: "Time zone" }).waitFor();
  const advanced = disclosure(page, "Advanced");
  await closedWith(advanced, "Web address /c/acme · Two-factor sign-in optional", "Advanced");
  assert.equal(await page.getByLabel("Web address", { exact: true }).isVisible(), false);
  assert.equal(await page.getByText("Slug", { exact: true }).count(), 0, "no Slug label");
  await view.click(advanced);
  const address = page.getByLabel("Web address", { exact: true });
  await address.waitFor();
  assert.equal(await address.inputValue(), "acme");
  // Typing a new address updates the line, still before saving.
  await address.fill("acme-co");
  await advanced.getByText("Web address /c/acme-co · Two-factor sign-in optional", { exact: true }).waitFor();
  await page.getByRole("checkbox", { name: /Require two-factor authentication/ }).check();
  await advanced.getByText("Web address /c/acme-co · Two-factor sign-in required", { exact: true }).waitFor();
  await shotWhole(page, "ux-settings-company");
  await page.close();
});

// ─────────────────────────── Workspace channel ───────────────────────────

function workspaceChannel(): WorkspaceChannel {
  return {
    id: "ch-installs",
    companyId: "company",
    kind: "public",
    name: "installs",
    slug: "installs",
    topic: "Install crew coordination",
    archivedAt: null,
    createdByUserId: ME.id,
    createdAt: hoursAgo(200),
    lastMessageAt: hoursAgo(2),
    members: [{ kind: "user", id: ME.id, name: ME.name, email: ME.email }],
    unreadCount: 0,
    lastReadAt: hoursAgo(2),
  } as WorkspaceChannel;
}

await app.check("Workspace: a channel's incoming webhook waits under Advanced in its settings", async () => {
  const channel = workspaceChannel();
  let webhook = { enabled: false, url: null as string | null };
  const view = await app.open({
    path: "/c/acme/workspace/ch-installs",
    routes: [
      ["GET", `${API}/workspace/channels`, () => [channel]],
      [
        "GET",
        `${API}/workspace/directory`,
        () => ({
          members: [{ id: ME.id, name: ME.name, email: ME.email, handle: "morgan" }],
          employees: [{ id: ALEX.id, name: ALEX.name, slug: ALEX.slug, role: ALEX.role }],
        }),
      ],
      ["GET", `${API}/workspace/mentionables`, () => []],
      ["GET", /\/workspace\/channels\/ch-installs\/messages$/, () => []],
      ["GET", /\/workspace\/channels\/ch-installs\/webhook$/, () => webhook],
      [
        "POST",
        /\/workspace\/channels\/ch-installs\/webhook$/,
        ({ body }) => {
          webhook = body.enabled
            ? { enabled: true, url: "https://acme.example/hooks/ch-installs/fixture" }
            : { enabled: false, url: null };
          return webhook;
        },
      ],
      ["GET", /\/workspace\/channels\/ch-installs$/, () => channel],
      ["POST", /\/workspace\/channels\/ch-installs\/read$/, () => ({ ok: true })],
      ["GET", /\/group-discussions/, () => []],
    ],
  });
  const { page } = view;
  await view.click(page.getByRole("button", { name: "Channel settings" }).first());
  const dialog = page.getByRole("dialog", { name: "Channel settings" });
  await dialog.getByLabel("Name", { exact: true }).waitFor();
  const advanced = disclosure(dialog, "Advanced");
  await closedWith(advanced, "Incoming webhook off", "Advanced");
  assert.equal(
    await dialog.getByRole("button", { name: "Enable incoming webhook" }).count(),
    0,
    "the webhook is tucked away",
  );
  // Archive stays in view: it is not an advanced setting.
  await dialog.getByRole("button", { name: /Archive/ }).waitFor();
  await view.click(advanced);
  await view.click(dialog.getByRole("button", { name: "Enable incoming webhook" }));
  await advanced.getByText("Incoming webhook on", { exact: true }).waitFor();
  await dialog.getByText("https://acme.example/hooks/ch-installs/fixture").waitFor();
  await app.shot(page, "ux-workspace-channel-settings");
  await page.close();
});

// ─────────────────────────── Admin pages ───────────────────────────

await app.check("Admin → General: one card per setting, custom JavaScript under a closed Advanced", async () => {
  const instance: InstanceSettings = { publicUrl: "", configured: true };
  const javascript: CustomJavaScriptSettings = { customJavaScript: "", configured: false };
  const view = await app.open({
    path: "/c/acme/admin/general",
    me: { isMasterAdmin: true },
    routes: [
      ["GET", "/api/admin/instance-settings", () => instance],
      ["GET", "/api/admin/custom-javascript", () => javascript],
      [
        "PUT",
        "/api/admin/custom-javascript",
        ({ body }) => {
          javascript.customJavaScript = String(body.customJavaScript);
          javascript.configured = Boolean(javascript.customJavaScript.trim());
          return javascript;
        },
      ],
    ],
  });
  const { page } = view;
  // The origin the page was opened on is what it compares against.
  instance.publicUrl = await page.evaluate(() => window.location.origin);
  await page.reload();
  await page.getByLabel("Public URL", { exact: true }).waitFor();
  await page.getByText("Configured", { exact: true }).waitFor();
  assert.equal(await page.getByText("Public URL is configured").count(), 0, "no second status card");
  const advanced = disclosure(page, "Advanced");
  await closedWith(advanced, "No custom JavaScript", "Advanced");
  assert.equal(await page.getByLabel("Custom JavaScript", { exact: true }).isVisible(), false);
  await view.click(advanced);
  const box = page.getByLabel("Custom JavaScript", { exact: true });
  await box.fill("window.analytics = true;");
  await advanced
    .getByText("No custom JavaScript · unsaved changes", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: /Save changes/ }).last().click();
  await advanced.getByText("Custom JavaScript on · 1 line", { exact: true }).waitFor();
  await shotWhole(page, "ux-admin-general");
  await page.close();
});

function oauthApp(id: OauthAppDescriptor["app"], label: string, configured: boolean): OauthAppDescriptor {
  return {
    app: id,
    label,
    unlocks: [label],
    consoleUrl: "https://console.example.com",
    steps: ["Create an app.", "Paste its Client ID and Secret here."],
    configured,
    clientId: configured ? `${id}-client-id` : "",
    hasClientSecret: configured,
    redirectUri: `https://acme.example/api/integrations/oauth/callback/${id}`,
    updatedAt: configured ? hoursAgo(5) : null,
  };
}

await app.check("Admin → Integrations: each OAuth app is one closed line saying whether it is registered", async () => {
  const apps = [oauthApp("google", "Google", false), oauthApp("github", "GitHub", true)];
  const view = await app.open({
    path: "/c/acme/admin/integrations",
    me: { isMasterAdmin: true },
    routes: [["GET", "/api/admin/oauth-apps", () => apps]],
  });
  const { page } = view;
  const google = page.getByRole("heading", { level: 2, name: /^Google/ }).getByRole("button");
  const github = page.getByRole("heading", { level: 2, name: /^GitHub/ }).getByRole("button");
  await closedWith(google, "Not registered", "Google");
  await closedWith(github, "Registered", "GitHub");
  assert.equal(await page.getByLabel("Client ID").count(), 2, "both forms are mounted…");
  assert.equal(await page.getByLabel("Client ID").first().isVisible(), false, "…and hidden");
  await view.click(google);
  await page.getByText("Redirect URI to allow-list").first().waitFor();
  await page.locator("#client-id-google").fill("my-google-client");
  await google.getByText("Not registered · unsaved changes", { exact: true }).waitFor();
  await shotWhole(page, "ux-admin-integrations");
  await page.close();
});

await app.check("Admin → Email transport: SMTP basics up front; port, TLS and sender name under Advanced", async () => {
  const transport: GlobalEmailTransport = {
    configured: false,
    source: "none",
    overrideActive: false,
    host: "",
    port: 587,
    secure: false,
    user: "",
    fromName: "Genosyn",
    from: "no-reply@genosyn.local",
    hasPassword: false,
  };
  const view = await app.open({
    path: "/c/acme/admin/email",
    me: { isMasterAdmin: true },
    routes: [["GET", "/api/admin/email-transport", () => transport]],
  });
  const { page } = view;
  for (const label of ["Host", "Username", "Password", "From address"]) {
    await page.getByLabel(label, { exact: true }).waitFor();
  }
  const advanced = disclosure(page, "Advanced");
  await closedWith(advanced, "Port 587 · TLS by port · From “Genosyn”", "Advanced");
  assert.equal(await page.getByLabel("Port", { exact: true }).isVisible(), false);
  assert.equal(await page.getByText(/^Source:/).count(), 0, "no Source line");
  await view.click(advanced);
  await page.getByLabel("Port", { exact: true }).fill("2465");
  await page.getByText("Use implicit TLS").click();
  await advanced.getByText("Port 2465 · Implicit TLS · From “Genosyn”", { exact: true }).waitFor();
  await shotWhole(page, "ux-admin-email-transport");
  await page.close();
});

await app.check("Admin rail: the SQL console and migration ledger wait under a closed Advanced group", async () => {
  const routes: ApiRoute[] = [
    ["GET", "/api/admin/instance-settings", () => ({ publicUrl: "", configured: true })],
    ["GET", "/api/admin/custom-javascript", () => ({ customJavaScript: "", configured: false })],
  ];
  const view = await app.open({ path: "/c/acme/admin/general", me: { isMasterAdmin: true }, routes });
  const rail = desktopRail(view.page);
  await rail.getByRole("link", { name: "Companies" }).waitFor();
  const advanced = railAdvanced(rail);
  assert.equal(await advanced.getAttribute("aria-expanded"), "false");
  assert.equal(await advanced.getAttribute("title"), "Database, Migrations");
  assert.equal(await rail.getByRole("link", { name: "Database" }).count(), 0);
  // Everyday admin pages stay in view.
  for (const name of ["Overview", "General", "Instance Health", "Email transport", "Runtime", "Integrations", "Backups", "Users"]) {
    await rail.getByRole("link", { name, exact: true }).waitFor();
  }
  await view.click(advanced);
  await rail.getByRole("link", { name: "Database" }).waitFor();
  await rail.getByRole("link", { name: "Migrations" }).waitFor();
  await view.page.close();

  // A deep link opens the group with its page lit.
  const deep = await app.open({ path: "/c/acme/admin/migrations", me: { isMasterAdmin: true } });
  const deepRail = desktopRail(deep.page);
  await deepRail.getByRole("link", { name: "Migrations" }).waitFor();
  assert.equal(await railAdvanced(deepRail).getAttribute("aria-expanded"), "true");
  assert.equal(
    await deepRail.getByRole("link", { name: "Migrations" }).getAttribute("aria-current"),
    "page",
  );
  await deep.page.close();
});

// ─────────────────────────── Recruiting → Settings ───────────────────────────

function recruitingSettings(): RecruitingSettingsDto {
  return {
    site: {
      enabled: true,
      visibility: "public",
      title: "",
      effectiveTitle: "Acme",
      headline: "",
      intro: "",
      websiteUrl: "",
      privacyPolicyUrl: "",
      accentColor: "#4f46e5",
      logoUrl: null,
      allowIndexing: true,
      url: "https://acme.example/careers/acme",
      installUrl: "https://acme.example/careers/acme",
      feedUrl: "https://acme.example/careers/acme/feed",
    },
    domain: {
      name: null,
      verifiedAt: null,
      checkedAt: null,
      error: "",
      live: false,
      record: null,
      cnameTarget: "acme.example",
    },
    screening: {
      screener: null,
      autoScreen: true,
      instructions: null,
      effectiveInstructions: DEFAULT_SCREENING_INSTRUCTIONS,
      defaultInstructions: DEFAULT_SCREENING_INSTRUCTIONS,
    },
    emails: {
      confirmationEnabled: true,
      confirmationSubject: null,
      confirmationBody: null,
      effectiveConfirmation: {
        subject: DEFAULT_CONFIRMATION_EMAIL_SUBJECT,
        body: DEFAULT_CONFIRMATION_EMAIL_BODY,
      },
      defaultConfirmation: {
        subject: DEFAULT_CONFIRMATION_EMAIL_SUBJECT,
        body: DEFAULT_CONFIRMATION_EMAIL_BODY,
      },
      rejectionSubject: null,
      rejectionBody: null,
      effectiveRejection: {
        subject: DEFAULT_REJECTION_EMAIL_SUBJECT,
        body: DEFAULT_REJECTION_EMAIL_BODY,
      },
      defaultRejection: {
        subject: DEFAULT_REJECTION_EMAIL_SUBJECT,
        body: DEFAULT_REJECTION_EMAIL_BODY,
      },
      sender: { source: "console", fromAddress: "", delivers: false },
    },
  } as RecruitingSettingsDto;
}

await app.check("Recruiting → Settings: each applicant email keeps Send it in view and its editor behind one line", async () => {
  const view = await app.open({
    path: "/c/acme/recruiting/settings",
    routes: [
      ["GET", `${API}/recruiting/settings`, () => recruitingSettings()],
      ["GET", `${API}/employees`, () => [ALEX]],
    ],
  });
  const { page } = view;
  await page.getByText("Application received", { exact: true }).waitFor();
  await page.getByRole("checkbox", { name: "Send it" }).waitFor();
  const editors = page.getByRole("button", { name: /^Edit the email/ });
  assert.equal(await editors.count(), 2);
  await closedWith(
    editors.nth(0),
    `Default wording · “${DEFAULT_CONFIRMATION_EMAIL_SUBJECT}”`,
    "Application received",
  );
  await closedWith(
    editors.nth(1),
    `Default wording · “${DEFAULT_REJECTION_EMAIL_SUBJECT}”`,
    "Not moving forward",
  );
  assert.equal(await page.getByLabel("Subject", { exact: true }).first().isVisible(), false);
  await view.click(editors.nth(0));
  await page.getByLabel("Subject", { exact: true }).first().fill("Thanks for applying!");
  await editors
    .nth(0)
    .getByText(`Default wording · “${DEFAULT_CONFIRMATION_EMAIL_SUBJECT}” · unsaved changes`, {
      exact: true,
    })
    .waitFor();
  await shotWhole(page, "ux-recruiting-settings");
  await page.close();
});

// ─────────────────────────── phone width ───────────────────────────

await app.check("phone width: each page keeps its Advanced closed, with its line, and nothing scrolls sideways", async () => {
  const pages: Array<{
    path: string;
    routes: ApiRoute[];
    master?: boolean;
    title: string;
    summary: string;
    shot: string;
  }> = [
    {
      path: "/c/acme/settings/company",
      routes: QUIET,
      title: "Advanced",
      summary: "Web address /c/acme · Two-factor sign-in optional",
      shot: "ux-phone-settings-company",
    },
    {
      path: "/c/acme/decisions/settings",
      routes: decisionRoutes([]),
      title: "Advanced",
      summary: "No routing rules · every question goes to people",
      shot: "ux-phone-decision-settings",
    },
    {
      path: "/c/acme/admin/email",
      master: true,
      routes: [
        [
          "GET",
          "/api/admin/email-transport",
          () => ({
            configured: true,
            source: "database",
            overrideActive: true,
            host: "smtp.example.com",
            port: 587,
            secure: false,
            user: "no-reply@example.com",
            fromName: "Acme",
            from: "no-reply@example.com",
            hasPassword: true,
          }),
        ],
      ],
      title: "Advanced",
      summary: "Port 587 · TLS by port · From “Acme”",
      shot: "ux-phone-admin-email",
    },
    {
      path: "/c/acme/recruiting/settings",
      routes: [
        ["GET", `${API}/recruiting/settings`, () => recruitingSettings()],
        ["GET", `${API}/employees`, () => [ALEX]],
      ],
      title: "Edit the email",
      summary: `Default wording · “${DEFAULT_CONFIRMATION_EMAIL_SUBJECT}”`,
      shot: "ux-phone-recruiting-settings",
    },
  ];
  for (const entry of pages) {
    const view = await app.open({
      path: entry.path,
      routes: entry.routes,
      touch: true,
      ...(entry.master ? { me: { isMasterAdmin: true } } : {}),
    });
    const { page } = view;
    const toggle = disclosure(page, entry.title);
    await closedWith(toggle, entry.summary, `${entry.path} on a phone`);
    await noSidewaysScroll(page, `${entry.path} on a phone, closed`);
    await toggle.click();
    assert.equal(await toggle.getAttribute("aria-expanded"), "true");
    await noSidewaysScroll(page, `${entry.path} on a phone, open`);
    await shotWhole(page, entry.shot);
    await page.close();
  }
});

await app.finish();
