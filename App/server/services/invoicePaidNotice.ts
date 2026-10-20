import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import { Customer } from "../db/entities/Customer.js";
import type { Invoice } from "../db/entities/Invoice.js";
import { InvoicePayment, type InvoicePaymentMethod } from "../db/entities/InvoicePayment.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { formatMoney } from "../lib/money.js";
import { sendEmail } from "./email.js";
import { getPublicUrl } from "./publicUrl.js";

/**
 * The confirmation a company's owners and admins get when one of its invoices
 * is paid.
 *
 * `recomputeInvoiceTotals` sends it on the edge into Paid, so every way an
 * invoice gets there — a Member recording a payment, an AI Employee recording
 * one, a credit or an edit settling what cash had not — sends exactly one. It
 * goes to the company's own people only: the customer is never emailed.
 */

/**
 * Settled with money that arrived — what the Paid badge means. An invoice
 * cleared only by a credit or a write-off is stored as `paid` too, but shows as
 * Credited or Written off, and nobody paid it.
 */
export function isPaidInCash(invoice: Pick<Invoice, "status" | "paidCents">): boolean {
  return invoice.status === "paid" && invoice.paidCents > 0;
}

const METHOD_LABELS: Record<InvoicePaymentMethod, string> = {
  cash: "Cash",
  bank_transfer: "Bank transfer",
  stripe: "Stripe",
  lightning: "Lightning",
  other: "Other",
};

export type InvoicePaidNoticeInput = {
  invoice: Pick<
    Invoice,
    "number" | "slug" | "currency" | "totalCents" | "paidCents" | "creditedCents" | "writtenOffCents"
  >;
  customerName: string;
  companyName: string;
  companySlug: string;
  payments: ReadonlyArray<Pick<InvoicePayment, "amountCents" | "paidAt" | "method" | "reference">>;
  publicUrl: string;
};

/** The subject and plain-text body of the confirmation. */
export function invoicePaidNotice(input: InvoicePaidNoticeInput): { subject: string; text: string } {
  const { invoice } = input;
  const money = (cents: number) => formatMoney(cents, invoice.currency);
  const number = invoice.number || "Draft invoice";
  const customer = input.customerName || "the customer";
  const amounts = [
    `Total: ${money(invoice.totalCents)}`,
    `Paid: ${money(invoice.paidCents)}`,
    ...(invoice.creditedCents > 0 ? [`Credited: ${money(invoice.creditedCents)}`] : []),
    ...(invoice.writtenOffCents > 0 ? [`Written off: ${money(invoice.writtenOffCents)}`] : []),
  ];
  const payments = input.payments.map((payment) =>
    [
      `- ${payment.paidAt.toISOString().slice(0, 10)}`,
      money(payment.amountCents),
      METHOD_LABELS[payment.method] ?? "Other",
      ...(payment.reference ? [`ref ${payment.reference}`] : []),
    ].join(" · "),
  );
  const link = `${input.publicUrl}/c/${input.companySlug}/finance/invoices/${invoice.slug}`;
  const text = [
    `Invoice ${number} to ${customer} is now marked paid.`,
    amounts.join("\n"),
    ...(payments.length > 0 ? [`Payments:\n${payments.join("\n")}`] : []),
    `Open the invoice: ${link}`,
    `This confirmation goes to the owners and admins of ${input.companyName || "your company"}. ${customer} was not emailed.`,
  ].join("\n\n");
  return {
    subject: `Invoice ${number} marked paid — ${customer}, ${money(invoice.totalCents)}`,
    text,
  };
}

/** Every owner's and admin's address, once each. */
async function ownerAndAdminAddresses(companyId: string): Promise<string[]> {
  const memberships = await AppDataSource.getRepository(Membership).find({
    where: { companyId, role: In(["owner", "admin"]) },
  });
  if (memberships.length === 0) return [];
  const users = await AppDataSource.getRepository(User).find({
    where: { id: In([...new Set(memberships.map((m) => m.userId))]) },
    select: { id: true, email: true },
  });
  const seen = new Set<string>();
  return users.flatMap((user) => {
    const address = user.email?.trim() ?? "";
    const key = address.toLowerCase();
    if (!address || seen.has(key)) return [];
    seen.add(key);
    return [address];
  });
}

/**
 * Email each owner and admin that `invoice` is paid, one message apiece so
 * each lands in Email Logs on its own. Never throws: a confirmation that could
 * not be sent must not undo the payment that triggered it.
 */
export async function notifyInvoicePaid(invoice: Invoice): Promise<void> {
  try {
    const recipients = await ownerAndAdminAddresses(invoice.companyId);
    if (recipients.length === 0) return;
    const [company, customer, payments] = await Promise.all([
      AppDataSource.getRepository(Company).findOneBy({ id: invoice.companyId }),
      AppDataSource.getRepository(Customer).findOneBy({
        id: invoice.customerId,
        companyId: invoice.companyId,
      }),
      AppDataSource.getRepository(InvoicePayment).find({
        where: { invoiceId: invoice.id },
        order: { paidAt: "ASC" },
      }),
    ]);
    if (!company) return;
    const { subject, text } = invoicePaidNotice({
      invoice,
      customerName: customer?.name ?? "",
      companyName: company.name,
      companySlug: company.slug,
      payments,
      publicUrl: getPublicUrl(),
    });
    await Promise.all(
      recipients.map((to) =>
        sendEmail({ to, subject, text, companyId: invoice.companyId, purpose: "other" }),
      ),
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[finance] could not email the paid confirmation for invoice ${invoice.id}:`, err);
  }
}
