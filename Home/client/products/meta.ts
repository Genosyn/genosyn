import {
  BarChart3,
  Building2,
  GitBranch,
  Landmark,
  Library,
  ListTodo,
  Mail,
  Megaphone,
  MessageSquare,
  StickyNote,
  Table2,
  TrendingUp,
  Users,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import type { Dept } from "@/sections/Kit";
import { ROLES } from "@/roles/data";

/**
 * Presentation facts for each product that the registry (pure copy) leaves
 * out: its department hue, its icon, and a one-line "what it holds" that fits
 * on a tile. A product added to data.ts without an entry here still renders,
 * falling back to its category and summary.
 */

export const PRODUCT_DEPT: Record<string, Dept> = {
  "ai-employees": "operations",
  workspace: "workspace",
  tasks: "workspace",
  bases: "operations",
  notes: "workspace",
  resources: "workspace",
  pipelines: "operations",
  explore: "operations",
  marketing: "marketing",
  revenue: "revenue",
  email: "email",
  customers: "revenue",
  finance: "finance",
  repositories: "repositories",
};

export const PRODUCT_ICON: Record<string, LucideIcon> = {
  "ai-employees": Users,
  workspace: MessageSquare,
  tasks: ListTodo,
  bases: Table2,
  notes: StickyNote,
  resources: Library,
  pipelines: Workflow,
  explore: BarChart3,
  marketing: Megaphone,
  revenue: TrendingUp,
  email: Mail,
  customers: Building2,
  finance: Landmark,
  repositories: GitBranch,
};

export const PRODUCT_HOLDS: Record<string, string> = {
  "ai-employees": "Souls, Skills, Routines, and every Run transcribed",
  workspace: "Channels, DMs, threads and files",
  tasks: "Projects and todos for a person or an AI Employee",
  bases: "Typed tables with saved views and forms",
  notes: "Markdown pages in nested notebooks",
  resources: "URLs, PDFs, EPUBs and transcripts, searchable",
  pipelines: "Triggers, branches, delays, and an ask-an-employee node",
  explore: "SQL saved as Charts, pinned to Dashboards",
  marketing: "Campaigns, Creative, Experiments and a monthly Budget",
  revenue: "Contacts, Deals, Sequences and product Signals",
  email: "Your mailbox, with read, draft or send Grants",
  customers: "Accounts, contracts, ACV and aged statements",
  finance: "Invoices, bills, a double-entry ledger, period close",
  repositories: "Git repositories and Work sessions on branches",
};

export function productDept(slug: string): Dept {
  return PRODUCT_DEPT[slug] ?? "operations";
}

/** The roles that work inside a product, by their short names. */
export function workedBy(slug: string): string[] {
  return ROLES.filter((role) => role.products.includes(slug)).map((role) => role.name);
}
