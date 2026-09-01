export type ProductUseCase = {
  role: string;
  team: string;
  initials: string;
  objective: string;
  steps: [string, string, string];
  outcome: string;
  productSlugs: string[];
  primaryProductSlug: string;
  accent: string;
};

export const PRODUCT_USE_CASES: ProductUseCase[] = [
  {
    role: "Sales Development Rep",
    team: "Revenue",
    initials: "SD",
    objective: "Turn real buying signals into personal outreach while the moment is still warm.",
    steps: [
      "Find accounts showing high-intent product usage",
      "Research the Contact and write a relevant first line",
      "Queue a Sequence for human review",
    ],
    outcome: "12 qualified conversations prepared before the team signs in",
    productSlugs: ["revenue", "email", "customers", "explore", "workspace", "notes", "marketing"],
    primaryProductSlug: "revenue",
    accent: "bg-sky-100 text-sky-700 ring-sky-200",
  },
  {
    role: "Software Engineer",
    team: "Engineering",
    initials: "EN",
    objective:
      "Investigate failures, prepare a tested patch, and hand the diff to a human reviewer.",
    steps: [
      "Read the failing check and inspect the repository",
      "Patch the issue and run the relevant tests",
      "Move the todo to review with a concise handoff",
    ],
    outcome: "A review-ready fix, with the evidence attached",
    productSlugs: ["repositories", "tasks", "workspace", "resources", "pipelines", "bases"],
    primaryProductSlug: "repositories",
    accent: "bg-violet-100 text-violet-700 ring-violet-200",
  },
  {
    role: "Customer Support Specialist",
    team: "Support",
    initials: "CS",
    objective:
      "Triage the inbox, gather customer context, and draft answers grounded in your docs.",
    steps: [
      "Prioritize the messages that need attention",
      "Read account history and cite the right resource",
      "Draft a response, or stack a Decision with full context",
    ],
    outcome: "A clean support queue and faster, consistent replies",
    productSlugs: ["email", "customers", "resources", "workspace", "tasks", "notes", "repositories"],
    primaryProductSlug: "customers",
    accent: "bg-emerald-100 text-emerald-700 ring-emerald-200",
  },
  {
    role: "Finance Operations",
    team: "Finance",
    initials: "FO",
    objective:
      "Reconcile daily transactions, surface exceptions, and keep the books ready to close.",
    steps: [
      "Import new payments and match open invoices",
      "Post balanced entries using the finance playbook",
      "Route ambiguous charges to a Member",
    ],
    outcome: "41 of 42 charges reconciled without manual data entry",
    productSlugs: ["finance", "bases", "explore", "pipelines", "ai-employees", "workspace"],
    primaryProductSlug: "finance",
    accent: "bg-amber-100 text-amber-800 ring-amber-200",
  },
  {
    role: "Marketing Operations",
    team: "Marketing",
    initials: "MO",
    objective:
      "Watch performance, prepare campaign changes, and keep the launch narrative current.",
    steps: [
      "Compare spend and acquisition cost with target",
      "Refresh the dashboard and launch notes",
      "Propose budget changes for approval",
    ],
    outcome: "Every campaign decision arrives with current numbers",
    productSlugs: ["marketing", "explore", "notes", "pipelines", "bases", "email", "revenue"],
    primaryProductSlug: "marketing",
    accent: "bg-rose-100 text-rose-700 ring-rose-200",
  },
  {
    role: "Operations Lead",
    team: "Operations",
    initials: "OP",
    objective: "Turn recurring company work into dependable Routines with visible handoffs.",
    steps: [
      "Schedule the brief and grant only the needed access",
      "Run the work across company systems",
      "Post the result and wait where approval is required",
    ],
    outcome: "Repeatable operations without a spreadsheet of reminders",
    productSlugs: [
      "ai-employees",
      "pipelines",
      "tasks",
      "bases",
      "workspace",
      "resources",
      "finance",
    ],
    primaryProductSlug: "ai-employees",
    accent: "bg-indigo-100 text-indigo-700 ring-indigo-200",
  },
  {
    role: "Founder & General Manager",
    team: "Leadership",
    initials: "GM",
    objective:
      "Start the day with one trusted view of customers, revenue, cash, and work in flight.",
    steps: [
      "Refresh company metrics from the source systems",
      "Summarize the changes that need attention",
      "Assign follow-up work to the right person or AI Employee",
    ],
    outcome: "A daily operating brief built from live company data",
    productSlugs: [
      "explore",
      "finance",
      "revenue",
      "customers",
      "ai-employees",
      "tasks",
      "marketing",
    ],
    primaryProductSlug: "explore",
    accent: "bg-indigo-100 text-indigo-700 ring-indigo-200",
  },
  {
    role: "Security Engineer",
    team: "Security",
    initials: "SE",
    objective: "Review risky changes and recurring checks with a complete, auditable trail.",
    steps: [
      "Inspect the repository and the relevant company resources",
      "Run the defined checks in an isolated working tree",
      "Escalate findings without merging or deploying",
    ],
    outcome: "Evidence-rich reviews that keep humans in control",
    productSlugs: ["repositories", "resources", "pipelines", "ai-employees", "notes", "tasks"],
    primaryProductSlug: "repositories",
    accent: "bg-orange-100 text-orange-800 ring-orange-200",
  },
];

export const SHOWCASE_USE_CASES = PRODUCT_USE_CASES.slice(0, 5);

export function getUseCasesForProduct(slug: string, limit = 3): ProductUseCase[] {
  return PRODUCT_USE_CASES.filter((useCase) => useCase.productSlugs.includes(slug)).slice(0, limit);
}

export function primaryUseCaseForProduct(slug: string): ProductUseCase {
  return (
    PRODUCT_USE_CASES.find((useCase) => useCase.primaryProductSlug === slug) ??
    PRODUCT_USE_CASES.find((useCase) => useCase.productSlugs.includes(slug)) ??
    PRODUCT_USE_CASES[0]
  );
}
