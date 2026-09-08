/** Portable contract for the setup page and the server-owned starter catalogue. */
export type ProactiveRequirement =
  | "mail"
  | "financeRead"
  | "financeInvoice"
  | "revenueWrite"
  | "repositoryWrite"
  | "calendarRead";
export type ProactiveRecipe = {
  id: string;
  name: string;
  description: string;
  kind: "email" | "routine";
  category?: string;
  schedule?: string;
  scheduleLabel?: string;
  triggerKind?: string;
  requirements: ProactiveRequirement[];
  brief: string;
  acceptanceCriteria: string;
};
export type ProactiveEmployee = {
  id: string;
  name: string;
  slug: string;
  modelReady: boolean;
  financeAccess: string | null;
  revenueAccess: string | null;
  repositoryWrite: boolean;
  calendarRead: boolean;
  mailGrants: { accountId: string; accessLevel: string }[];
};
export type ProactiveMailbox = {
  id: string;
  address: string;
  status: string;
  analysisEnabled: boolean;
};
export type ProactiveInstallation = {
  id: string;
  recipeId: string;
  employeeId: string;
  accountId: string | null;
  name: string;
  enabled: boolean;
  kind: "email" | "routine";
  delivery: "draft" | "soul";
  href: string;
  configurationIssue?: string;
};
export type ProactiveOverview = {
  recipes: ProactiveRecipe[];
  employees: ProactiveEmployee[];
  mailboxes: ProactiveMailbox[];
  installations: ProactiveInstallation[];
};

export function proactiveReadiness(
  recipe: ProactiveRecipe,
  employee: ProactiveEmployee | undefined,
  mailbox: ProactiveMailbox | undefined,
  delivery: "draft" | "soul" = "draft",
): string[] {
  if (!employee) return ["Choose an AI Employee."];
  const missing: string[] = [];
  if (!employee.modelReady) missing.push("Connect an active AI Model on this AI Employee.");
  if (recipe.requirements.includes("mail")) {
    if (!mailbox) missing.push("Choose a mailbox.");
    else {
      if (mailbox.status !== "active")
        missing.push("Reconnect or resume this mailbox in Email → Settings.");
      if (recipe.kind === "email" && !mailbox.analysisEnabled)
        missing.push("Turn on AI analysis in Email → Settings.");
      const access = employee.mailGrants.find((g) => g.accountId === mailbox.id)?.accessLevel;
      const needsSend = recipe.kind === "email" && delivery === "soul";
      if (needsSend ? access !== "send" : access !== "draft" && access !== "send") {
        missing.push(
          `Grant ${needsSend ? "Send" : "Draft"} access in Email → Settings → AI access.`,
        );
      }
    }
  }
  if (
    recipe.requirements.includes("financeRead") &&
    !["read", "invoice", "full"].includes(employee.financeAccess ?? "")
  )
    missing.push("Grant Read access in Finance → AI access.");
  if (
    recipe.requirements.includes("financeInvoice") &&
    !["invoice", "full"].includes(employee.financeAccess ?? "")
  )
    missing.push("Grant Invoicing access in Finance → AI access.");
  if (
    recipe.requirements.includes("revenueWrite") &&
    !["write", "send"].includes(employee.revenueAccess ?? "")
  )
    missing.push("Grant Write access in Revenue → AI access.");
  if (recipe.requirements.includes("repositoryWrite") && !employee.repositoryWrite)
    missing.push("Grant Write access to a Repository.");
  if (recipe.requirements.includes("calendarRead") && !employee.calendarRead)
    missing.push("Grant calendar Read access in Meetings → AI access.");
  return missing;
}
