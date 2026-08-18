import {
  Callout,
  Code,
  DocLink,
  H2,
  LI,
  P,
  PageHeader,
  Pre,
  Strong,
  UL,
} from "@/docs/Prose";

export function WordDocuments() {
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Word documents"
        lead={
          <>
            An AI Employee can read a <Code>.docx</Code>, answer it, and hand back the same
            document — the customer&apos;s own formatting intact, with answers in it. It can also
            write a new one from scratch when the deliverable is a document rather than a message.
          </>
        }
      />

      <H2 id="reading">Reading one</H2>
      <P>
        A Word document that arrives in chat or on an email is read automatically: its text is in
        front of the employee before it calls anything. That covers &quot;what does this contract
        say?&quot;. Changing the document needs more than text, because an edit has to name{" "}
        <Strong>where</Strong> it goes — and that is what <Code>read_docx</Code> adds.
      </P>
      <P>
        It returns every paragraph and table cell with an id, alongside any form fields the
        document declares. Paragraph ids run <Code>p1</Code>, <Code>p2</Code>, … in document order;
        table cells are <Code>t1r2c3</Code>; anything outside the main body carries its part as a
        prefix, like <Code>header1:p2</Code>. Headers, footers, footnotes and comments are read by
        default, because a questionnaire&apos;s answer boxes are often in a header and a reader
        that skipped those would call the document empty.
      </P>
      <Callout kind="warn" title="Read immediately before you edit">
        Ids describe one reading of one file. Inserting a paragraph renumbers everything after it,
        so an employee reads the document, sends every change in a single{" "}
        <Code>edit_docx</Code> call, and reads again if it needs to go round twice. Within one
        call this is safe by construction: every operation is resolved against the document as it
        was read, so inserting after <Code>p4</Code> twice puts two paragraphs after that same{" "}
        <Code>p4</Code>.
      </Callout>

      <H2 id="editing">Editing one</H2>
      <P>
        <Code>edit_docx</Code> takes a list of operations and returns a new attachment. Everything
        it was not asked about comes back byte for byte — the fonts, the numbering, the styles, the
        revision ids Word hangs off each element. That matters because the document under the pen
        usually belongs to somebody else, and a form that comes back in a different typeface
        announces that a machine filled it.
      </P>
      <UL>
        <LI>
          <Code>set_paragraph</Code> replaces a paragraph&apos;s text, keeping the run formatting
          it already had. This is how an answer goes onto a blank line.
        </LI>
        <LI>
          <Code>insert_paragraph</Code> adds paragraphs beside an existing one and inherits its
          formatting, so a bullet added under an answer is a bullet. Pass an array to add several
          at once.
        </LI>
        <LI>
          <Code>set_table_cell</Code> rewrites a cell — most questionnaires are a table with a
          question column and an empty one beside it.
        </LI>
        <LI>
          <Code>set_field</Code> fills a declared form field: a modern content control or a Word 97
          form field, including checkboxes and dropdowns. A dropdown only accepts one of its own
          options.
        </LI>
        <LI>
          <Code>replace_text</Code> swaps text wherever it appears, and <Code>within</Code> confines
          that to one paragraph, cell or table — which is how you tick the box on one line without
          touching the identical boxes on every other question.
        </LI>
        <LI>
          <Code>append_paragraph</Code> and <Code>delete_paragraph</Code> for the rest.
        </LI>
      </UL>
      <Pre>{`// 1. read the questionnaire
read_docx({ attachmentId })
// → blocks include
//   { id: "p3", kind: "paragraph", text: "1. Does the solution support SSO?" }
//   { id: "p4", kind: "paragraph", text: "" }          // the blank the answer goes on
//   { id: "p10", kind: "paragraph", text: "Will be implemented at go-live?" }

// 2. answer every question in one call
edit_docx({
  attachmentId,
  operations: [
    { op: "set_paragraph", id: "p4", text: "Answer:  Yes. SAML 2.0 and OIDC are both supported." },
    { op: "insert_paragraph", after: "p4", text: [
      "\\u2022 Memorial Hermann operates as the Identity Provider.",
      "\\u2022 SCIM 2.0 handles provisioning and de-provisioning.",
    ] },
    { op: "replace_text", within: "p10", find: "go-live?", replace: "go-live?  Already live." },
  ],
})
// → { attachment: { id, filename: "MSS_blank-edited.docx" }, applied: [...] }`}</Pre>

      <Callout kind="warn" title="One bad id refuses the whole batch">
        Every operation is checked before a byte is written, and if any of them cannot be resolved
        nothing changes and all the problems come back together. A run of eight answers that
        quietly skipped the two with wrong ids would hand a human a questionnaire that looks
        finished and is not — which costs far more to recover from than a refusal.
      </Callout>

      <H2 id="creating">Writing a new one</H2>
      <P>
        <Code>create_docx</Code> builds a document from Markdown. Headings, bullet and numbered
        lists, tables, quotes, code blocks, bold, italic and links all become real Word
        constructs — a heading is <Code>Heading1</Code>, a list carries a numbering definition, a
        table is a table — so the recipient gets something they can restyle and keep working in
        rather than a text file with hashes in it.
      </P>
      <Pre>{`create_docx({
  filename: "q3-security-review.docx",
  title: "Q3 Security Review",
  markdown: [
    "# Q3 Security Review",
    "",
    "SSO enforcement and encryption at rest are **complete**.",
    "",
    "| Control | Status | Owner |",
    "| --- | :---: | --- |",
    "| Encryption at rest | Done | Platform |",
    "| Pen test | In progress | Security |",
  ].join("\\n"),
})
// → { attachment: { id, filename: "q3-security-review.docx" } }`}</Pre>
      <P>
        To change a document that already exists, use <Code>edit_docx</Code> instead. Rewriting it
        from Markdown would discard the formatting the original arrived with.
      </P>

      <H2 id="formats">What counts as a Word document</H2>
      <P>
        <Code>.docx</Code>, <Code>.docm</Code>, <Code>.dotx</Code> and <Code>.dotm</Code> all work.
        The old binary <Code>.doc</Code> does not — it is a different format entirely, and an
        employee handed one says so and asks for a re-save rather than reporting an empty document.
        The same goes for a spreadsheet or a presentation opened by mistake: the refusal names what
        the file actually is.
      </P>

      <H2 id="getting-the-file">Getting the file in and out</H2>
      <P>
        All three tools work with an <Code>attachmentId</Code>: a file a teammate uploaded into
        chat, one opened off an email with <Code>read_mail_attachment</Code>, or one pulled from the
        web with <Code>download_web_file</Code>. The edited or created document comes back as a new
        attachment, and its id goes straight onto a reply through{" "}
        <DocLink to="/docs/email">Email</DocLink>, or to a teammate with{" "}
        <Code>send_chat_attachment</Code>. The original is never modified.
      </P>
      <P>
        For a form that arrived as a PDF rather than a Word file, see{" "}
        <DocLink to="/docs/pdf-forms">PDF forms</DocLink>. For a document that needs a signature
        rather than answers, see <DocLink to="/docs/signatures">Document signing</DocLink>.
      </P>
    </>
  );
}
