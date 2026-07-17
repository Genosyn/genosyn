/**
 * Record-link columns: Base fields whose cells point at records elsewhere in
 * Genosyn — finance Customers, Invoices, task Projects, AI Employees, human
 * Members, Notes, and Pipelines. Cells store arrays of ids (user ids for
 * `member`); this module resolves those ids to display labels + deep-link
 * URLs so the grid, the record page, and the agent tools can render them
 * without one fetch per product.
 */

import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { BaseField, BaseFieldType } from "../db/entities/BaseField.js";
import { Company } from "../db/entities/Company.js";
import { Customer } from "../db/entities/Customer.js";
import { Invoice } from "../db/entities/Invoice.js";
import { Project } from "../db/entities/Project.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { Note } from "../db/entities/Note.js";
import { Notebook } from "../db/entities/Notebook.js";
import { Pipeline } from "../db/entities/Pipeline.js";
import { listAccessibleProjectIds, ProjectActor } from "./projects.js";

export const RESOURCE_FIELD_TYPES = [
  "customer",
  "invoice",
  "project",
  "employee",
  "member",
  "note",
  "pipeline",
] as const;

export type ResourceFieldType = (typeof RESOURCE_FIELD_TYPES)[number];

export function isResourceFieldType(t: string): t is ResourceFieldType {
  return (RESOURCE_FIELD_TYPES as readonly string[]).includes(t);
}

/**
 * One pickable/renderable target record. `url` is an app-relative path the
 * client can navigate to, or "" when the product has no per-record page
 * (members). `archived` marks soft-deleted rows — kept in the map so stale
 * cells still resolve to a label, but pickers hide them from the add list.
 */
export type ResourceOption = {
  id: string;
  label: string;
  sublabel: string;
  url: string;
  archived?: boolean;
};

/**
 * Build `{resourceType → options}` for the resource-link fields present in
 * `fields`. Only the products actually referenced are queried.
 *
 * `maxPerKind` mirrors buildLinkOptionsFor's `maxPerTable`: the UI leaves it
 * unset (the picker needs everything), the agent tools cap it so a single
 * column doesn't drag every customer into model context.
 *
 * `projectViewer` scopes the `project` options to what the caller may see —
 * restricted projects are filtered the same way the Projects list filters
 * them. Omitting it includes every project.
 */
export async function buildResourceOptionsFor(
  companyId: string,
  fields: BaseField[],
  opts?: { maxPerKind?: number; projectViewer?: ProjectActor },
): Promise<Record<string, ResourceOption[]>> {
  const kinds = new Set<ResourceFieldType>();
  for (const f of fields) {
    if (isResourceFieldType(f.type)) kinds.add(f.type);
  }
  if (kinds.size === 0) return {};

  const company = await AppDataSource.getRepository(Company).findOneBy({
    id: companyId,
  });
  if (!company) return {};
  const prefix = `/c/${company.slug}`;

  const out: Record<string, ResourceOption[]> = {};
  const max = opts?.maxPerKind ?? Infinity;

  const loaders: Record<ResourceFieldType, () => Promise<ResourceOption[]>> = {
    customer: async () => {
      const rows = await AppDataSource.getRepository(Customer).find({
        where: { companyId },
        order: { name: "ASC" },
      });
      return rows.map((c) => ({
        id: c.id,
        label: c.name,
        sublabel: c.email || "",
        url: `${prefix}/customers/${c.slug}`,
        ...(c.archivedAt ? { archived: true } : {}),
      }));
    },
    invoice: async () => {
      const rows = await AppDataSource.getRepository(Invoice).find({
        where: { companyId },
        order: { createdAt: "DESC" },
      });
      return rows.map((i) => ({
        id: i.id,
        label: i.number && i.number.trim() ? i.number : `Draft ${i.slug}`,
        sublabel: i.status,
        url: `${prefix}/finance/invoices/${i.slug}`,
      }));
    },
    project: async () => {
      const rows = await AppDataSource.getRepository(Project).find({
        where: { companyId },
        order: { name: "ASC" },
      });
      const visible = opts?.projectViewer
        ? await listAccessibleProjectIds(companyId, opts.projectViewer)
        : null;
      return rows
        .filter((p) => !visible || visible.has(p.id))
        .map((p) => ({
          id: p.id,
          label: p.name,
          sublabel: p.key,
          url: `${prefix}/tasks/p/${p.slug}`,
        }));
    },
    employee: async () => {
      const rows = await AppDataSource.getRepository(AIEmployee).find({
        where: { companyId },
        order: { name: "ASC" },
      });
      return rows.map((e) => ({
        id: e.id,
        label: e.name,
        sublabel: e.role,
        url: `${prefix}/employees/${e.slug}/chat`,
      }));
    },
    member: async () => {
      const memberships = await AppDataSource.getRepository(Membership).find({
        where: { companyId },
      });
      if (memberships.length === 0) return [];
      const users = await AppDataSource.getRepository(User).find({
        where: { id: In(memberships.map((m) => m.userId)) },
      });
      const byId = new Map(users.map((u) => [u.id, u]));
      return memberships
        .map((m) => {
          const u = byId.get(m.userId);
          if (!u) return null;
          return {
            id: u.id,
            label: u.name,
            sublabel: u.email,
            url: "",
          };
        })
        .filter((x): x is ResourceOption => !!x)
        .sort((a, b) => a.label.localeCompare(b.label));
    },
    note: async () => {
      const rows = await AppDataSource.getRepository(Note).find({
        where: { companyId },
        order: { title: "ASC" },
      });
      if (rows.length === 0) return [];
      const notebooks = await AppDataSource.getRepository(Notebook).find({
        where: { companyId },
      });
      const nbById = new Map(notebooks.map((nb) => [nb.id, nb]));
      return rows.map((n) => {
        const nb = nbById.get(n.notebookId);
        return {
          id: n.id,
          label: n.title,
          sublabel: nb?.title ?? "",
          url: nb ? `${prefix}/notes/${nb.slug}/${n.slug}` : "",
          ...(n.archivedAt ? { archived: true } : {}),
        };
      });
    },
    pipeline: async () => {
      const rows = await AppDataSource.getRepository(Pipeline).find({
        where: { companyId },
        order: { name: "ASC" },
      });
      return rows.map((p) => ({
        id: p.id,
        label: p.name,
        sublabel: p.enabled ? "Enabled" : "Paused",
        url: `${prefix}/pipelines/${p.slug}`,
      }));
    },
  };

  await Promise.all(
    Array.from(kinds).map(async (kind) => {
      const options = await loaders[kind]();
      out[kind] = Number.isFinite(max) ? options.slice(0, max) : options;
    }),
  );
  return out;
}

/** Human-readable per-type labels shared by the assistant prompt + tools. */
export const RESOURCE_TYPE_LABELS: Record<ResourceFieldType, string> = {
  customer: "linked Customers",
  invoice: "linked Invoices",
  project: "linked Projects",
  employee: "linked AI Employees",
  member: "linked Members",
  note: "linked Notes",
  pipeline: "linked Pipelines",
};

/** BaseFieldType helper so route files can accept both flavours cleanly. */
export const ALL_RESOURCE_FIELD_TYPES: BaseFieldType[] = [
  ...RESOURCE_FIELD_TYPES,
];
