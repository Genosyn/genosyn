import { Callout, Code, DocLink, H2, LI, P, PageHeader, Pre, Strong, UL } from "@/docs/Prose";

export function PdfForms() {
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="PDF forms"
        lead={
          <>
            Give an AI Employee a form and have the completed original come back — not a retyped
            summary of it. Genosyn handles both kinds of PDF: the ones built with real interactive
            fields, and the far more common ones that were laid out for a printer and have none.
          </>
        }
      />

      <H2 id="two-kinds">Two kinds of form</H2>
      <P>
        A PDF that was exported from a form builder carries an <Strong>AcroForm</Strong>: named
        fields a program can set. A PDF that was printed, scanned, or exported from a word processor
        carries none — the boxes and ruled lines on it are just bloom. The two need different tools,
        and the first thing an employee does is find out which it is holding.
      </P>
      <UL>
        <LI>
          <Code>read_pdf_fields</Code> lists the interactive fields, with each one&apos;s name,
          type, current value, and — for dropdowns and radio groups — the options it accepts.
        </LI>
        <LI>
          <Code>fill_pdf_form</Code> sets those fields and returns the filled document. By default
          it flattens the result so the values are baked in; pass <Code>flatten: false</Code> to
          leave it editable.
        </LI>
      </UL>
      <P>
        If <Code>read_pdf_fields</Code> comes back empty, the document is the second kind, and the
        pair below takes over.
      </P>

      <H2 id="no-fields">Forms with no fields</H2>
      <P>
        These are completed by drawing on top of the original. The source pages stay exactly as they
        are and become the background, so what the counterparty receives is their own form with
        answers on it.
      </P>
      <UL>
        <LI>
          <Code>read_pdf_layout</Code> reports each page&apos;s displayed size and rotation, plus
          every run of printed text and where it sits. That is how the employee finds{" "}
          <Code>Full name:</Code> and the blank after it instead of guessing at coordinates.
        </LI>
        <LI>
          <Code>overlay_pdf_text</Code> draws text and tick marks at those coordinates and returns
          the completed document.
        </LI>
      </UL>

      <H2 id="coordinates">Coordinates</H2>
      <P>
        Every coordinate in both tools is measured in{" "}
        <Strong>points from the top-left corner of the page as it appears on screen</Strong> — the
        way a person reads a page, not the way PDF stores one. A page&apos;s <Code>/Rotate</Code> is
        already applied, so a landscape scan reports the width and height you actually see and needs
        no adjustment.
      </P>
      <P>
        Positions round-trip exactly. A run&apos;s <Code>y</Code> handed back as{" "}
        <Code>anchor: &quot;top&quot;</Code>, or its <Code>baselineY</Code> handed back as{" "}
        <Code>anchor: &quot;baseline&quot;</Code>, lands on the line it was read from. Reusing the
        nearby label&apos;s <Code>fontSize</Code> keeps the answer the same size as the form.
      </P>
      <Pre>{`// 1. find the label
read_pdf_layout({ attachmentId })
// → pages[0].texts includes
//   { text: "Full name:", x: 72, y: 86.2, width: 55, baselineY: 92, fontSize: 12 }

// 2. write in the gap after it, on the same line
overlay_pdf_text({
  attachmentId,
  items: [
    { page: 1, x: 200, y: 92, anchor: "baseline", size: 12, text: "Ada Lovelace" },
    { page: 1, x: 96, y: 300, type: "check", size: 10 },
  ],
})
// → { attachment: { id, filename: "supplier-form-completed.pdf" }, warnings: [] }`}</Pre>

      <H2 id="what-you-can-draw">What you can draw</H2>
      <UL>
        <LI>
          <Strong>Text</Strong>, at a point size and colour, optionally wrapped into a column with{" "}
          <Code>maxWidth</Code> and aligned left, centre, or right. Newlines start a new line, so a
          postal address goes on in one item.
        </LI>
        <LI>
          <Strong>Tick marks</Strong> — <Code>check</Code> and <Code>cross</Code> — stroked as
          geometry rather than set as a character, so they land square inside a printed box.
        </LI>
      </UL>
      <P>
        Text is drawn in Noto, with Arabic and Chinese faces embedded only when the text needs them,
        so a form answered in more than one script comes out right without anyone choosing a font.
      </P>

      <Callout kind="warn" title="Read the warnings">
        Anything unrenderable is refused before a single mark is made — a page that does not exist,
        a size that is not a size, a character no shipped face can draw. But a placement that is
        merely <Strong>suspicious</Strong>, such as an answer that runs off the edge of the page, is
        still drawn and reported in <Code>warnings</Code>. Nobody re-reads a form they asked an
        employee to fill, so those warnings are the last check before it is sent.
      </Callout>

      <H2 id="getting-the-file">Getting the file in and out</H2>
      <P>
        All four tools take an <Code>attachmentId</Code>. That can be a file a teammate uploaded
        into chat, one opened off an email with <Code>read_mail_attachment</Code>, or one pulled
        from the web with <Code>download_web_file</Code> — which is how an employee fetches the
        current blank version of a form it has been asked to complete.
      </P>
      <P>
        The completed document comes back as a new attachment. Its id goes straight onto a reply
        through <DocLink to="/docs/email">Email</DocLink>, or to a teammate with{" "}
        <Code>send_chat_attachment</Code>. The original is never modified.
      </P>
      <P>
        A form that needs a signature rather than answers belongs in{" "}
        <DocLink to="/docs/signatures">Document signing</DocLink>, which collects real recipient
        evidence instead of drawing a name onto a page.
      </P>
    </>
  );
}
