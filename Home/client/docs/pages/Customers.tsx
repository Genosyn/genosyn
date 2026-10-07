import { Code, DocLink, H2, H3, LI, P, PageHeader, Strong, UL } from "@/docs/Prose";

export function Customers() {
  return (
    <>
      <PageHeader
        eyebrow="Module"
        title="Customers"
        lead={
          <>
            The accounts you sell to — from prospect through billing — their people, headline value,
            and the contracts you&apos;ve signed with them. Customers used to live inside Finance;
            they now have their own top-level section in the sidebar under <Code>Customers</Code>.
          </>
        }
      />

      <H2 id="what-ships">What ships</H2>
      <UL>
        <LI>
          <Strong>Customer overview</Strong> — one page per account with every email, activity,
          deal, person, meeting, billing document, contract, and signature request linked to it.
        </LI>
        <LI>
          <Strong>Accounts</Strong> — prospect/customer/former status, with each domain visible in
          the customer list; website, industry, size and owner alongside billing email, phone, tax
          ID, currency, and address.
        </LI>
        <LI>
          <Strong>Annual Contract Value</Strong> — a headline revenue figure per account, shown
          right in the customer list.
        </LI>
        <LI>
          <Strong>Search and pagination</Strong> — find accounts by customer or contact details,
          browse them 25 at a time, and include archived accounts when you need them.
        </LI>
        <LI>
          <Strong>Contacts</Strong> — any number of named people at an account, each with a role,
          email, and phone.
        </LI>
        <LI>
          <Strong>Contracts</Strong> — the signed agreements you hold with a customer, uploaded or
          completed through Genosyn and stored alongside the account.
        </LI>
        <LI>
          <Strong>Statements</Strong> — a statement of account per customer: every invoice and
          payment with a running balance, plus an aging summary, viewable in-app and downloadable as
          a PDF.
        </LI>
      </UL>

      <H2 id="accounts">Customer accounts</H2>
      <P>
        A <Strong>Customer</Strong> row is the account across its whole lifecycle. Create a prospect
        from <Code>Revenue → Accounts</Code> before it has finance activity, or create a customer
        directly from <Code>Customers → New customer</Code>. Issuing the first invoice promotes a
        prospect to customer automatically. The same row carries the company name, domain,
        firmographics, owner, billing email, tax ID, default currency, and invoice address.
      </P>
      <P>
        Each account also has a <Strong>slug</Strong> auto-derived from its name (
        <Code>Acme Corp</Code> → <Code>acme-corp</Code>); that slug is uppercased and prefixed onto
        every invoice and estimate number issued to the customer over in{" "}
        <DocLink to="/docs/finance">Finance</DocLink>, so the numbers stay unique and self-identify
        across accounts. Accounts with linked Revenue or finance history cannot be deleted — archive
        them instead to keep the full relationship and billing history intact. If two rows represent
        the same company, use{" "}
        <DocLink to="/docs/revenue#account-merge">Revenue → Accounts → Merge</DocLink> to
        transactionally consolidate both Revenue and Finance history and archive the duplicate.
      </P>
      <P>
        The customer list searches customer names, domains, billing email addresses, phone numbers,
        tax IDs, and the names, roles, email addresses, and phone numbers of their contacts.
        Multiple words can match across those fields, so a search such as <Code>Acme finance</Code>{" "}
        can find Acme through a contact&apos;s Finance role. Results are shown 25 at a time with a
        visible range and Previous / Next controls. Search, page, and <Code>Show archived</Code> are
        kept in the page URL, so browser Back and Forward restore the same view. Archived customers
        remain hidden unless <Code>Show archived</Code> is selected.
      </P>
      <P>
        Wherever you pick a customer — on an invoice, estimate, recurring invoice, contract,
        signature, contact, or deal — each option shows the account&apos;s domain and billing email
        beside its name, so similarly named accounts are easy to tell apart. Typing a domain or an
        email address into the picker finds the account too. The billing email follows{" "}
        <DocLink to="/docs/revenue#billing-details">finance access</DocLink>: in Revenue&apos;s
        pickers — the Account on a contact or deal, and the destination of an Account merge — a
        Member whose access is None sees each account&apos;s name and domain only, and typing a
        billing email finds nothing.
      </P>

      <H2 id="access">Who can see and change customers</H2>
      <P>
        The customer list, <Code>New customer</Code>, and each customer&apos;s own pages — its
        overview, statement, and edit page — follow the{" "}
        <DocLink to="/docs/finance#finance-access">finance access</DocLink> an owner or admin sets
        for each Member under <Code>Settings → Members</Code>:
      </P>
      <UL>
        <LI>
          <Strong>Full</Strong> — browse, add, and edit customers.
        </LI>
        <LI>
          <Strong>Read-only</Strong> — browse the list, overviews, and statements without changing
          anything. The list leaves out <Code>New customer</Code> and each row&apos;s menu, and the
          overview leaves out <Code>Edit</Code> and the Billing tab&apos;s{" "}
          <Code>New invoice</Code>, <Code>New estimate</Code>, and{" "}
          <Code>New recurring invoice</Code>. Following a saved link to the New or Edit customer page
          shows a note that their finance access is read-only, with a <Code>Back</Code> button, in
          place of a form that couldn&apos;t be saved. Contracts don&apos;t depend on finance
          access, so they can still upload, edit, download, and delete them.
        </LI>
        <LI>
          <Strong>None</Strong> — each of those pages opens to a note saying they don&apos;t have
          access, however they reach it: the <Code>Customers</Code> link or a shared link. The note
          links to <Code>Revenue → Accounts</Code>, which lists the same accounts, and to{" "}
          <Code>Contracts</Code>, which every Member can open.
        </LI>
      </UL>
      <P>
        <Code>⌘K</Code> search follows the same setting. With Full or Read-only access it finds
        customers by name or billing email and opens the customer&apos;s page. With None, the same
        accounts are listed under <Strong>Revenue accounts</Strong> instead: they&apos;re found by
        name or domain, show the domain or industry beside the name, and open in{" "}
        <Code>Revenue → Accounts</Code>. Their billing emails are never shown, and searching for
        one finds nothing. The <Code>#</Code> picker in an{" "}
        <DocLink to="/docs/workspace-chat#resource-references">AI Employee chat</DocLink> uses the
        same search, so a Member with None tags the Revenue account.
      </P>

      <H2 id="overview">Customer overview</H2>
      <P>
        Click any customer&apos;s name to open everything about the account on one page. The
        header shows its status, billing email, phone, website, owner, and currency, with buttons
        for its <Strong>Revenue</Strong> account, its <Strong>Statement</Strong>, and{" "}
        <Strong>Edit</Strong>. The tabs below hold the rest, each with a count:
      </P>
      <UL>
        <LI>
          <Strong>Overview</Strong> — the headline numbers (annual contract value, outstanding
          balance, lifetime billed, open pipeline), an <Strong>action-needed</Strong> queue that
          surfaces overdue and unpaid invoices, estimates awaiting a response, and recurring
          invoice runs that are retrying or couldn&apos;t email their invoice, then the latest
          emails, activity, and open deals, every account detail, the people at the account, and
          custom fields.
        </LI>
        <LI>
          <Strong>Emails</Strong> — every conversation in your connected mailboxes with the
          customer&apos;s people. See <a href="#emails">how emails are matched</a>.
        </LI>
        <LI>
          <Strong>Activity</Strong> — the account&apos;s whole timeline: emails, calls, meetings,
          notes, tasks, deal moves, and sequence touches, including activity recorded against its
          contacts and deals before they were linked to the account.
        </LI>
        <LI>
          <Strong>Deals</Strong> — every deal with the account, open deals first, with stage,
          owner, value, and last activity, plus the open pipeline and won totals.
        </LI>
        <LI>
          <Strong>People</Strong> — the account&apos;s{" "}
          <DocLink to="/docs/revenue">Revenue contacts</DocLink>, with their lifecycle stage and
          latest activity, and its billing contacts.
        </LI>
        <LI>
          <Strong>Meetings</Strong> — the meetings linked to the account, with their recordings,
          transcripts, and summaries.
        </LI>
        <LI>
          <Strong>Billing</Strong> — invoices, estimates, recurring invoices, and credit notes.{" "}
          <Code>New recurring invoice</Code> opens a schedule for this customer, named after it (see{" "}
          <DocLink to="/docs/finance#recurring-names">naming a schedule</DocLink>).
        </LI>
        <LI>
          <Strong>Documents</Strong> — contracts, signature requests, and files.
        </LI>
      </UL>
      <P>
        Each row links to the record&apos;s own page — in Finance, Revenue, Mail, Meetings, or
        Signatures — where it is edited, and the customer&apos;s name on an invoice, estimate, or
        recurring invoice links back here. The open tab is kept in the page URL, so a shared link
        opens the same view.
      </P>

      <H3 id="emails">How emails are matched</H3>
      <P>
        The Emails tab searches every mailbox connected under <Code>Mail</Code>. A conversation
        belongs to the customer when one of its messages is from, to, or copied to the
        customer&apos;s billing email, one of its billing contacts, a Revenue contact linked to the
        account, or anyone at the account&apos;s <Strong>domain</Strong>, subdomains included. Blind
        copies, unsent drafts, spam, and trash are left out. Each conversation opens in Mail, in
        the mailbox it belongs to.
      </P>
      <P>
        Genosyn indexes the addresses on every message in the background, so a new email shows up
        here within a few minutes of reaching the mailbox. Mail already in a mailbox — after you
        connect it, or after upgrading to this release — is indexed the same way, and until that
        finishes the tab says some earlier conversations may not show yet.
      </P>
      <P>
        A free-mail domain such as <Code>gmail.com</Code>, or a domain your own company uses, is
        never matched as a whole: only the customer&apos;s exact addresses are. If the tab is empty,
        add the customer&apos;s domain, billing email, or a contact with an email address.
      </P>

      <H2 id="statements">Statements</H2>
      <P>
        Open a customer&apos;s overview and click <Code>Statement</Code>, or choose the customer
        under <Code>Finance → Customer statements</Code>, for a{" "}
        <Strong>statement of account</Strong> — the running ledger you&apos;d send a customer who
        asks &quot;what do I owe you?&quot;. It lists every issued invoice as a charge and every
        recorded payment as a credit, in date order, with a running balance carried from an{" "}
        <Strong>opening balance</Strong> down to the <Strong>balance due</Strong>. Draft and voided
        invoices are excluded — only real, issued activity appears.
      </P>
      <UL>
        <LI>
          <Strong>Period</Strong> — show all time (the default) or narrow to this month, this
          quarter, year to date, the last 12 months, or a custom date range. Anything before the
          start of the period is rolled into the opening balance.
        </LI>
        <LI>
          <Strong>Aging</Strong> — the outstanding balance broken into current, 1–30, 31–60, 61–90,
          and 90+ days past due, so you can see how stale the debt is at a glance.
        </LI>
        <LI>
          <Strong>Currency</Strong> — statements are per-currency. If an account has been billed in
          more than one, a switcher lets you pick which to view; balances are never summed across
          currencies.
        </LI>
        <LI>
          <Strong>Download PDF</Strong> or <Strong>Print view</Strong> — hand the customer a
          portable document, or open the print-friendly HTML to save from your browser. Invoice
          numbers on the in-app view link straight to the underlying document in{" "}
          <DocLink to="/docs/finance">Finance</DocLink>.
        </LI>
      </UL>

      <H2 id="acv">Annual Contract Value</H2>
      <P>
        Each customer carries an <Strong>Annual Contract Value</Strong> (ACV) — the expected yearly
        revenue from the account. Enter it on the New / Edit customer page as a plain amount; it is
        stored and displayed in the customer&apos;s default currency (so <Code>120000</Code> on a
        USD account reads as <Code>$120,000.00</Code>), and surfaces as its own column in the
        customer list. It&apos;s an independent sales metric — editing it never touches issued
        invoices, and leaving it blank simply shows a dash.
      </P>

      <H2 id="contacts">Contacts</H2>
      <P>
        Beyond the billing record, a customer can carry any number of <Strong>contacts</Strong>: the
        humans at that account, each with their own name, role, email, and phone. Mark one as the
        primary contact to surface it first. Add, edit, or remove contacts inline on the New / Edit
        customer page. Contacts are for your records — invoice and estimate email still goes to the
        customer&apos;s billing email.
      </P>
      <P>
        These lightweight contacts support billing records. The people you are selling to are{" "}
        <DocLink to="/docs/revenue">Revenue contacts</DocLink>, with their own timeline, deals,
        ownership, and outbound; they can link to an account while it is still a prospect.
      </P>

      <H2 id="contracts">Contracts</H2>
      <P>
        Upload the agreements you&apos;ve signed with a customer — MSAs, order forms, NDAs — and
        keep them next to the account. Each contract is a file (PDF, image, or document up to 25 MB)
        with a title, an optional <Strong>signed date</Strong>, notes, and an optional link to a
        customer.
      </P>
      <UL>
        <LI>
          The <Code>Customers → Contracts</Code> page lists every contract across all accounts,
          filterable by customer. Upload from here and pick which account it belongs to.
        </LI>
        <LI>
          Each customer&apos;s <Strong>Documents</Strong> tab, and its edit page, has a{" "}
          <Strong>Contracts</Strong> panel showing just that account&apos;s agreements, so you can
          upload one while you&apos;re looking at the customer.
        </LI>
      </UL>
      <P>
        Download, edit the details of, or delete any contract from either view. Files are stored on
        the server under your company&apos;s data directory, never in the database itself.
      </P>
      <P>
        To collect signatures rather than upload an agreement that is already complete, open{" "}
        <DocLink to="/docs/signatures">Signatures</DocLink>. A completed, Customer-linked request is
        archived here automatically with its signed date and evidence-backed PDF.
      </P>
    </>
  );
}
