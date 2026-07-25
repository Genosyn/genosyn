import {
  Callout,
  Code,
  DocLink,
  H2,
  H3,
  KeyList,
  LI,
  OL,
  P,
  PageHeader,
  Strong,
  UL,
} from "@/docs/Prose";

export function RevenueOperations() {
  return (
    <>
      <PageHeader
        eyebrow="Revenue"
        title="Revenue operations"
        lead={
          <>
            Run the daily follow-up queue, keep prospect accounts structured, manage partnerships
            and formal documents, and migrate Base or CSV records safely. These workflows live under{" "}
            <Code>Revenue</Code> and use the same services whether a Member or an AI Employee does
            the work.
          </>
        }
      />

      <H2 id="follow-ups">Follow-ups</H2>
      <P>
        Open <Code>Revenue → Follow-ups</Code> for one chronological queue across deal follow-up
        dates, partnership follow-up dates, and task activities. Switch between{" "}
        <Strong>Overdue</Strong>, <Strong>Today</Strong>, and <Strong>Upcoming</Strong> rather than
        opening every deal to find what needs attention.
      </P>
      <P>
        A deal carries a dedicated <Strong>Next follow-up</Strong> and optional reminder alongside
        its plain-language <Strong>Next step</Strong>. A follow-up task adds the task controls: due
        date, open/completed/cancelled status, Member or AI Employee assignee, priority, reminder,
        and daily, weekly, or monthly recurrence. Completing a recurring task creates the next
        occurrence automatically.
      </P>
      <Callout kind="tip" title="Use the queue as the daily sales home.">
        Deal close dates forecast revenue. Follow-up dates decide what you do today. Keep both; they
        answer different questions.
      </Callout>

      <H2 id="accounts">Prospect and customer accounts</H2>
      <P>
        <Code>Revenue → Accounts</Code> is the company record from first prospect conversation
        through billing and renewal. Create a prospect without creating an invoice, then keep the
        same record when it becomes a customer. Issuing its first invoice promotes a prospect to{" "}
        <Strong>Customer</Strong> automatically.
      </P>
      <KeyList
        rows={[
          {
            term: "Firmographics",
            def: "Domain, website, industry, employee count, and account status.",
          },
          {
            term: "Relationship",
            def: "A Member or AI Employee owner, account notes, contacts, and open deals.",
          },
          {
            term: "Finance",
            def: "Billing details, ACV, invoices, contracts, and statements on the same Customer row.",
          },
        ]}
      />
      <P>
        Domain is normalized and used for duplicate protection. Contacts keep their free-text
        company name too, because a person&apos;s employer and the legal billing entity can differ.
        Accounts with linked Revenue or finance history cannot be hard-deleted; archive them so
        their timeline remains intact.
      </P>

      <H2 id="custom-fields">Typed custom fields</H2>
      <P>
        Open <Code>Revenue → Setup</Code> to add company-specific fields to contacts, accounts,
        deals, or partnerships. Fields can be text, number, date, yes/no, URL, single select, or
        multi-select. Mark a field required when every record must carry it.
      </P>
      <P>
        Values are stored separately from notes and normalized for exact filtering, so product
        interest, current stack, company size, geographic requirements, competitor, procurement
        status, Stripe IDs, qualification signals, and custom tags stay reportable. AI Employees
        read and write the same typed values through Revenue tools.
      </P>
      <P>
        Use <Strong>Install Base migration fields</Strong> in Setup or Imports to add the
        recommended definitions for current monitoring stack, competitor/current provider, product
        interest, infrastructure size, geographic/compliance requirements, Stripe customer ID,
        qualification score and signals, procurement/security status, and original Base row ID. The
        action is idempotent, so running it again does not duplicate definitions. Definitions can be
        renamed, reordered, required, or archived from Setup; their stable keys do not change.
      </P>

      <H2 id="controlled-values">Controlled classifications</H2>
      <P>
        <Code>Revenue → Setup</Code> also owns the controlled lists for deal source, buying
        committee role, partnership type, and partnership status. Each option has a stable machine
        value and an editable label. Deal source includes <Strong>Self-Serve Upgrade</Strong> by
        default. Archive an option to remove it from pickers without changing historical records.
      </P>
      <P>
        Use these lists instead of free typing classifications. One <Code>inbound</Code> value with
        an <Code>Inbound</Code> label keeps reports whole; separate <Code>Inbound</Code>,{" "}
        <Code>inbound</Code>, and <Code>website</Code> strings do not.
      </P>
      <P>
        Add, relabel, reorder, archive, or restore classifications in Setup. Deal Stages are managed
        there too: add and edit stages, change their forecast probability, reorder the board, and
        archive an unused stage. A stage with an open Deal cannot be archived until those Deals move
        elsewhere.
      </P>

      <H2 id="documents">Formal document links</H2>
      <P>
        Contact, account, deal, and partnership pages carry a <Strong>Documents</Strong> panel. Link
        a proposal, RFP, security questionnaire, contract, email attachment, or other formal
        document as an uploaded file or external URL. The relationship is structured, so Members and
        AI Employees can find the right document without parsing a description field.
      </P>
      <P>
        Signed customer contracts still have their dedicated{" "}
        <DocLink to="/docs/customers#contracts">Customers workflow</DocLink>. Revenue document links
        cover the wider pre-signature and relationship context.
      </P>
      <P>
        Use the pencil action to change a document&apos;s kind, title, notes, or external URL. A
        linked file can be downloaded directly. Removing the document unlinks the Revenue record; it
        does not rewrite the source mail message or Base record the file originally came from.
      </P>

      <H2 id="activity-audit">Company-wide activity audit</H2>
      <P>
        Open <Code>Revenue → Activities</Code> to search activity subjects and bodies across the
        company, filter by kind and date range, inspect a row by its ID, or export the filtered
        history as CSV. Contact and Deal pages remain the fastest way to understand one
        relationship; Activities is the audit and cleanup surface.
      </P>
      <P>
        Notes, calls, meetings, and task activities can be corrected or deleted. Mail, Deal Stage,
        Sequence, suppression, and Signal activities are immutable because reports and compliance
        use them as evidence of what the system did. Correcting a manual activity recalculates the
        linked record&apos;s latest-activity date.
      </P>

      <H2 id="partnerships">Partnerships</H2>
      <P>
        Partnerships are not deals. Open <Code>Revenue → Partnerships</Code> for a partner-specific
        record with controlled type and status, a separate follow-up date, integration and channel
        context, notes, custom fields, documents, and its own activity timeline.
      </P>
      <P>
        Add multiple Revenue contacts, choose one primary contact, and mark every address that
        belongs on Reply-All. Those explicit rules stop a partner conversation from silently
        dropping the technical, channel, or commercial stakeholder.
      </P>

      <H2 id="imports">Base and CSV migration</H2>
      <P>
        Open <Code>Revenue → Imports</Code> to move data from a Genosyn Base or CSV. Use{" "}
        <Strong>Linked Account + Contact + Deal</Strong> when each legacy row contains all three:
      </P>
      <OL>
        <LI>Install the Base migration fields, then choose the source Base table or CSV.</LI>
        <LI>Map the Account, Contact, and Deal fields from the same source row.</LI>
        <LI>
          Run a <Strong>dry run</Strong> to see creates, duplicate matches, skipped rows, and the
          result for each of the three resources.
        </LI>
        <LI>
          Commit only after reviewing the preview. All three resources and their links are written
          in one database transaction.
        </LI>
      </OL>
      <P>
        The importer reuses an Account by normalized domain or name and a Contact by normalized
        email, then links the Deal to both. Rows from the same batch also reconcile with each other,
        so ten people from Acme create one Acme Account. The original Base row ID is written into
        the recommended custom field automatically. Choose Contacts, Accounts, Deals, or
        Partnerships instead when a source table genuinely contains one resource only.
      </P>
      <P>
        Every committed batch stores the field mapping, duplicate decisions, and source-row to
        native-ID map for reconciliation. Open <Strong>Report</Strong> at any time to recover the
        Import ID and mapping. For a Base import, <Strong>Migrate attachments</Strong> copies the
        source row attachments into Revenue Documents after the structured records exist; the pass
        is idempotent and reports failures separately. Rollback deletes the linked Deals, Contacts,
        then Accounts only when they are still safe to remove; anything that gained activities,
        documents, or finance history is kept and reported as blocked.
      </P>
      <Callout kind="warn" title="Controlled values must exist before import.">
        Deal sources and partnership type/status are validated through the lists in{" "}
        <Code>Revenue → Setup</Code>. Add the values first or the dry run will tell you which rows
        cannot be created.
      </Callout>

      <H2 id="ai-native">AI-native operation</H2>
      <P>
        Grant an AI Employee Revenue access from{" "}
        <DocLink to="/docs/revenue#ai-access">Revenue → AI access</DocLink>. Its granular tools can
        administer custom-field definitions, classifications and Deal Stages; own and update
        Accounts, Contacts, Deals, and Partnerships; search and correct manual activity; manage
        Sequences and Signal definitions; manage and download Revenue Documents; and preview, run,
        reconcile, attach, or roll back a linked Base migration.
      </P>
      <UL>
        <LI>
          <Strong>Read</Strong> exposes the queue, records, classifications, custom fields,
          documents, activities, and reports.
        </LI>
        <LI>
          <Strong>Write</Strong> allows the employee to perform the same service-backed updates as a
          Member. Every write is audited and journalled.
        </LI>
        <LI>
          A Base migration also requires access to the source Base, so a Revenue grant cannot be
          used to read an unrelated Base.
        </LI>
      </UL>
      <H3 id="suggested-routine">A useful sales Routine</H3>
      <P>
        Give a sales AI Employee a morning Routine that reads overdue and today&apos;s follow-ups,
        checks the latest mail and deal activity, updates the next step, drafts the recommended
        outreach, and creates the next assigned follow-up. Sending still follows the Revenue and
        mailbox grant levels described in <DocLink to="/docs/sequences">Sequences</DocLink>.
      </P>
    </>
  );
}
