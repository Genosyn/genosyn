/**
 * Data rooms' vocabulary and arithmetic, shared by the server, the App and the
 * guest's page so the three can never disagree about what a purpose expects,
 * what an access level allows, or how ready a room is.
 *
 * The nouns, in the words the product uses:
 *
 *  - A **Data room** is a private, tracked set of documents the company shares
 *    with people outside it — investors in a round, a buyer, an auditor, a
 *    partner — each through a personal link. Never "deal room", "VDR",
 *    "space" or "portal" in product copy.
 *  - A **Guest** is one outside person invited to one room. Never a
 *    "Member" (that word is the company's own people) or a "user".
 *  - A room's **Folders** are its index: every document sits in exactly one
 *    of them, or at the room's top level. They are numbered by position, the
 *    way a due-diligence index is, so a guest can say "see 3.2".
 *  - A **Question** is one guest asking about the room. Only the guest who
 *    asked sees it and its answer.
 *  - The **readiness review** is the room's AI Employee reading the room
 *    against the checklist its purpose usually needs.
 *
 * The checklist is the server's, not the model's: each purpose names what a
 * room like it is expected to hold, the AI Employee only says which documents
 * cover each item, and the score is arithmetic over those answers
 * ({@link readinessScore}). A model cannot make a room look ready by writing a
 * shorter list.
 */

// ── Purposes ────────────────────────────────────────────────────────────────

export const DATA_ROOM_PURPOSES = [
  "fundraising",
  "acquisition",
  "audit",
  "partnership",
  "other",
] as const;
export type DataRoomPurpose = (typeof DATA_ROOM_PURPOSES)[number];

export const DATA_ROOM_PURPOSE_LABELS: Record<DataRoomPurpose, string> = {
  fundraising: "Fundraising",
  acquisition: "Sale or acquisition",
  audit: "Audit",
  partnership: "Partnership or security review",
  other: "Something else",
};

export const DATA_ROOM_PURPOSE_HINTS: Record<DataRoomPurpose, string> = {
  fundraising: "Investors doing diligence on a round.",
  acquisition: "A buyer, or a company you are buying, going through diligence.",
  audit: "An auditor or accountant reviewing the books.",
  partnership: "A partner or customer reviewing your company, product and security.",
  other: "Any set of documents shared with people outside the company.",
};

/** The folders a new room starts with, in index order. Members rename or remove them freely. */
export const DATA_ROOM_DEFAULT_FOLDERS: Record<DataRoomPurpose, readonly string[]> = {
  fundraising: [
    "Company overview",
    "Financials",
    "Legal and corporate",
    "Team",
    "Product and market",
    "Customers and contracts",
  ],
  acquisition: [
    "Corporate",
    "Financial",
    "Tax",
    "Commercial contracts",
    "Employees",
    "Intellectual property",
    "Legal and compliance",
    "Assets and real estate",
    "IT and data protection",
  ],
  audit: [
    "Financial statements",
    "Ledger and reconciliations",
    "Revenue",
    "Payroll",
    "Tax",
    "Corporate records",
  ],
  partnership: ["Company", "Product", "Security and privacy", "Legal", "Financials"],
  other: ["Documents"],
};

// ── Readiness ───────────────────────────────────────────────────────────────

export type ReadinessImportance = "essential" | "expected";

export type ReadinessChecklistItem = {
  /** Stable within a purpose; the review answers by it. */
  key: string;
  label: string;
  /** One line on what covers the item, for the reviewer and the Member. */
  detail: string;
  importance: ReadinessImportance;
};

const item = (
  key: string,
  label: string,
  detail: string,
  importance: ReadinessImportance = "expected",
): ReadinessChecklistItem => ({ key, label, detail, importance });

/**
 * What a room of each purpose is usually expected to hold. Plain diligence
 * practice, not legal advice — the review says what is there and what is not,
 * and the Member decides what the people they are sharing with will need.
 */
export const DATA_ROOM_CHECKLISTS: Record<DataRoomPurpose, readonly ReadinessChecklistItem[]> = {
  fundraising: [
    item("pitch_deck", "Pitch deck", "The current deck investors are seeing.", "essential"),
    item(
      "financial_statements",
      "Financial statements",
      "Income statement, balance sheet and cash flow for the last two to three years and the year to date.",
      "essential",
    ),
    item(
      "financial_model",
      "Financial model",
      "Projections with the assumptions behind them.",
      "essential",
    ),
    item(
      "cap_table",
      "Cap table",
      "Who owns what today, including options, SAFEs and convertible notes.",
      "essential",
    ),
    item(
      "key_metrics",
      "Key metrics",
      "Revenue, growth, retention and unit economics, with how each is defined.",
    ),
    item(
      "incorporation",
      "Incorporation documents",
      "Certificate of incorporation, bylaws or articles, and proof of good standing.",
    ),
    item(
      "board_records",
      "Board and shareholder records",
      "Board minutes and consents, and shareholder agreements.",
    ),
    item(
      "prior_financings",
      "Earlier financings",
      "Term sheets, SAFEs, notes and investor rights agreements from earlier rounds.",
    ),
    item(
      "material_contracts",
      "Material contracts",
      "The largest customer, supplier and partner agreements.",
    ),
    item(
      "intellectual_property",
      "Intellectual property",
      "Patents and trademarks, and IP assignment agreements from founders and staff.",
    ),
    item(
      "team",
      "Team and equity plan",
      "Org chart, key employment agreements and the equity incentive plan.",
    ),
  ],
  acquisition: [
    item(
      "corporate_records",
      "Corporate records",
      "Formation documents, the group structure, subsidiaries and good standing.",
      "essential",
    ),
    item(
      "financial_statements",
      "Financial statements",
      "Audited or reviewed statements for three years and the year to date.",
      "essential",
    ),
    item(
      "cap_table",
      "Cap table and equity records",
      "Every class of shares, options and warrants, and who holds them.",
      "essential",
    ),
    item(
      "material_contracts",
      "Material contracts",
      "Key customer, supplier and partner agreements, especially change-of-control terms.",
      "essential",
    ),
    item(
      "tax",
      "Tax filings",
      "Returns and filings for the last three years, and any open audits.",
    ),
    item(
      "customers",
      "Customers and revenue concentration",
      "The customer list and how much of revenue the largest customers make up.",
    ),
    item(
      "employees",
      "Employees and benefits",
      "Employment agreements, benefit plans and handbook policies.",
    ),
    item(
      "intellectual_property",
      "Intellectual property",
      "Registrations, assignments, licences and open-source use.",
    ),
    item(
      "litigation",
      "Litigation and compliance",
      "Pending or threatened claims, and regulatory filings or findings.",
    ),
    item("debt", "Debt and liabilities", "Loans, guarantees, liens and other obligations."),
    item("assets", "Real estate and assets", "Leases, owned property and major equipment."),
    item("insurance", "Insurance", "Current policies and claims history."),
    item(
      "data_protection",
      "IT and data protection",
      "Privacy policies, data processing agreements and security assessments.",
    ),
  ],
  audit: [
    item(
      "trial_balance",
      "Trial balance and general ledger",
      "For the period under audit, tied to the financial statements.",
      "essential",
    ),
    item(
      "bank",
      "Bank statements and reconciliations",
      "Every account, for every month of the period.",
      "essential",
    ),
    item(
      "prior_statements",
      "Prior-year financial statements",
      "Last year's statements and audit report.",
      "essential",
    ),
    item("receivables", "Accounts receivable", "An aging report at period end."),
    item("payables", "Accounts payable", "An aging report at period end."),
    item(
      "revenue",
      "Revenue support",
      "Significant contracts and how their revenue was recognised.",
    ),
    item("fixed_assets", "Fixed asset register", "Additions, disposals and depreciation."),
    item("payroll", "Payroll records", "Payroll registers and reconciliations to the ledger."),
    item("tax", "Tax filings", "Returns and payments for the period."),
    item("debt", "Debt agreements", "Loan agreements and covenant calculations."),
    item("board_minutes", "Board minutes", "Minutes and resolutions from the period."),
  ],
  partnership: [
    item(
      "company_overview",
      "Company overview",
      "Who you are, what you do, and who to contact.",
      "essential",
    ),
    item(
      "security",
      "Security overview",
      "SOC 2 or ISO 27001 reports, penetration test summaries, security policies.",
      "essential",
    ),
    item(
      "privacy",
      "Privacy and data processing",
      "Privacy policy, data processing agreement and subprocessors.",
      "essential",
    ),
    item("product", "Product documentation", "What the product does and how it is run."),
    item("contract_terms", "Standard contract terms", "Your master agreement or terms of service."),
    item("insurance", "Insurance certificates", "Liability and cyber cover."),
    item("financial_standing", "Financial standing", "Summary financials or a letter of standing."),
    item("references", "References and case studies", "Customers the partner can speak to."),
  ],
  other: [
    item("overview", "Overview", "A document that explains what the room is for.", "essential"),
    item("supporting", "Supporting documents", "The documents the overview refers to."),
  ],
};

export const READINESS_STATUSES = ["present", "partial", "missing"] as const;
export type ReadinessStatus = (typeof READINESS_STATUSES)[number];

export const READINESS_STATUS_LABELS: Record<ReadinessStatus, string> = {
  present: "Covered",
  partial: "Partly covered",
  missing: "Missing",
};

/** One checklist item as the review answered it. */
export type ReadinessFinding = {
  key: string;
  status: ReadinessStatus;
  documentIds: string[];
  note: string;
};

/**
 * How ready a room is, from 0 to 100: covered items count fully, partly
 * covered ones half, and essential items twice what expected ones do. An item
 * the review did not answer counts as missing — silence is not coverage.
 */
export function readinessScore(
  purpose: DataRoomPurpose,
  findings: ReadonlyArray<Pick<ReadinessFinding, "key" | "status">>,
): number {
  const checklist = DATA_ROOM_CHECKLISTS[purpose];
  const byKey = new Map(findings.map((finding) => [finding.key, finding.status]));
  let earned = 0;
  let possible = 0;
  for (const entry of checklist) {
    const weight = entry.importance === "essential" ? 2 : 1;
    possible += weight;
    const status = byKey.get(entry.key) ?? "missing";
    if (status === "present") earned += weight;
    else if (status === "partial") earned += weight / 2;
  }
  return possible === 0 ? 0 : Math.round((earned / possible) * 100);
}

// ── Rooms, guests, questions ────────────────────────────────────────────────

export const DATA_ROOM_STATUSES = ["open", "closed"] as const;
export type DataRoomStatus = (typeof DATA_ROOM_STATUSES)[number];

export const DATA_ROOM_STATUS_LABELS: Record<DataRoomStatus, string> = {
  open: "Open",
  closed: "Closed",
};

/**
 * What the room's AI Employee does with a guest's question:
 *
 *   - `off`   → nothing; a Member answers every question.
 *   - `draft` → it drafts an answer from the room's documents, with quotes,
 *               and a Member publishes it (the default).
 *   - `auto`  → it answers the guest directly when the documents the guest
 *               can open answer the question and every quote checks out;
 *               otherwise it drafts, exactly as in `draft`.
 */
export const DATA_ROOM_AI_ANSWER_MODES = ["off", "draft", "auto"] as const;
export type DataRoomAiAnswerMode = (typeof DATA_ROOM_AI_ANSWER_MODES)[number];

export const DATA_ROOM_AI_ANSWER_MODE_LABELS: Record<DataRoomAiAnswerMode, string> = {
  off: "Off",
  draft: "Draft answers for review",
  auto: "Answer when the documents do",
};

export const DATA_ROOM_AI_ANSWER_MODE_HINTS: Record<DataRoomAiAnswerMode, string> = {
  off: "A Member answers every question.",
  draft: "The AI Employee drafts each answer with quotes from the room; a Member publishes it.",
  auto: "The AI Employee answers on its own when the guest's documents answer the question and every quote checks out. Anything else waits for a Member.",
};

export const DATA_ROOM_GUEST_STATUSES = ["active", "revoked"] as const;
export type DataRoomGuestStatus = (typeof DATA_ROOM_GUEST_STATUSES)[number];

export const DATA_ROOM_QUESTION_STATUSES = ["open", "answered", "closed"] as const;
export type DataRoomQuestionStatus = (typeof DATA_ROOM_QUESTION_STATUSES)[number];

export const DATA_ROOM_QUESTION_STATUS_LABELS: Record<DataRoomQuestionStatus, string> = {
  open: "Needs an answer",
  answered: "Answered",
  closed: "Closed",
};

/** A document passage an answer rests on, as the guest sees it. */
export type DataRoomCitation = {
  documentId: string;
  /** The document's title when the answer was published. */
  title: string;
  /** Exact words from the document, checked against its text. */
  quote: string;
};

// ── AI work ─────────────────────────────────────────────────────────────────

export const DATA_ROOM_JOB_KINDS = ["brief", "answer", "readiness", "insights"] as const;
export type DataRoomJobKind = (typeof DATA_ROOM_JOB_KINDS)[number];

export const DATA_ROOM_JOB_STATUSES = ["queued", "running", "done", "failed"] as const;
export type DataRoomJobStatus = (typeof DATA_ROOM_JOB_STATUSES)[number];

/** The AI Employee's reading of one document, kept on the document. */
export type DataRoomDocumentBrief = {
  summary: string;
  keyFacts: string[];
  /** Things a person should check before outside eyes see the document. */
  cautions: string[];
  /** The folder the document belongs in, by name. */
  suggestedFolder: string;
};

/** The readiness review, kept on the room. */
export type DataRoomReadiness = {
  findings: ReadinessFinding[];
  summary: string;
  nextSteps: string[];
  score: number;
  /** Documents in the room when it was reviewed, to tell when it is stale. */
  documentCount: number;
};

/** The AI Employee's reading of guest activity, kept on the room. */
export type DataRoomInsights = {
  summary: string;
  guests: Array<{ guestId: string; insight: string }>;
  followUps: string[];
};

// ── Access ──────────────────────────────────────────────────────────────────

export const DATA_ROOM_ACCESS_LEVELS = ["read", "prepare", "share"] as const;
export type DataRoomAccessLevel = (typeof DATA_ROOM_ACCESS_LEVELS)[number];

export const DATA_ROOM_ACCESS_RANK: Record<DataRoomAccessLevel, number> = {
  read: 0,
  prepare: 1,
  share: 2,
};

export const DATA_ROOM_ACCESS_LABELS: Record<DataRoomAccessLevel, string> = {
  read: "Read",
  prepare: "Prepare",
  share: "Share",
};

export const DATA_ROOM_ACCESS_HINTS: Record<DataRoomAccessLevel, string> = {
  read: "Read rooms, their documents and activity, and guests' questions.",
  prepare: "Also create rooms, add documents and draft answers. Nobody outside is contacted.",
  share: "Also invite guests and publish answers — both reach people outside the company.",
};

// ── Limits ──────────────────────────────────────────────────────────────────

export const DATA_ROOM_LIMITS = {
  nameChars: 120,
  descriptionChars: 2_000,
  welcomeChars: 4_000,
  termsChars: 20_000,
  folderNameChars: 120,
  foldersPerRoom: 60,
  documentTitleChars: 200,
  /** One uploaded file. */
  documentBytes: 50 * 1024 * 1024,
  documentsPerRoom: 1_000,
  /** Extracted text kept per document for search and AI work. */
  documentTextChars: 600_000,
  guestsPerRoom: 500,
  questionChars: 2_000,
  answerChars: 8_000,
  citationsPerAnswer: 8,
  quoteChars: 400,
} as const;

// ── Files ───────────────────────────────────────────────────────────────────

/** How a document is shown: rendered pages, an image, text, or a file to download. */
export type DataRoomViewerKind = "pdf" | "image" | "text" | "file";

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp"];
const TEXT_EXTENSIONS = [".txt", ".md", ".markdown", ".csv", ".tsv", ".json"];

/** The file types a room accepts, by extension. */
export const DATA_ROOM_ACCEPTED_EXTENSIONS = [
  ".pdf",
  ".docx",
  ".xlsx",
  ".pptx",
  ...TEXT_EXTENSIONS,
  ...IMAGE_EXTENSIONS,
] as const;

export function fileExtension(filename: string): string {
  const match = /\.[A-Za-z0-9]{1,10}$/.exec(filename.trim());
  return match ? match[0].toLowerCase() : "";
}

export function isAcceptedDataRoomFile(filename: string): boolean {
  return (DATA_ROOM_ACCEPTED_EXTENSIONS as readonly string[]).includes(fileExtension(filename));
}

export function viewerKindFor(filename: string, mimeType: string): DataRoomViewerKind {
  const extension = fileExtension(filename);
  if (mimeType === "application/pdf" || extension === ".pdf") return "pdf";
  if (IMAGE_EXTENSIONS.includes(extension)) return "image";
  if (TEXT_EXTENSIONS.includes(extension)) return "text";
  return "file";
}

/** "2 h 5 min", "4 min", "35 s" — how long someone spent. */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** "1.2 MB" */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
