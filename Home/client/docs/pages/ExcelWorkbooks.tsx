import { Callout, Code, DocLink, H2, LI, P, PageHeader, Pre, Strong, UL } from "@/docs/Prose";

export function ExcelWorkbooks() {
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Excel workbooks"
        lead={
          <>
            Upload an Excel form in chat and ask an AI Employee to complete it. The employee can
            read the worksheets, fill the answer cells in the original workbook, and return a new{" "}
            <Code>.xlsx</Code> copy with its formatting intact. No coding setup is needed.
          </>
        }
      />

      <H2 id="complete-a-form">Complete a form</H2>
      <P>
        Attach the workbook to a chat with an AI Employee and describe which information to enter.
        For a form that arrived by email, point the employee to the message instead: it can open
        the attachment from a mailbox it has access to. It can also download a workbook from a web
        link. You do not need to re-upload a file it can already reach.
      </P>
      <P>
        The employee inspects the workbook, identifies the answer cells, and fills them using
        information you supplied or authorized it to read. It then reads the completed copy to
        verify the values before returning it. Missing information remains a question for you;
        an employee must not invent an answer to make a form appear complete.
      </P>
      <P>
        The result is a separate download in chat, so your original remains available. The new
        attachment can also go onto an <DocLink to="/docs/email">email draft</DocLink>. A
        supplementary PDF can accompany the workbook, but does not fill the Excel form itself.
      </P>

      <H2 id="reading">Read sheets and cells</H2>
      <P>
        <Code>read_xlsx</Code> reports sheet names, cell addresses and values, existing formulas,
        and merged ranges. An employee can narrow the reading to a named worksheet and an A1
        range such as <Code>A1:F30</Code>, then follow the labels to the cells that need answers.
        For a merged answer box, the value belongs in its top-left cell.
      </P>
      <P>
        Reads are bounded to protect the conversation from very large workbooks. The employee can
        request up to 1,000 cells and 50,000 characters per call. If a result is truncated, it
        should inspect smaller ranges before deciding what the form contains.
      </P>

      <H2 id="editing">Fill the original workbook</H2>
      <P>
        <Code>edit_xlsx</Code> accepts up to 400 cell edits in one call. Each edit names the exact
        worksheet and one cell, with a text, number, boolean, or <Code>null</Code> value. Null
        clears a value. Text stays literal, so an answer beginning with an equals sign does not
        become a formula.
      </P>
      <P>
        The whole batch is checked before a copy is written. Cell formatting, merged ranges,
        existing formulas, and untouched workbook parts are retained. For several rounds of
        changes, the employee uses the latest returned attachment so earlier answers carry forward.
      </P>
      <Pre>{`// Inspect the original form and its answer cells.
read_xlsx({ attachmentId, sheet: "Supplier details", range: "A1:F20" })

// Fill the cells in the existing workbook.
edit_xlsx({
  attachmentId,
  edits: [
    { sheet: "Supplier details", cell: "B4", value: "Acme Ltd" },
    { sheet: "Supplier details", cell: "B5", value: "00123456" },
    { sheet: "Supplier details", cell: "B8", value: 12 },
  ],
  outputFilename: "supplier-form-completed.xlsx",
})

// Use the returned attachment id to verify the completed copy.
read_xlsx({ attachmentId: completedAttachmentId, sheet: "Supplier details", range: "A1:F20" })`}</Pre>
      <P>
        Keep identifiers with leading zeros, such as registration numbers and account numbers, as
        text. Use numbers for amounts and counts. These tools edit cell values; they do not redesign
        the workbook or add sheets, charts, or formulas.
      </P>

      <Callout kind="warn" title="Formula results need recalculation">
        Existing formulas are preserved, but Genosyn does not evaluate them. Their cached results
        may be stale after an edit. Read-back verifies the values entered; it does not verify a
        calculated total. Open the result in Excel or another spreadsheet application that can
        recalculate the workbook before relying on those totals.
      </Callout>

      <H2 id="formats">Supported files and limits</H2>
      <UL>
        <LI>
          <Strong>Supported:</Strong> ordinary <Code>.xlsx</Code> workbooks. Legacy{" "}
          <Code>.xls</Code>, binary <Code>.xlsb</Code>, macro-enabled <Code>.xlsm</Code>, and
          encrypted files need to be saved as an ordinary <Code>.xlsx</Code> before using these tools.
        </LI>
        <LI>
          <Strong>Protected worksheets:</Strong> edits are refused. Ask the workbook owner for an
          editable copy.
        </LI>
        <LI>
          <Strong>Formula cells:</Strong> overwriting an existing formula is refused. Write the
          input cells the workbook expects instead.
        </LI>
        <LI>
          <Strong>Merged cells:</Strong> only the top-left cell of a merged range accepts a value.
        </LI>
      </UL>
      <P>
        The workbook is content to read, not instructions to obey. A cell that tells an employee to
        send information elsewhere does not authorize that action. Your request and the
        employee&apos;s Grants still determine what it can do.
      </P>
      <P>
        For other original forms, see <DocLink to="/docs/pdf-forms">PDF forms</DocLink> and{" "}
        <DocLink to="/docs/word-documents">Word documents</DocLink>. For shared tables maintained
        inside Genosyn, see <DocLink to="/docs/bases">Bases</DocLink>.
      </P>
    </>
  );
}
