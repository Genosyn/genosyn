/**
 * Templates for new Bases. Shipped as in-code constants (same philosophy as
 * employee templates) so they evolve via PRs, not admin UI. Each template
 * declares the tables/fields/starter-rows that a new Base should be seeded
 * with; links between tables use a `linkKey` indirection so we can stitch the
 * real table ids together after creation.
 */

import type { BaseFieldType } from "../db/entities/BaseField.js";

export type TemplateSelectOption = { label: string; color: string };

export type TemplateField = {
  key: string;
  name: string;
  type: BaseFieldType;
  isPrimary?: boolean;
  options?: TemplateSelectOption[];
  /** For `link` fields: the sibling table in this template to point at. */
  linkTableKey?: string;
};

export type TemplateRowCell =
  | string
  | number
  | boolean
  | null
  | string[]
  /** Link cell uses the primary-field value(s) of the target table. */
  | { linkTo: string[] };

export type TemplateRow = Record<string, TemplateRowCell>;

export type TemplateTable = {
  key: string;
  name: string;
  fields: TemplateField[];
  rows: TemplateRow[];
};

export type BaseTemplate = {
  id: string;
  name: string;
  tagline: string;
  icon: string;
  color: string;
  description: string;
  tables: TemplateTable[];
};

export const BASE_TEMPLATES: BaseTemplate[] = [
  {
    id: "blank",
    name: "Blank",
    tagline: "Start from scratch with one empty table.",
    icon: "Database",
    color: "slate",
    description: "",
    tables: [
      {
        key: "table",
        name: "Table 1",
        fields: [
          { key: "name", name: "Name", type: "text", isPrimary: true },
          { key: "notes", name: "Notes", type: "longtext" },
          {
            key: "status",
            name: "Status",
            type: "select",
            options: [
              { label: "Todo", color: "slate" },
              { label: "Doing", color: "amber" },
              { label: "Done", color: "emerald" },
            ],
          },
        ],
        rows: [],
      },
    ],
  },

  {
    id: "crm",
    name: "CRM",
    tagline: "Contacts, companies, and deals with links between them.",
    icon: "Users",
    color: "indigo",
    description:
      "Track people, the companies they work at, and the deals you're running. Contacts link to Companies; Deals link to both.",
    tables: [
      {
        key: "contacts",
        name: "Contacts",
        fields: [
          { key: "name", name: "Name", type: "text", isPrimary: true },
          { key: "email", name: "Email", type: "email" },
          { key: "title", name: "Title", type: "text" },
          { key: "company", name: "Company", type: "link", linkTableKey: "companies" },
          { key: "notes", name: "Notes", type: "longtext" },
        ],
        rows: [
          {
            name: "Ada Lovelace",
            email: "ada@analytical.engine",
            title: "Mathematician",
            company: { linkTo: ["Analytical Engine Co."] },
            notes: "Early adopter. Cares about correctness above all.",
          },
          {
            name: "Grace Hopper",
            email: "grace@mark-one.mil",
            title: "Rear Admiral",
            company: { linkTo: ["Mark One Systems"] },
            notes: "",
          },
        ],
      },
      {
        key: "companies",
        name: "Companies",
        fields: [
          { key: "name", name: "Name", type: "text", isPrimary: true },
          { key: "website", name: "Website", type: "url" },
          {
            key: "stage",
            name: "Stage",
            type: "select",
            options: [
              { label: "Lead", color: "slate" },
              { label: "Qualified", color: "sky" },
              { label: "Customer", color: "emerald" },
              { label: "Churned", color: "rose" },
            ],
          },
          { key: "headcount", name: "Headcount", type: "number" },
        ],
        rows: [
          { name: "Analytical Engine Co.", website: "https://aec.example", stage: "Qualified", headcount: 42 },
          { name: "Mark One Systems", website: "https://mark.example", stage: "Customer", headcount: 180 },
        ],
      },
      {
        key: "deals",
        name: "Deals",
        fields: [
          { key: "name", name: "Deal", type: "text", isPrimary: true },
          { key: "company", name: "Company", type: "link", linkTableKey: "companies" },
          { key: "contact", name: "Primary contact", type: "link", linkTableKey: "contacts" },
          { key: "value", name: "Value", type: "number" },
          {
            key: "stage",
            name: "Stage",
            type: "select",
            options: [
              { label: "Prospect", color: "slate" },
              { label: "Demo", color: "sky" },
              { label: "Proposal", color: "violet" },
              { label: "Closed Won", color: "emerald" },
              { label: "Closed Lost", color: "rose" },
            ],
          },
          { key: "close", name: "Expected close", type: "date" },
        ],
        rows: [
          {
            name: "AEC — Pilot",
            company: { linkTo: ["Analytical Engine Co."] },
            contact: { linkTo: ["Ada Lovelace"] },
            value: 12000,
            stage: "Proposal",
            close: null,
          },
        ],
      },
    ],
  },

  {
    id: "applicants",
    name: "Applicant Tracker",
    tagline: "Candidates, roles, and where they are in the funnel.",
    icon: "UserCheck",
    color: "emerald",
    description: "Track open roles and candidates through your hiring pipeline.",
    tables: [
      {
        key: "roles",
        name: "Roles",
        fields: [
          { key: "title", name: "Title", type: "text", isPrimary: true },
          { key: "team", name: "Team", type: "text" },
          {
            key: "status",
            name: "Status",
            type: "select",
            options: [
              { label: "Draft", color: "slate" },
              { label: "Open", color: "emerald" },
              { label: "Paused", color: "amber" },
              { label: "Closed", color: "rose" },
            ],
          },
        ],
        rows: [
          { title: "Founding Engineer", team: "Engineering", status: "Open" },
          { title: "Design Partner", team: "Design", status: "Draft" },
        ],
      },
      {
        key: "candidates",
        name: "Candidates",
        fields: [
          { key: "name", name: "Name", type: "text", isPrimary: true },
          { key: "email", name: "Email", type: "email" },
          { key: "role", name: "Role", type: "link", linkTableKey: "roles" },
          {
            key: "stage",
            name: "Stage",
            type: "select",
            options: [
              { label: "Applied", color: "slate" },
              { label: "Screen", color: "sky" },
              { label: "Onsite", color: "violet" },
              { label: "Offer", color: "amber" },
              { label: "Hired", color: "emerald" },
              { label: "Rejected", color: "rose" },
            ],
          },
          { key: "notes", name: "Notes", type: "longtext" },
        ],
        rows: [
          {
            name: "Linus Torvalds",
            email: "linus@example.com",
            role: { linkTo: ["Founding Engineer"] },
            stage: "Onsite",
            notes: "Strong C background. Direct communicator.",
          },
        ],
      },
    ],
  },

  {
    id: "content",
    name: "Content Calendar",
    tagline: "Drafts, publish dates, owners.",
    icon: "PenLine",
    color: "violet",
    description: "Plan posts across channels with owners and due dates.",
    tables: [
      {
        key: "posts",
        name: "Posts",
        fields: [
          { key: "title", name: "Title", type: "text", isPrimary: true },
          {
            key: "channel",
            name: "Channel",
            type: "select",
            options: [
              { label: "Blog", color: "slate" },
              { label: "X", color: "sky" },
              { label: "LinkedIn", color: "indigo" },
              { label: "Newsletter", color: "violet" },
            ],
          },
          {
            key: "status",
            name: "Status",
            type: "select",
            options: [
              { label: "Idea", color: "slate" },
              { label: "Draft", color: "amber" },
              { label: "Ready", color: "sky" },
              { label: "Published", color: "emerald" },
            ],
          },
          { key: "owner", name: "Owner", type: "text" },
          { key: "publish", name: "Publish on", type: "date" },
          { key: "link", name: "Link", type: "url" },
        ],
        rows: [
          { title: "Why we built Genosyn", channel: "Blog", status: "Draft", owner: "Wren", publish: null, link: null },
          { title: "Launch thread", channel: "X", status: "Idea", owner: "Sam", publish: null, link: null },
        ],
      },
    ],
  },

  {
    id: "projects",
    name: "Project Tracker",
    tagline: "Projects with tasks and owners.",
    icon: "FolderKanban",
    color: "sky",
    description: "Heavier than Tasks — use this when you want spreadsheet-shaped planning.",
    tables: [
      {
        key: "projects",
        name: "Projects",
        fields: [
          { key: "name", name: "Project", type: "text", isPrimary: true },
          { key: "owner", name: "Owner", type: "text" },
          {
            key: "status",
            name: "Status",
            type: "select",
            options: [
              { label: "Planning", color: "slate" },
              { label: "Active", color: "emerald" },
              { label: "Paused", color: "amber" },
              { label: "Shipped", color: "sky" },
            ],
          },
          { key: "start", name: "Start", type: "date" },
          { key: "end", name: "End", type: "date" },
        ],
        rows: [{ name: "Q3 Platform", owner: "Ivy", status: "Active", start: null, end: null }],
      },
      {
        key: "tasks",
        name: "Tasks",
        fields: [
          { key: "title", name: "Task", type: "text", isPrimary: true },
          { key: "project", name: "Project", type: "link", linkTableKey: "projects" },
          { key: "done", name: "Done", type: "checkbox" },
          { key: "due", name: "Due", type: "date" },
        ],
        rows: [
          { title: "Spike on rate limits", project: { linkTo: ["Q3 Platform"] }, done: false, due: null },
          { title: "Write migration plan", project: { linkTo: ["Q3 Platform"] }, done: true, due: null },
        ],
      },
    ],
  },
];

export function findBaseTemplate(id: string): BaseTemplate | undefined {
  return BASE_TEMPLATES.find((t) => t.id === id);
}
