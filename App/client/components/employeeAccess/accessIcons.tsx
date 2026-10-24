import {
  BarChart3,
  Building2,
  CalendarDays,
  FolderGit2,
  KeyRound,
  Laptop,
  Library,
  Mail,
  NotebookPen,
  Plug,
  Repeat,
  Table2,
  type LucideIcon,
} from "lucide-react";
import type { AccessGroupKey } from "@/lib/employeeAccess";

/** Each group's icon on the Access page, matching the section it belongs to. */
export const ACCESS_GROUP_ICON: Record<AccessGroupKey, LucideIcon> = {
  connections: Plug,
  mail: Mail,
  calendars: CalendarDays,
  repositories: FolderGit2,
  notes: NotebookPen,
  bases: Table2,
  explore: BarChart3,
  resources: Library,
  vault: KeyRound,
  member_browsers: Laptop,
  routines: Repeat,
  sections: Building2,
};

/**
 * Where to add more of a group, under `/c/<slug>` — shown when the group is
 * empty, and as the group's way out to its own section.
 */
export const ACCESS_GROUP_HOME: Record<AccessGroupKey, { path: string; label: string; empty: string } | null> = {
  connections: {
    path: "/settings/integrations",
    label: "Integrations",
    empty: "No Connections yet. Connect Stripe, GitHub or Google Workspace in Integrations.",
  },
  mail: { path: "/mail/settings", label: "Email", empty: "No mailboxes yet. Connect one in Email → Settings." },
  calendars: {
    path: "/meetings/calendars",
    label: "Meetings",
    empty: "No calendars yet. Connect one in Meetings → Calendars.",
  },
  repositories: {
    path: "/repositories",
    label: "Repositories",
    empty: "No Repositories yet. Add one in Repositories.",
  },
  notes: { path: "/notes", label: "Notes", empty: "No notebooks yet." },
  bases: { path: "/bases", label: "Bases", empty: "No Bases yet. Create one in Bases." },
  explore: {
    path: "/explore",
    label: "Explore",
    empty: "No charts or dashboards yet. Build one in Explore.",
  },
  resources: { path: "/resources", label: "Resources", empty: "No Resources yet." },
  vault: { path: "/vault", label: "Vault", empty: "No Vault items you can see yet." },
  member_browsers: {
    path: "/settings/browsers",
    label: "Member browsers",
    empty: "No Member browsers yet. Connect your own Chrome in Settings → Member browsers.",
  },
  routines: { path: "/routines/ai-access", label: "Routines", empty: "" },
  sections: null,
};
