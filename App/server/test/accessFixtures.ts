import { randomUUID } from "node:crypto";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Base } from "../db/entities/Base.js";
import { CalendarAccount } from "../db/entities/CalendarAccount.js";
import { Chart } from "../db/entities/Chart.js";
import { Dashboard } from "../db/entities/Dashboard.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import type { Role } from "../db/entities/Membership.js";
import { Membership } from "../db/entities/Membership.js";
import { Note } from "../db/entities/Note.js";
import { Notebook } from "../db/entities/Notebook.js";
import { Repository } from "../db/entities/Repository.js";
import { Resource } from "../db/entities/Resource.js";
import { User } from "../db/entities/User.js";
import { createMemberBrowser } from "../services/memberBrowsers.js";
import { createVaultItem } from "../services/vault.js";
import { insert } from "./dbHarness.js";

/**
 * One of every grantable thing, for tests of the Access page and its bulk
 * changes. Rows go straight into the tables (as `dbHarness` does everywhere);
 * a Vault item and a Member browser go through their services, which own the
 * encryption and pairing-code hashing those rows need.
 */

export type Grantables = {
  connection: IntegrationConnection;
  mailAccount: MailAccount;
  calendar: CalendarAccount;
  repository: Repository;
  notebook: Notebook;
  note: Note;
  subNote: Note;
  archivedNote: Note;
  base: Base;
  chart: Chart;
  dashboard: Dashboard;
  resource: Resource;
  /** Added by `owner`, visible to the whole company. */
  vaultItemId: string;
  /** Added by `owner`, restricted to its managers. */
  restrictedVaultItemId: string;
  /** Connected by `owner`. */
  ownerBrowserId: string;
  /** Connected by `colleague`. */
  colleagueBrowserId: string;
};

export async function addMember(
  companyId: string,
  role: Role,
  values: Partial<User> = {},
): Promise<User> {
  const user = await insert(User, {
    email: `${role}-${randomUUID()}@example.test`,
    name: values.name ?? `Test ${role}`,
    passwordHash: "x",
    emailVerifiedAt: new Date(),
    sessionVersion: 0,
    ...values,
  });
  await insert(Membership, { companyId, userId: user.id, role });
  return user;
}

export async function addEmployee(companyId: string, name = "Ada"): Promise<AIEmployee> {
  return insert(AIEmployee, {
    companyId,
    name,
    slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID().slice(0, 6)}`,
    role: "Chief of Staff",
  });
}

/** One of each, in `companyId`, the Vault item and `ownerBrowser` owned by `owner`. */
export async function seedGrantables(
  companyId: string,
  owner: { id: string; role: Role },
  colleague: { id: string },
  suffix = randomUUID().slice(0, 8),
): Promise<Grantables> {
  const connection = await insert(IntegrationConnection, {
    companyId,
    provider: "stripe",
    label: `Stripe live ${suffix}`,
    authMode: "apikey",
    encryptedConfig: "unused-in-these-tests",
    accountHint: "acct_123",
  });
  const mailAccount = await insert(MailAccount, {
    companyId,
    connectionId: `mail-connection-${suffix}`,
    provider: "gmail",
    address: `ops-${suffix}@acme.test`,
  });
  const calendar = await insert(CalendarAccount, {
    companyId,
    connectionId: `calendar-connection-${suffix}`,
    calendarId: "primary",
    address: `team-${suffix}@acme.test`,
    displayName: `Team calendar ${suffix}`,
  });
  const repository = await insert(Repository, {
    companyId,
    name: `Website ${suffix}`,
    slug: `website-${suffix}`,
    gitUrl: "https://example.test/acme/website.git",
  });
  const notebook = await insert(Notebook, {
    companyId,
    title: `Playbooks ${suffix}`,
    slug: `playbooks-${suffix}`,
  });
  const note = await insert(Note, {
    companyId,
    notebookId: notebook.id,
    title: `Refund policy ${suffix}`,
    slug: `refund-policy-${suffix}`,
    body: "Refunds within 30 days.",
  });
  const subNote = await insert(Note, {
    companyId,
    notebookId: notebook.id,
    parentId: note.id,
    title: `Refund exceptions ${suffix}`,
    slug: `refund-exceptions-${suffix}`,
    body: "Exceptions.",
  });
  const archivedNote = await insert(Note, {
    companyId,
    notebookId: notebook.id,
    title: `Old policy ${suffix}`,
    slug: `old-policy-${suffix}`,
    body: "Gone.",
    archivedAt: new Date(),
  });
  const base = await insert(Base, { companyId, name: `Leads ${suffix}`, slug: `leads-${suffix}` });
  const chart = await insert(Chart, {
    companyId,
    title: `MRR ${suffix}`,
    slug: `mrr-${suffix}`,
    connectionId: connection.id,
  });
  const dashboard = await insert(Dashboard, {
    companyId,
    title: `Board metrics ${suffix}`,
    slug: `board-metrics-${suffix}`,
  });
  const resource = await insert(Resource, {
    companyId,
    title: `Brand guide ${suffix}`,
    slug: `brand-guide-${suffix}`,
    sourceKind: "text",
    bodyText: "Use the indigo.",
    status: "ready",
  });
  const payload = (title: string) => ({
    title,
    username: "ops@acme.test",
    secret: "s3cret",
    websiteUrl: "https://example.test",
    notes: "",
    totp: null,
    passkeys: [],
    passkeyRegistrationLease: null,
  });
  const vault = await createVaultItem({
    companyId,
    actor: { userId: owner.id, role: owner.role },
    type: "login",
    visibility: "company",
    payload: payload(`Stripe dashboard ${suffix}`),
  });
  const restricted = await createVaultItem({
    companyId,
    actor: { userId: owner.id, role: owner.role },
    type: "login",
    visibility: "restricted",
    payload: payload(`Bank portal ${suffix}`),
  });
  const ownerBrowser = await createMemberBrowser({
    companyId,
    ownerUserId: owner.id,
    name: `Work laptop ${suffix}`,
  });
  const colleagueBrowser = await createMemberBrowser({
    companyId,
    ownerUserId: colleague.id,
    name: `Home desktop ${suffix}`,
  });
  return {
    connection,
    mailAccount,
    calendar,
    repository,
    notebook,
    note,
    subNote,
    archivedNote,
    base,
    chart,
    dashboard,
    resource,
    vaultItemId: vault.id,
    restrictedVaultItemId: restricted.id,
    ownerBrowserId: ownerBrowser.browser.id,
    colleagueBrowserId: colleagueBrowser.browser.id,
  };
}
