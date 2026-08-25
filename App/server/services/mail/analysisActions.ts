import { AppDataSource } from "../../db/datasource.js";
import { Customer } from "../../db/entities/Customer.js";
import type { FinanceAccess } from "../../db/entities/Membership.js";
import type { MailAccount } from "../../db/entities/MailAccount.js";
import { MailInboundAnalysis } from "../../db/entities/MailInboundAnalysis.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { MailThread } from "../../db/entities/MailThread.js";
import { emailDomain, normalizeEmail } from "../../lib/emailAddress.js";
import { recordAudit } from "../audit.js";
import { createEstimateDraft } from "../estimates.js";
import {
  draftInvoiceSlug,
  recomputeInvoiceTotals,
  replaceInvoiceLines,
  uniqueCustomerSlug,
  type LineDraft,
} from "../finance.js";
import { Invoice } from "../../db/entities/Invoice.js";
import { normalizeAccountDomain } from "../revenue/accounts.js";
import { createMailDraft, performThreadAction } from "./actions.js";
import { parseAnalysisActions, type MailAnalysisAction } from "./analysis.js";
import { createMailHandover, handoverGrantError } from "./handovers.js";
import { unsubscribeFromMessage } from "./unsubscribe.js";

/**
 * Running one of the buttons AI analysis proposed.
 *
 * Every path here executes with the pressing Member's authority, through the
 * same services the equivalent manual gesture uses. The analysis row supplied
 * the *contents* of the action; it never supplied the permission to take it,
 * and it never named the thread — that comes from the row's own
 * `messageId` / `threadId`, which the server wrote.
 *
 * Actions are stamped `executedAt` and refuse to run twice. That is not
 * bookkeeping: a reload that re-armed "Unsubscribe" or "Create the invoice"
 * would quietly do it again.
 */

/**
 * Free mail hosts. Two customers at `gmail.com` are two customers, so the
 * domain shortcut must never join them — matching on it would attach a new
 * enquiry to whichever unrelated person signed up from Gmail first.
 */
const SHARED_MAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "mail.com",
  "zoho.com",
  "yandex.com",
  "fastmail.com",
  "hey.com",
]);

export type MailAnalysisActor = {
  userId: string;
  sessionVersion: number;
  /**
   * The pressing Member's finance level, resolved the same way the finance
   * routes resolve it. The money buttons write real finance rows, and the
   * finance router's own gate cannot reach them here — it is bound to that
   * router's verbs, not to this one.
   */
  financeAccess: FinanceAccess;
};

export type MailAnalysisActionResult = {
  analysis: MailInboundAnalysis;
  /** Where the client should take the Member next, when there is somewhere. */
  navigateTo: string | null;
  /** One line for the toast. Always says what actually happened. */
  message: string;
};

export class MailAnalysisActionError extends Error {}

/**
 * Claim the button, perform it, and keep the claim only if it worked.
 *
 * The stamp goes on *before* the effect, not after. Stamping afterwards reads
 * more naturally but loses the race that matters: two presses of the same
 * button — a double-click, a retried request — would both find it unspent and
 * both run, and one press would become two unsubscribe requests or two draft
 * invoices. Claiming first makes the second press lose at the database.
 *
 * A failed effect releases the claim, so a button that could not run stays
 * armed for a retry rather than being burnt by an outage. That is the right
 * trade for every kind here: the failure a Member actually hits is a dead
 * Google connection or an expired token — nothing happened, and they want the
 * button back after reconnecting. The residual risk, a call that failed
 * *after* Gmail acted, costs at worst a duplicate that is visible and
 * removable — a second draft in the review queue, a second draft invoice with
 * no number and no ledger entry, a repeat of an idempotent triage action, or
 * a repeat of a one-click unsubscribe the sender has already seen. Burning
 * the button would strand the common case to avoid the rare harmless one.
 */
export async function executeAnalysisAction(
  account: MailAccount,
  analysis: MailInboundAnalysis,
  actionId: string,
  actor: MailAnalysisActor,
): Promise<MailAnalysisActionResult> {
  if (analysis.accountId !== account.id || analysis.companyId !== account.companyId) {
    throw new MailAnalysisActionError("This analysis does not belong to this mailbox.");
  }
  const actions = parseAnalysisActions(analysis.actionsJson);
  const action = actions.find((candidate) => candidate.id === actionId);
  if (!action) throw new MailAnalysisActionError("That action is no longer on this email.");
  if (action.executedAt) throw new MailAnalysisActionError("That action has already run.");

  const message = await AppDataSource.getRepository(MailMessage).findOneBy({
    id: analysis.messageId,
    accountId: account.id,
  });
  if (!message) throw new MailAnalysisActionError("The email this action belongs to is gone.");
  const thread = await AppDataSource.getRepository(MailThread).findOneBy({
    id: analysis.threadId,
    accountId: account.id,
  });
  if (!thread) throw new MailAnalysisActionError("The thread this action belongs to is gone.");

  const claim = await claimAction(analysis.id, actionId);

  let outcome: { navigateTo: string | null; message: string };
  try {
    outcome = await runAction(account, analysis, action, { message, thread }, actor);
  } catch (error) {
    await releaseClaim(analysis.id, claim);
    throw error;
  }

  await recordAudit({
    companyId: account.companyId,
    actorUserId: actor.userId,
    action: `mail.analysis.${action.kind}`,
    targetType: "mail_inbound_analysis",
    targetId: analysis.id,
    targetLabel: thread.subject || "(no subject)",
    metadata: { actionId, kind: action.kind },
  });
  return { analysis: claim.row, ...outcome };
}

/**
 * A button that writes to Finance answers to Finance's own rule.
 *
 * A Member whose finance access was turned down to read-only can still see
 * every email, so without this the mail surface would be a side door into the
 * ledger that the finance section itself keeps shut.
 */
function assertFinanceWrite(actor: MailAnalysisActor): void {
  if (actor.financeAccess !== "full") {
    throw new MailAnalysisActionError(
      "You have read-only finance access, so you can't raise invoices or estimates.",
    );
  }
}

async function runAction(
  account: MailAccount,
  analysis: MailInboundAnalysis,
  action: MailAnalysisAction,
  context: { message: MailMessage; thread: MailThread },
  actor: MailAnalysisActor,
): Promise<{ navigateTo: string | null; message: string }> {
  switch (action.kind) {
    case "draft_reply": {
      const draft = await createMailDraft(
        account,
        {
          // The address the Member read under the label, not whoever happens
          // to be newest on the thread. `targetTo` is the server's own
          // snapshot of this message's sender; a reply that quietly goes
          // somewhere else is the one thing this button must never do.
          to: action.targetTo ?? "",
          subject: action.subject,
          bodyText: action.bodyText,
        },
        context.thread,
        // The words are the employee's, so the Drafts review queue must say
        // so — that queue exists precisely to read AI-written mail before it
        // goes out. Attributing it to the Member who pressed the button would
        // hide it from the one screen built to catch it.
        { employeeId: analysis.employeeId },
      );
      return {
        navigateTo: null,
        message: `Draft reply saved to ${draft.toEmails || account.address}`,
      };
    }

    case "unsubscribe": {
      const result = await unsubscribeFromMessage(account, context.message);
      return { navigateTo: null, message: `Unsubscribed via ${result.host}` };
    }

    case "thread_action": {
      await performThreadAction(account, context.thread, action.action, {
        labelName: action.labelName,
      });
      return { navigateTo: null, message: threadActionMessage(action) };
    }

    case "hand_over": {
      const grantError = await handoverGrantError(action.employeeId, account.id, action.mode);
      if (grantError) throw new MailAnalysisActionError(grantError);
      await createMailHandover({
        account,
        thread: context.thread,
        employeeId: action.employeeId,
        mode: action.mode,
        instruction: action.instruction,
        sourceKind: "manual",
        ruleId: null,
        createdByUserId: actor.userId,
        requesterUserId: actor.userId,
        requesterSessionVersion: actor.sessionVersion,
      });
      return {
        navigateTo: null,
        message: `Handed to ${action.targetEmployeeName ?? "the AI employee"}`,
      };
    }

    case "create_invoice": {
      assertFinanceWrite(actor);
      const customer = await resolveOrCreateCustomer(account.companyId, {
        name: action.customerName,
        email: context.message.fromEmail,
      });
      const invoice = await createInvoiceDraft(account.companyId, customer, action, actor.userId);
      return {
        navigateTo: `/finance/invoices/${invoice.slug}/edit`,
        message: `Draft invoice created for ${customer.name}`,
      };
    }

    case "create_estimate": {
      assertFinanceWrite(actor);
      const customer = await resolveOrCreateCustomer(account.companyId, {
        name: action.customerName,
        email: context.message.fromEmail,
      });
      const estimate = await createEstimateDraft({
        companyId: account.companyId,
        customerId: customer.id,
        currency: action.currency,
        notes: action.notes,
        lines: toLineDrafts(action.lines),
        createdById: actor.userId,
      });
      return {
        navigateTo: `/finance/estimates/${estimate.slug}/edit`,
        message: `Draft estimate created for ${customer.name}`,
      };
    }
  }
}

function threadActionMessage(
  action: Extract<MailAnalysisAction, { kind: "thread_action" }>,
): string {
  switch (action.action) {
    case "markRead":
      return "Marked read";
    case "star":
      return "Starred";
    case "archive":
      return "Archived";
    case "applyLabel":
      return `Labelled ${action.labelName ?? ""}`.trim();
  }
}

function toLineDrafts(
  lines: Array<{ description: string; quantity: number; unitPriceCents: number }>,
): LineDraft[] {
  return lines.map((line, index) => ({
    description: line.description,
    quantity: line.quantity,
    unitPriceCents: line.unitPriceCents,
    sortOrder: index,
  }));
}

/**
 * The billable counterparty for a button pressed from an email.
 *
 * Matching walks from most to least certain — the exact address, then the
 * company domain, then the name the employee read off the email — and only
 * creates a row when none of them lands. A wrong match here bills the wrong
 * company, so each step has to be one a human would also make.
 */
export async function resolveOrCreateCustomer(
  companyId: string,
  sender: { name: string; email: string },
): Promise<Customer> {
  const repo = AppDataSource.getRepository(Customer);
  // Archived customers are hidden from every picker and every list, so
  // matching one would bill an account the Member cannot see — and quietly
  // bring it back from retirement in the finance views. A retired counterparty
  // getting in touch again earns a fresh row they can merge deliberately.
  const active = () =>
    repo
      .createQueryBuilder("c")
      .where("c.companyId = :companyId", { companyId })
      .andWhere("c.archivedAt IS NULL");

  const email = normalizeEmail(sender.email);
  if (email) {
    const byEmail = await active()
      .andWhere("LOWER(c.email) = :email", { email })
      .orderBy("c.createdAt", "ASC")
      .getOne();
    if (byEmail) return byEmail;
  }

  const domain = normalizeAccountDomain(emailDomain(sender.email) ?? "");
  if (domain && !SHARED_MAIL_DOMAINS.has(domain)) {
    const byDomain = await active()
      .andWhere("c.domain = :domain", { domain })
      .orderBy("c.createdAt", "ASC")
      .getOne();
    if (byDomain) return byDomain;
  }

  // Deliberately no name match. The name came out of the email, which means an
  // attacker picks it: "invoice Acme Corp" from an unrelated address would
  // otherwise attach a draft to the real Acme. Address and domain are claims
  // the sender had to actually control; a display name is not. A duplicate
  // customer row is the far cheaper mistake, and a Member can merge it.
  const name = sender.name.trim().slice(0, 200) || sender.email || "New customer";
  return repo.save(
    repo.create({
      companyId,
      name,
      slug: await uniqueCustomerSlug(companyId, slugifyCustomer(name)),
      email: email ?? "",
      // Only claim the domain when it is genuinely the counterparty's. A
      // Gmail address would otherwise make this row the permanent home of
      // every future Gmail sender.
      domain: domain && !SHARED_MAIL_DOMAINS.has(domain) ? domain : "",
      accountStatus: "prospect",
    }),
  );
}

function slugifyCustomer(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "customer"
  );
}

/**
 * A draft invoice: no number, no ledger effect, nothing emailed. The Member
 * lands on its edit screen and decides whether it is right before issuing it.
 */
async function createInvoiceDraft(
  companyId: string,
  customer: Customer,
  action: Extract<MailAnalysisAction, { kind: "create_invoice" }>,
  createdById: string,
): Promise<Invoice> {
  const repo = AppDataSource.getRepository(Invoice);
  const issueDate = new Date();
  const invoice = repo.create({
    companyId,
    customerId: customer.id,
    slug: await draftInvoiceSlug(companyId),
    numberSeq: 0,
    number: "",
    status: "draft",
    issueDate,
    dueDate: new Date(issueDate.getTime() + 14 * 24 * 60 * 60 * 1_000),
    currency: action.currency ?? customer.currency ?? "USD",
    notes: action.notes ?? "",
    footer: "",
    createdById,
  });
  await repo.save(invoice);
  await replaceInvoiceLines(invoice, toLineDrafts(action.lines));
  return recomputeInvoiceTotals(invoice);
}

type ActionClaim = {
  /** The row as it stands with this button stamped — what the caller returns. */
  row: MailInboundAnalysis;
  /** The blob before the stamp, so a failed effect can put it back exactly. */
  previousJson: string;
  /** The blob this claim wrote, so a release only undoes its own write. */
  claimedJson: string;
};

/**
 * Take the button, or lose to whoever already has it.
 *
 * The write is a compare-and-swap on the whole `actionsJson` blob: it lands
 * only if the row still looks exactly as it did when this request read it. A
 * second press racing the first therefore fails its swap instead of running a
 * duplicate effect, and a sibling button stamped in between makes this request
 * re-read and try again rather than clobbering that sibling's stamp.
 */
async function claimAction(analysisId: string, actionId: string): Promise<ActionClaim> {
  const repo = AppDataSource.getRepository(MailInboundAnalysis);
  // A handful of attempts is plenty: contention here is a human pressing two
  // buttons on one email, not a hot loop.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const fresh = await repo.findOneBy({ id: analysisId });
    if (!fresh) throw new MailAnalysisActionError("That action is no longer on this email.");
    const actions = parseAnalysisActions(fresh.actionsJson);
    const target = actions.find((candidate) => candidate.id === actionId);
    if (!target) throw new MailAnalysisActionError("That action is no longer on this email.");
    if (target.executedAt) throw new MailAnalysisActionError("That action has already run.");

    const previousJson = fresh.actionsJson;
    const claimedJson = JSON.stringify(
      actions.map((action) =>
        action.id === actionId ? { ...action, executedAt: new Date().toISOString() } : action,
      ),
    );
    const result = await repo
      .createQueryBuilder()
      .update()
      .set({ actionsJson: claimedJson })
      .where("id = :id", { id: analysisId })
      .andWhere('"actionsJson" = :previousJson', { previousJson })
      .execute();
    if ((result.affected ?? 0) > 0) {
      fresh.actionsJson = claimedJson;
      return { row: fresh, previousJson, claimedJson };
    }
  }
  throw new MailAnalysisActionError(
    "Another action on this email is being run right now. Try again in a moment.",
  );
}

/**
 * Hand the button back after a failed effect.
 *
 * Guarded on the exact blob this claim wrote, so a release can never undo a
 * *different* stamp that landed in between — better to leave a button looking
 * spent than to re-arm one that actually ran.
 */
async function releaseClaim(analysisId: string, claim: ActionClaim): Promise<void> {
  await AppDataSource.getRepository(MailInboundAnalysis)
    .createQueryBuilder()
    .update()
    .set({ actionsJson: claim.previousJson })
    .where("id = :id", { id: analysisId })
    .andWhere('"actionsJson" = :claimedJson', { claimedJson: claim.claimedJson })
    .execute();
}
