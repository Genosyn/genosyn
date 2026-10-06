import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { AppDataSource } from "../db/datasource.js";
import { Customer } from "../db/entities/Customer.js";
import { Estimate } from "../db/entities/Estimate.js";
import { Invoice } from "../db/entities/Invoice.js";
import { RecurringInvoice } from "../db/entities/RecurringInvoice.js";
import { RecurringInvoiceLineItem } from "../db/entities/RecurringInvoiceLineItem.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testCompanyId } from "../test/dbHarness.js";
import { createEstimateDraft, convertEstimateToInvoice, duplicateEstimate, issueEstimate } from "./estimates.js";
import { createInvoiceDraft, duplicateInvoice } from "./finance.js";
import { renderEstimateHtml } from "./estimateHtml.js";
import { renderInvoiceHtml } from "./invoiceHtml.js";
import { duplicateRecurringInvoice, generateInvoiceFromRecurring } from "./recurringInvoices.js";
import { createSubsidiary, documentIssuerFields, listSubsidiaries, resolveDocumentIssuer, updateSubsidiary } from "./subsidiaries.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

async function setup() {
  const companyId = testCompanyId();
  const customer = await insert(Customer, { companyId, name: "Customer", slug: "customer" });
  const subsidiary = await createSubsidiary(companyId, {
    name: "Example UK Ltd",
    address: "10 London Street\nLondon",
    country: "United Kingdom",
    taxNumber: "GB123456",
    registrationNumber: "12345678",
    email: "billing@example.co.uk",
    phone: "+44 20 1234 5678",
    website: "https://example.co.uk",
    footer: "Pay the UK bank account",
  });
  return { companyId, customer, subsidiary };
}

test("subsidiaries stay company-scoped and archived profiles cannot be newly selected", async () => {
  const { companyId, subsidiary } = await setup();
  const otherCompanyId = testCompanyId();
  await assert.rejects(resolveDocumentIssuer(otherCompanyId, subsidiary.id), /Invalid subsidiary/);
  assert.equal(await updateSubsidiary(otherCompanyId, subsidiary.id, { name: "Changed" }), null);
  assert.deepEqual(await listSubsidiaries(otherCompanyId), []);
  await updateSubsidiary(companyId, subsidiary.id, { archived: true });
  assert.equal((await listSubsidiaries(companyId))[0].archived, true);
  await assert.rejects(resolveDocumentIssuer(companyId, subsidiary.id), /Archived subsidiaries/);
  assert.deepEqual(await resolveDocumentIssuer(companyId, null), { subsidiaryId: null, issuerSnapshot: null });
});

test("invalid issuers cannot leave behind invoice or estimate drafts", async () => {
  const { companyId, subsidiary } = await setup();
  const otherCompanyId = testCompanyId();
  const customer = await insert(Customer, { companyId: otherCompanyId, name: "Other", slug: "other" });
  for (const create of [createInvoiceDraft, createEstimateDraft]) {
    await assert.rejects(create({ companyId: otherCompanyId, customerId: customer.id, subsidiaryId: subsidiary.id }), /Invalid subsidiary/);
  }
  await updateSubsidiary(companyId, subsidiary.id, { archived: true });
  const ownCustomer = await AppDataSource.getRepository(Customer).findOneByOrFail({ companyId });
  await assert.rejects(createInvoiceDraft({ companyId, customerId: ownCustomer.id, subsidiaryId: subsidiary.id }), /Archived subsidiaries/);
  assert.equal(await AppDataSource.getRepository(Invoice).count(), 0);
  assert.equal(await AppDataSource.getRepository(Estimate).count(), 0);
});

test("profile edits and archival preserve snapshots through document duplication and conversion", async () => {
  const { companyId, customer, subsidiary } = await setup();
  const input = {
    companyId,
    customerId: customer.id,
    subsidiaryId: subsidiary.id,
    // A zero-value quote exercises conversion and numbering without ledger setup.
    lines: [{ description: "Complimentary service", quantity: 1, unitPriceCents: 0 }],
  };
  const invoice = await createInvoiceDraft(input);
  const estimate = await createEstimateDraft(input);
  const snapshot = structuredClone(invoice.issuerSnapshot);
  assert.equal(snapshot?.name, "Example UK Ltd");
  await updateSubsidiary(companyId, subsidiary.id, { name: "New legal name", footer: "New bank details", archived: true });
  const savedInvoice = await AppDataSource.getRepository(Invoice).findOneByOrFail({ id: invoice.id });
  assert.deepEqual(savedInvoice.issuerSnapshot, snapshot);
  const invoiceCopy = await duplicateInvoice(savedInvoice, null);
  const estimateCopy = await duplicateEstimate(estimate, null);
  const { invoice: converted } = await convertEstimateToInvoice(await issueEstimate(estimate), null);
  for (const doc of [invoiceCopy, estimateCopy, converted]) {
    assert.equal(doc.subsidiaryId, subsidiary.id);
    assert.deepEqual(doc.issuerSnapshot, snapshot);
  }
});

test("invoice and estimate HTML use the saved issuer and escape all issuer fields", async () => {
  const { companyId, customer, subsidiary } = await setup();
  await updateSubsidiary(companyId, subsidiary.id, { name: "UK <script>Ltd</script>", footer: "UK bank & terms" });
  const invoice = await createInvoiceDraft({ companyId, customerId: customer.id, subsidiaryId: subsidiary.id });
  const estimate = await createEstimateDraft({ companyId, customerId: customer.id, subsidiaryId: subsidiary.id });
  const fallback = { companyName: "Parent legal name", defaultFromBlock: "Parent address", defaultFooter: "Parent bank" };
  for (const html of [
    renderInvoiceHtml({ invoice, customer, lines: [], payments: [], ...fallback }),
    renderEstimateHtml({ estimate, customer, lines: [], ...fallback }),
  ]) {
    assert.match(html, /UK &lt;script&gt;Ltd&lt;\/script&gt;/);
    assert.match(html, /Tax #: GB123456/);
    assert.match(html, /Registration #: 12345678/);
    assert.match(html, /United Kingdom/);
    assert.match(html, /billing@example.co.uk/);
    assert.match(html, /UK bank &amp; terms/);
    assert.doesNotMatch(html, /Parent legal name|Parent address|Parent bank|<script>/);
  }
});

test("blank subsidiary footers never inherit company bank details and explicit document footers win", async () => {
  const { companyId, customer, subsidiary } = await setup();
  await updateSubsidiary(companyId, subsidiary.id, { footer: "" });
  const invoice = await createInvoiceDraft({ companyId, customerId: customer.id, subsidiaryId: subsidiary.id });
  const fallback = { companyName: "Parent name", defaultFromBlock: "Parent address", defaultFooter: "Parent bank" };
  assert.doesNotMatch(renderInvoiceHtml({ invoice, customer, lines: [], payments: [], ...fallback }), /Parent bank/);
  invoice.footer = "Document payment instructions";
  assert.match(renderInvoiceHtml({ invoice, customer, lines: [], payments: [], ...fallback }), /Document payment instructions/);
  assert.deepEqual(documentIssuerFields({ issuerSnapshot: null }, fallback), fallback);
  const legacy = await createInvoiceDraft({ companyId, customerId: customer.id });
  const html = renderInvoiceHtml({ invoice: legacy, customer, lines: [], payments: [], ...fallback });
  assert.match(html, /Parent name/);
  assert.match(html, /Parent address/);
  assert.match(html, /Parent bank/);
});

test("recurring generation snapshots current details and fails before creating a document for archived issuers", async () => {
  const { companyId, customer, subsidiary } = await setup();
  const recurring = await insert(RecurringInvoice, {
    companyId, customerId: customer.id, subsidiaryId: subsidiary.id,
    slug: "monthly", name: "Monthly", cronExpr: "0 9 1 * *", autoSend: false,
  });
  await insert(RecurringInvoiceLineItem, { recurringInvoiceId: recurring.id, description: "Service", quantity: 1, unitPriceCents: 1000 });
  await updateSubsidiary(companyId, subsidiary.id, { name: "Current UK name" });
  const { invoice } = await generateInvoiceFromRecurring(recurring, null);
  assert.equal(invoice.subsidiaryId, subsidiary.id);
  assert.equal(invoice.issuerSnapshot?.name, "Current UK name");
  await updateSubsidiary(companyId, subsidiary.id, { archived: true });
  const copy = await duplicateRecurringInvoice(recurring, null);
  assert.equal(copy.subsidiaryId, subsidiary.id);
  assert.equal(copy.status, "paused");
  await assert.rejects(generateInvoiceFromRecurring(recurring, null), /Archived subsidiaries/);
  assert.equal(await AppDataSource.getRepository(Invoice).count(), 1);
});
