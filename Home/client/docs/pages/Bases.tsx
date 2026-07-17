import {
  Callout,
  Code,
  DocLink,
  H2,
  KeyList,
  LI,
  P,
  PageHeader,
  Strong,
  UL,
} from "@/docs/Prose";

export function Bases() {
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Bases"
        lead={
          <>
            Airtable-style structured data built in: a <Strong>Base</Strong>{" "}
            holds tables of records with typed columns, saved views, comments,
            and file attachments — editable by your team and by granted AI
            employees. Find it under <Strong>Bases</Strong> in the section
            menu.
          </>
        }
      />

      <H2 id="tables-and-fields">Tables &amp; fields</H2>
      <P>
        A base contains one or more <Strong>tables</Strong>; each table is a
        grid of <Strong>records</Strong> with typed <Strong>fields</Strong>{" "}
        (columns). Add a field from the <Strong>+</Strong> button at the right
        edge of the grid header and pick a type:
      </P>
      <KeyList
        rows={[
          { term: "text / longtext", def: "One-line and multi-line text." },
          { term: "number", def: "Numeric value, right-aligned." },
          { term: "checkbox", def: "True / false." },
          { term: "date / datetime", def: "Calendar date, with or without time." },
          { term: "email / url", def: "Address-shaped text." },
          {
            term: "select / multiselect",
            def: "One or many colored tags; manage the options from the column header menu.",
          },
          {
            term: "link",
            def: "Reference rows in another table of the same base.",
          },
        ]}
      />
      <P>
        One field per table is the <Strong>primary field</Strong> (the amber
        key icon) — its value is the record&apos;s title wherever the record is
        referenced.
      </P>

      <H2 id="record-links">Record link columns</H2>
      <P>
        Beyond linking tables to each other, a column can link records to the
        rest of Genosyn. The <Strong>Link to Genosyn</Strong> group in the
        add-field menu offers a column type per product:
      </P>
      <KeyList
        rows={[
          {
            term: "Customer",
            def: (
              <>
                Finance customers — see <DocLink to="/docs/customers" />. A
                deals table with a Customer column keeps CRM rows attached to
                the account you invoice.
              </>
            ),
          },
          {
            term: "Invoice",
            def: (
              <>
                Invoices from <DocLink to="/docs/finance" /> — drafts show as{" "}
                <Code>Draft …</Code>, issued ones by their number.
              </>
            ),
          },
          {
            term: "Project",
            def: (
              <>
                Projects from <DocLink to="/docs/tasks" />. Restricted projects
                only appear to people who can already open them.
              </>
            ),
          },
          {
            term: "AI Employee",
            def: "Your AI employees — e.g. an “Owner” column on an accounts table.",
          },
          { term: "Member", def: "Human members of the company." },
          { term: "Note", def: "Notes from the knowledge base." },
          { term: "Pipeline", def: "Pipelines, labeled Enabled or Paused." },
        ]}
      />
      <P>
        Cells can hold one or many linked records. Each shows as a chip;
        clicking a chip jumps straight to that customer, invoice, project,
        note, or pipeline. Archived customers and notes stay resolvable in
        existing cells but are hidden from the picker, so new links always
        point at live records.
      </P>
      <Callout kind="tip" title="AI employees see the same links">
        Granted employees create these columns with{" "}
        <Code>add_base_field</Code> and read valid target ids from the{" "}
        <Code>resourceOptions</Code> map returned by{" "}
        <Code>list_base_rows</Code> — so a routine can, say, file every new
        deal against the right finance customer without you mapping ids by
        hand.
      </Callout>

      <H2 id="record-page">The record page</H2>
      <P>
        Every record has a full page at{" "}
        <Code>/bases/&lt;base&gt;/&lt;table&gt;/r/&lt;record&gt;</Code> with
        all columns viewable and editable, plus the comment thread and file
        attachments. Open it from the expand icon that appears when you hover
        a row, then the <Strong>Open full page</Strong> button in the drawer —
        or share the URL directly; it deep-links like any other page.
      </P>
      <UL>
        <LI>
          <Strong>Fields</Strong> — click any value to edit in place; the same
          editors as the grid, including the record-link pickers.
        </LI>
        <LI>
          <Strong>Files</Strong> — upload up to 25&nbsp;MB per file; AI
          employees can attach evidence via{" "}
          <Code>attach_file_to_record</Code>.
        </LI>
        <LI>
          <Strong>Comments</Strong> — humans and AI employees share one
          thread, so a routine&apos;s findings land next to your notes.
        </LI>
      </UL>

      <H2 id="views">Views, filters, and sorts</H2>
      <P>
        Each table has saved <Strong>views</Strong> — tabs above the grid that
        remember filters, sorts, and hidden fields. Filter operators adapt to
        the column type; record-link columns filter with{" "}
        <Code>has any of</Code> / <Code>has none of</Code> against the linked
        records. Views are shared: everyone in the company sees the same tabs.
      </P>

      <H2 id="ai-access">AI employees &amp; bases</H2>
      <P>
        Access is per-base: open <Strong>Base settings → AI access</Strong>{" "}
        and grant the employees who should read and write records. Granted
        employees get the full tool surface — listing and reading rows,
        creating and updating records, managing fields, commenting, and
        attaching files. See <DocLink to="/docs/integrations" /> for how
        Grants work across products.
      </P>
      <Callout kind="info" title="Templates">
        New bases can start from a template — CRM, applicant tracking,
        content calendar, or project tracker — with tables, fields, and
        example rows pre-seeded.
      </Callout>
    </>
  );
}
