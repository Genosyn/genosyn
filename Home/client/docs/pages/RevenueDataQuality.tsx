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
        Run <Strong>Scan duplicates</Strong> to find candidates across Accounts, Contacts, Deals,
        and Partnerships. Detection uses exact or aliased domains, normalized company names,
        Contact email aliases, website redirects, shared Stripe customer IDs, and similar Deal
        titles within one Account. It only proposes candidates; it never merges automatically.
      </P>
      <OL>
        <LI>Choose which candidate is the surviving record.</LI>
        <LI>
          Review every conflicting field and the counts of relationships and custom values that
          will move. The survivor&apos;s populated fields win.
        </LI>
        <LI>Type the duplicate record&apos;s displayed label and confirm.</LI>
      </OL>
      <P>
        Genosyn moves Contacts, Deals, Activities, follow-ups, Documents, buying committees,
        Partnership contacts, finance references, and compatible custom values in one transaction.
        It keeps names, domains, emails, websites, original IDs, and source IDs as searchable
        aliases. The duplicate becomes an archived tombstone that redirects callers to the
        survivor instead of disappearing.
      </P>
      <Callout kind="info" title="Every merge has guarded undo.">
        The audit history stores exact before-and-after rows. Undo first verifies that none of those
        rows changed after the merge; if newer work exists, it stops instead of overwriting it.
      </Callout>

      <H2 id="bulk">Bulk record and follow-up operations</H2>
      <P>
        Target newline-separated selected IDs or a JSON filter, choose an action, and press{" "}
        <Strong>Preview</Strong>. The dry run resolves the same population as the write, validates
        every row, and reports valid, skipped, and failed records without changing data.
      </P>
      <KeyList
        rows={[
          {
            term: "Core records",
            def: "Assign a Member or AI Employee owner, change Contact lifecycle or Account status, update typed custom fields, and archive or restore selected records.",
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

      <H2 id="deal-history">Historical Deal truth and funnel reporting</H2>
      <P>
        Use <Strong>Historical Deal import</Strong> for original creation timestamps, Deal Stage
        transitions, won or lost timestamps, amount changes, lost reasons, and owner changes. Each
        row carries a stable batch/source key, so replaying an import is idempotent. Events retain
        their original timestamps rather than pretending the migration happened today.{" "}
        <Strong>Backfill Deal activities</Strong> can materialize history from existing immutable
        Deal Activities.
      </P>
      <P>
        <Code>Revenue → Insights</Code> uses these events for entered-stage and progressed-stage
        counts, original-cohort conversion, period won/lost counts, median time in stage, and median
        sales cycle. Current-stage cards remain a point-in-time view, but they are never divided to
        claim conversion. A coverage notice identifies complete, partial, imported, and
        history-free Deals so pre-cutover gaps stay explicit.
      </P>

      <H2 id="enrichment">Controlled enrichment and provenance</H2>
      <P>
        Domain proposals come only from verified business email evidence or Account websites.
        Public mailbox providers are rejected, known host aliases and subdomains are normalized,
        website redirects are followed through the safe outbound-request guard, and name mismatch
        lowers confidence. A collision creates a merge candidate. A proposal never replaces a
        verified domain automatically.
      </P>
      <P>
        Commercial-value proposals can use paid or sent Finance invoices, Account ACV, verified
        Stripe subscriptions, reviewed proposals or quotes, and confirmed email terms. Values carry
        currency, one-time or recurring shape, billing interval, quantity or seats, MRR, ARR, ACV,
        source, and confidence. Unverified prose is rejected. Accepting a value updates the Deal and
        writes a real amount-history event.
      </P>
      <P>
        Every derived field keeps its source email, document, Integration, import, or manual
        evidence; extracted value and date; confidence; last-verified date; and human-confirmed
        status. Members accept or reject proposals in the evidence queue.
      </P>

      <H2 id="document-capture">Revenue document capture</H2>
      <P>
        Mail sync detects relevant attachments and proposes proposal, RFP, contract, security
        questionnaire, and pricing-file links. It suggests the Account, Contact, Deal, or
        Partnership from message participants and Deal context. Source message plus attachment
        position prevents repeat candidates; content hashes prevent duplicate files.
      </P>
      <P>
        High-confidence links still wait for review. For an ambiguous file, choose the resource type
        and paste its record ID before capture. The file is downloaded only when accepted, and its
        message, attachment index, hash, classification, and reviewer remain as provenance. Use{" "}
        <Strong>Scan mail attachments</Strong> for a historical mailbox backfill.
      </P>

      <H2 id="exports">Exports and import reconciliation</H2>
      <P>
        Snapshot exports cover Accounts, Contacts, Deals, Partnerships, buying committees,
        follow-ups, Documents, Deal Stage definitions, custom fields, and import reconciliation.
        CSV and JSON endpoints are paginated and return the next offset, so operators can continue
        until the snapshot is complete instead of receiving a truncated first page.
      </P>
      <P>
        Import history now has a lightweight summary listing, lookup by Import ID, filters for
        source, date, status, and resource, and separately paginated row decisions. Download any
        reconciliation as CSV or JSON. Opening <Strong>Report</Strong> fetches only the first page
        of decisions and pages through the rest without loading the legacy payload.
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
