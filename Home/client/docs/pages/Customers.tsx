import {
  Code,
  DocLink,
  H2,
  LI,
  P,
  PageHeader,
  Strong,
  UL,
} from "@/docs/Prose";

export function Customers() {
  return (
    <>
      <PageHeader
        eyebrow="Module"
        title="Customers"
        lead={
          <>
            The accounts you sell to — their people, their headline value,
            and the contracts you&apos;ve signed with them. Customers used
            to live inside Finance; they now have their own top-level
            section in the sidebar under <Code>Customers</Code>.
          </>
        }
      />

      <H2 id="what-ships">What ships</H2>
      <UL>
        <LI>
          <Strong>Customer accounts</Strong> — name, billing email, phone,
          tax ID, default currency, and billing address.
        </LI>
        <LI>
          <Strong>Annual Contract Value</Strong> — a headline revenue figure
          per account, shown right in the customer list.
        </LI>
        <LI>
          <Strong>Contacts</Strong> — any number of named people at an
          account, each with a role, email, and phone.
        </LI>
        <LI>
          <Strong>Contracts</Strong> — the signed agreements you hold with a
          customer, uploaded and stored alongside the account.
        </LI>
        <LI>
          <Strong>Statements</Strong> — a statement of account per customer:
          every invoice and payment with a running balance, plus an aging
          summary, viewable in-app and downloadable as a PDF.
        </LI>
      </UL>

      <H2 id="accounts">Customer accounts</H2>
      <P>
        A <Strong>Customer</Strong> is the billable account — the company
        name, primary billing email, tax ID, default currency, and address
        that appear on every invoice. Create one from{" "}
        <Code>Customers → New customer</Code>. Each customer also has a{" "}
        <Strong>slug</Strong> auto-derived from its name (<Code>Acme Corp</Code>{" "}
        → <Code>acme-corp</Code>); that slug is uppercased and prefixed onto
        every invoice and estimate number issued to the customer over in{" "}
        <DocLink to="/docs/finance">Finance</DocLink>, so the numbers stay
        unique and self-identify across accounts. Customers with invoices
        can&apos;t be deleted — archive them instead to keep historical
        billing intact while hiding them from the default list.
      </P>

      <H2 id="overview">Customer overview</H2>
      <P>
        Click any customer&apos;s name to open their <Strong>overview</Strong>{" "}
        — a single page with the headline numbers (annual contract value,
        outstanding balance, lifetime billed), an <Strong>action-needed</Strong>{" "}
        queue that surfaces overdue and unpaid invoices and estimates awaiting
        a response, and the full history of the account&apos;s invoices,
        estimates, contracts, and contacts. Each row deep-links into the
        underlying document in <DocLink to="/docs/finance">Finance</DocLink>.
      </P>

      <H2 id="statements">Statements</H2>
      <P>
        Open a customer&apos;s overview and click <Code>Statement</Code> for a{" "}
        <Strong>statement of account</Strong> — the running ledger you&apos;d
        send a customer who asks &quot;what do I owe you?&quot;. It lists every
        issued invoice as a charge and every recorded payment as a credit, in
        date order, with a running balance carried from an{" "}
        <Strong>opening balance</Strong> down to the <Strong>balance due</Strong>.
        Draft and voided invoices are excluded — only real, issued activity
        appears.
      </P>
      <UL>
        <LI>
          <Strong>Period</Strong> — show all time (the default) or narrow to
          this month, this quarter, year to date, the last 12 months, or a
          custom date range. Anything before the start of the period is rolled
          into the opening balance.
        </LI>
        <LI>
          <Strong>Aging</Strong> — the outstanding balance broken into current,
          1–30, 31–60, 61–90, and 90+ days past due, so you can see how stale
          the debt is at a glance.
        </LI>
        <LI>
          <Strong>Currency</Strong> — statements are per-currency. If an account
          has been billed in more than one, a switcher lets you pick which to
          view; balances are never summed across currencies.
        </LI>
        <LI>
          <Strong>Download PDF</Strong> or <Strong>Print view</Strong> — hand
          the customer a portable document, or open the print-friendly HTML to
          save from your browser. Invoice numbers on the in-app view link
          straight to the underlying document in{" "}
          <DocLink to="/docs/finance">Finance</DocLink>.
        </LI>
      </UL>

      <H2 id="acv">Annual Contract Value</H2>
      <P>
        Each customer carries an <Strong>Annual Contract Value</Strong> (ACV)
        — the expected yearly revenue from the account. Enter it on the New /
        Edit customer page as a plain amount; it is stored and displayed in
        the customer&apos;s default currency (so <Code>120000</Code> on a USD
        account reads as <Code>$120,000.00</Code>), and surfaces as its own
        column in the customer list. It&apos;s an independent sales metric —
        editing it never touches issued invoices, and leaving it blank simply
        shows a dash.
      </P>

      <H2 id="contacts">Contacts</H2>
      <P>
        Beyond the billing record, a customer can carry any number of{" "}
        <Strong>contacts</Strong>: the humans at that account, each with their
        own name, role, email, and phone. Mark one as the primary contact to
        surface it first. Add, edit, or remove contacts inline on the New /
        Edit customer page. Contacts are for your records — invoice and
        estimate email still goes to the customer&apos;s billing email.
      </P>

      <H2 id="contracts">Contracts</H2>
      <P>
        Upload the agreements you&apos;ve signed with a customer — MSAs,
        order forms, NDAs — and keep them next to the account. Each contract
        is a file (PDF, image, or document up to 25 MB) with a title, an
        optional <Strong>signed date</Strong>, notes, and an optional link to
        a customer.
      </P>
      <UL>
        <LI>
          The <Code>Customers → Contracts</Code> page lists every contract
          across all accounts, filterable by customer. Upload from here and
          pick which account it belongs to.
        </LI>
        <LI>
          Each customer&apos;s edit page also has a <Strong>Contracts</Strong>{" "}
          panel showing just that account&apos;s agreements, so you can upload
          one while you&apos;re looking at the customer.
        </LI>
      </UL>
      <P>
        Download, edit the details of, or delete any contract from either
        view. Files are stored on the server under your company&apos;s data
        directory, never in the database itself.
      </P>
    </>
  );
}
