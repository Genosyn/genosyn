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

export function RevenueDataQuality() {
  return (
    <>
      <PageHeader
        eyebrow="Revenue"
        title="Revenue data quality"
        lead={
          <>
            Reconcile duplicate records, preview bulk cleanup, restore historical Deal truth, review
            enrichment evidence, capture mail attachments, and export complete snapshots from{" "}
            <Code>Revenue → Data quality</Code>.
          </>
        }
      />

      <H2 id="merge">Merge and archive core records</H2>
      <P>
        Genosyn scans every company at startup and then every six hours on a leased background
        schedule. Run <Strong>Scan duplicates</Strong> when you want an immediate pass across
        Accounts, Contacts, Deals, and Partnerships. Detection uses exact or aliased domains,
        normalized company names, Contact email aliases, website redirects, shared Stripe customer
        IDs, and similar Deal titles within one Account. It only proposes candidates; it never
        merges automatically.
      </P>
      <OL>
        <LI>Choose which candidate is the surviving record.</LI>
        <LI>
          Review every conflicting field and the counts of relationships and custom values that will
          move. Choose the source or survivor value for each conflict; coupled ownership and Deal
          status fields are validated together before the merge can commit.
        </LI>
        <LI>Type the duplicate record&apos;s displayed label and confirm.</LI>
      </OL>
      <P>
        Genosyn moves Contacts, Deals, Activities, follow-ups, Documents, buying committees,
        Partnership contacts, finance references, and compatible custom values in one transaction.
        It keeps names, domains, emails, websites, original IDs, and source IDs as searchable
        aliases. The duplicate becomes an archived tombstone that redirects callers to the survivor
        instead of disappearing.
      </P>
      <P>
        Archive and restore are symmetrical across Accounts, Contacts, Deals, and Partnerships.
        Archived records stay out of default lists while their timelines and links remain
        resolvable. A tombstone created by a merge cannot be restored directly; use the guarded
        merge undo so references cannot split between the old and surviving records.
      </P>
      <Callout kind="info" title="Every merge has guarded undo.">
        The audit history stores exact before-and-after rows. Undo first verifies that none of those
        rows changed after the merge; if newer work exists, it stops instead of overwriting it.
      </Callout>

      <H2 id="bulk">Bulk record and follow-up operations</H2>
      <P>
        Select records or use a saved filter, choose an action, and press <Strong>Preview</Strong>.
        The dry run resolves the same population as the write, validates every row, and reports
        valid, skipped, and failed records without changing data.
      </P>
      <KeyList
        rows={[
          {
            term: "Core records",
            def: "Assign a Member or AI Employee owner, change Contact lifecycle or Account status, update allowed standard or typed custom fields, and archive or restore selected records.",
          },
          {
            term: "Follow-ups",
            def: "Complete, cancel, reassign, reprioritize, or reschedule tasks and linked Deal or Partnership follow-up dates.",
          },
          {
            term: "Safety",
            def: "Committed requests use an idempotency key, return a result for every row, preserve partial failures, write audit history, and can be rolled back.",
          },
        ]}
      />
      <P>
        The Follow-ups page also supports selection and bulk triage. Filter by any assignee or
        unassigned, priority, linked resource type and ID, status, due-date range, age, Deal Stage
        or status, and whether the linked Deal is closed. This makes rules such as &quot;cancel
        stale follow-ups on closed-lost Deals&quot; previewable before they are applied.
      </P>
      <P>
        Large writes run as durable background jobs. The preview freezes the selected IDs, the job
        reports progress and row-level reconciliation, and queued or interrupted work resumes after
        restart. Choose <Code>atomic</Code> when every row must validate or <Code>partial</Code>{" "}
        when valid rows may proceed and failures should be exported for repair.
      </P>
      <P>
        <Strong>Set standard fields</Strong> accepts one JSON patch for every selected record.
        Identity collisions, Account and Contact links, controlled Deal sources, Partnership
        classifications, currencies, and dates are validated before writing. Notes can be replaced,
        appended, or cleared. Deal amount, owner, and expected-close changes also append immutable
        history events, so bulk cleanup cannot silently rewrite reporting truth.
      </P>

      <H2 id="deal-history">Historical Deal truth and funnel reporting</H2>
      <P>
        Start with <Strong>Deal history coverage</Strong>. It shows each Deal&apos;s completeness,
        native, imported, and Activity-backfill event counts, source-import references, and a
        recommendation. This separates a genuinely missing pre-migration ledger from a Deal whose
        lifecycle Activities can be converted safely. The page loads the complete bounded inventory
        before enabling selection and refuses a population that changes between pages, so{" "}
        <Strong>Select recommended</Strong> cannot silently omit later Deals.
      </P>
      <P>
        Use <Strong>Historical Deal import</Strong> for original creation timestamps, Deal Stage
        transitions, won or lost timestamps, amount and currency changes, expected-close changes,
        lost reasons, and owner changes. Name the source system, give every source record and event
        a stable ID, set its effective timestamp, and label each Deal&apos;s history as{" "}
        <Code>complete</Code>, <Code>partial</Code>, or <Code>snapshot_only</Code>. Source identity
        stays stable across batches, so replaying an event is idempotent. Events retain their
        original timestamps rather than pretending the migration happened today.
      </P>
      <P>
        To reuse existing immutable Deal Activities, select explicit Deal IDs and preview{" "}
        <Strong>Backfill Deal activities</Strong> first. An unscoped commit is refused. A
        migration-time <Code>deal_created</Code> Activity becomes a snapshot, not a fabricated
        original creation boundary; import the real source history first when coverage recommends
        it. Replaying the same scoped backfill is idempotent.
      </P>
      <P>
        Change events must carry a real boundary: amount events need a before or after amount or
        currency, owner events need a before or after Member or AI Employee owner, and
        expected-close events need a before or after date. Use an explicit <Code>null</Code> after
        value when a source event cleared an owner or date.
      </P>
      <H3>Preview, commit, and undo</H3>
      <OL>
        <LI>
          Paste the import contract and choose <Strong>Preview import</Strong>. Genosyn reports
          every accepted, rejected, chronologically reordered, conflicting, and duplicate source
          event without writing.
        </LI>
        <LI>
          Resolve unknown Deal Stages, broken stage boundaries, missing lost reasons, or timestamps
          that overlap native post-migration history.
        </LI>
        <LI>
          Choose <Strong>Import accepted events</Strong>. The batch preserves source actor and
          metadata provenance and appears under <Strong>Audit and undo</Strong>.
        </LI>
      </OL>
      <Callout kind="warn" title="Native history always wins.">
        An imported event cannot overlap the Deal&apos;s live ledger. Undo removes only events
        created by that import and restores only original creation or close fields changed by the
        batch; it refuses if later work changed those fields.
      </Callout>
      <P>
        <Code>Revenue → Insights</Code> uses these events for entered-stage and progressed-stage
        counts, original-cohort conversion, period won/lost counts, median time in stage, and median
        sales cycle. Complete histories participate in cohort conversion. Partial histories
        contribute only metrics whose entry and exit boundaries are known. Snapshot-only and
        history-free Deals stay in current totals but never enter historical transition metrics.
        Every funnel shows all four coverage counts so pre-cutover gaps stay explicit.
      </P>

      <H2 id="enrichment">Controlled enrichment and provenance</H2>
      <P>
        Domain proposals come only from verified business email evidence or Account websites. Public
        mailbox providers are rejected, known host aliases and subdomains are normalized, website
        redirects are followed through the safe outbound-request guard, and name mismatch lowers
        confidence. A collision creates a merge candidate. A proposal never replaces a verified
        domain automatically.
      </P>
      <P>
        Members with Finance access can open <Strong>Commercial-value backlog</Strong> to load the
        complete bounded set of open zero-value Deals before proposing anything. Each row explains
        whether it has a Finance candidate, a linked Stripe customer, an ambiguous Account with
        several zero-value Deals, an existing proposal awaiting review, or no usable evidence.
        Choose <Strong>Select Finance candidates</Strong> or{" "}
        <Strong>Select Stripe candidates</Strong>, review the selected Deals, then choose a
        connected Stripe Connection when Stripe is the evidence source. Both actions create
        proposals only.
      </P>
      <P>
        Commercial-value proposals can use paid or sent Finance invoices, accepted estimates,
        Account ACV, verified Stripe subscriptions, reviewed proposals or quotes, and confirmed
        email terms. Values carry currency, one-time or recurring shape, billing interval, quantity
        or seats, MRR, ARR, ACV, source, and confidence. Unverified prose is rejected. Only a human
        Member can accept or reject a commercial-value proposal, and acceptance is refused if the
        Deal changed after the proposal was generated. Accepting a current value updates the Deal
        and writes a real amount-history event.
      </P>
      <P>
        Every derived field keeps its source email, document, Integration, import, or manual
        evidence; extracted value and date; confidence; last-verified date; and human-confirmed
        status. Members accept, reject, or explicitly supersede a previously verified value in the
        evidence queue. Typed custom fields show the current source and verification state beside
        the value; older values are backfilled honestly as unverified rather than assigned an
        invented source.
      </P>

      <H2 id="document-capture">Revenue document capture</H2>
      <P>
        Gmail sync automatically detects relevant attachments and proposes proposal, RFP, contract,
        security questionnaire, and pricing-file links as each message is stored. It suggests the
        Account, Contact, Deal, or Partnership from message participants and Deal context. Source
        Gmail message and attachment IDs prevent repeat candidates; content hashes prevent duplicate
        files.
      </P>
      <P>
        High-confidence links still wait for review. For an ambiguous file, choose the resource type
        and paste its record ID before capture. The file is downloaded only when accepted, and its
        message, attachment index, hash, classification, and reviewer remain as provenance. Use{" "}
        <Strong>Scan mail attachments</Strong> for a historical mailbox backfill.
      </P>

      <H2 id="exports">Exports and import reconciliation</H2>
      <P>
        Snapshot exports cover Accounts, Contacts, Deals, Partnerships, Partnership contacts, buying
        committees, follow-ups, Documents, Deal Stage definitions, custom-field definitions and
        values, import reconciliation, immutable Deal history, field evidence, duplicate candidates,
        operation audit rows, and Gmail document candidates. CSV and JSON endpoints use a frozen
        snapshot boundary and paginated cursors or offsets, so operators can continue until the
        export is complete without later writes moving records between pages. AI Employees need the
        source Mail Account ID and a read Grant to that exact mailbox to export Gmail document
        candidates; Revenue access alone does not reveal mailbox-derived metadata.
      </P>
      <P>
        Import history now has a lightweight summary listing, lookup by Import ID, filters for
        source, date, status, and resource, and separately paginated row decisions. Download any
        reconciliation as CSV or JSON, including a focused failed, skipped, or duplicate export. Row
        filters include action, resource, error text, source ID, and native ID. Opening{" "}
        <Strong>Report</Strong> fetches only the first page of decisions and pages through the rest
        without loading the legacy payload.
      </P>

      <H3 id="related">Related workflows</H3>
      <UL>
        <LI>
          <DocLink to="/docs/revenue-operations">Revenue operations</DocLink> for daily follow-ups,
          Imports, custom fields, Partnerships, and Documents.
        </LI>
        <LI>
          <DocLink to="/docs/revenue#insights">Revenue Insights</DocLink> for report semantics.
        </LI>
        <LI>
          <DocLink to="/docs/customers">Customers</DocLink> for the shared Account and finance
          record.
        </LI>
      </UL>
    </>
  );
}
