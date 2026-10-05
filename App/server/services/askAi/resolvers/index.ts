import type { AskAiContextKind } from "../../../../shared/askAi.js";
import type { AskAiResolver } from "../context.js";
import {
  resolveBill,
  resolveCreditNote,
  resolveCustomer,
  resolveEstimate,
  resolveInvoice,
  resolveJournalEntry,
  resolveRecurringInvoice,
  resolveTransaction,
  resolveVendor,
  resolveVendorCredit,
} from "./finance.js";
import { resolveDecision, resolveGoal, resolveInitiative } from "./governance.js";
import {
  resolveBase,
  resolveBaseRecord,
  resolveBaseTable,
  resolveChannel,
  resolveChart,
  resolveDashboard,
  resolveNote,
  resolveNotebook,
  resolvePipeline,
  resolveProject,
  resolveRepository,
  resolveResource,
  resolveTodo,
} from "./knowledge.js";
import { resolveMailThread } from "./mail.js";
import {
  resolveContact,
  resolveDeal,
  resolveMarketingCampaign,
  resolveMeeting,
  resolvePartnership,
  resolveRevenueAccount,
  resolveSequence,
  resolveSignal,
  resolveSignatureEnvelope,
} from "./revenue.js";
import { resolveEmployee, resolveRoutine, resolveRun, resolveSkill } from "./routines.js";

/**
 * One resolver per context kind. A `Record` rather than a partial map so that
 * adding a kind to `shared/askAi.ts` without teaching the server to load it is
 * a type error, not a chip that silently resolves to nothing.
 */
export const ASK_AI_RESOLVERS: Record<AskAiContextKind, AskAiResolver> = {
  employee: resolveEmployee,
  skill: resolveSkill,
  routine: resolveRoutine,
  run: resolveRun,
  mail_thread: resolveMailThread,
  project: resolveProject,
  todo: resolveTodo,
  base: resolveBase,
  base_table: resolveBaseTable,
  base_record: resolveBaseRecord,
  pipeline: resolvePipeline,
  notebook: resolveNotebook,
  note: resolveNote,
  resource: resolveResource,
  repository: resolveRepository,
  customer: resolveCustomer,
  signature_envelope: resolveSignatureEnvelope,
  meeting: resolveMeeting,
  deal: resolveDeal,
  revenue_account: resolveRevenueAccount,
  contact: resolveContact,
  partnership: resolvePartnership,
  sequence: resolveSequence,
  signal: resolveSignal,
  marketing_campaign: resolveMarketingCampaign,
  invoice: resolveInvoice,
  credit_note: resolveCreditNote,
  recurring_invoice: resolveRecurringInvoice,
  estimate: resolveEstimate,
  bill: resolveBill,
  vendor: resolveVendor,
  vendor_credit: resolveVendorCredit,
  transaction: resolveTransaction,
  journal_entry: resolveJournalEntry,
  chart: resolveChart,
  dashboard: resolveDashboard,
  channel: resolveChannel,
  decision: resolveDecision,
  goal: resolveGoal,
  initiative: resolveInitiative,
};
