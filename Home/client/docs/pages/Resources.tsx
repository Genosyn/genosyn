import { Callout, Code, DocLink, H2, KeyList, LI, P, PageHeader, Strong, UL } from "@/docs/Prose";

export function Resources() {
  return (
    <>
      <PageHeader
        eyebrow="Core concepts"
        title="Resources"
        lead={
          <>
            Resources are the material your company did not write — articles, PDFs, ebooks,
            transcripts, a page you pasted the URL of. You ingest it once; your AI Employees search
            it and quote from it instead of guessing.
          </>
        }
      />

      <H2 id="what">What counts as a Resource</H2>
      <P>
        Genosyn keeps three different kinds of knowledge apart on purpose, and picking the right one
        is most of getting good answers out of an AI Employee.
      </P>
      <KeyList
        rows={[
          {
            term: "Resource",
            def: "Someone else's words, ingested for study. A vendor's API guide, a competitor's pricing page, the ebook your founder keeps recommending. Read on demand, never automatically injected.",
          },
          {
            term: "Note",
            def: (
              <>
                A page your team authors together, in markdown. See{" "}
                <DocLink to="/docs/workspace-chat">workspace chat</DocLink> for how they get
                referenced in conversation.
              </>
            ),
          },
          {
            term: "Memory",
            def: "A short durable fact about how your company works, injected into every prompt. Facts, not documents.",
          },
        ]}
      />

      <H2 id="add">Add one</H2>
      <P>
        Go to <Strong>Resources</Strong> in the sidebar under Knowledge. Three tiles:
      </P>
      <UL>
        <LI>
          <Strong>Paste a URL</Strong> — Genosyn fetches the page and extracts its readable text.
          The text is a snapshot taken at that moment; it does not re-fetch later.
        </LI>
        <LI>
          <Strong>Paste text</Strong> — a transcript, an email thread, anything you can copy. This
          one stays editable afterwards as a markdown document.
        </LI>
        <LI>
          <Strong>Upload a file</Strong> — PDF, EPUB, Word, plain text, Markdown or HTML, up to
          25&nbsp;MB. Video files are stored and playable but not transcribed yet.
        </LI>
      </UL>
      <P>
        Whatever you add, the original is kept and the extracted text is what gets searched. A
        Resource can carry any number of <DocLink to="/docs/tags">tags</DocLink>.
      </P>

      <Callout kind="info" title="If nothing could be extracted, the Resource says so.">
        A scanned PDF has no text layer, and a page built entirely in JavaScript returns no prose.
        Both used to be filed as ready with an empty body — stored, listed, and permanently
        invisible to search. They are now marked <Strong>Failed</Strong> with the reason and the
        fix: run the scan through OCR, or save the page as a PDF. The file itself is still stored,
        still viewable, and a PDF can still be sent for{" "}
        <DocLink to="/docs/signatures">signature</DocLink>. The same guard refuses to index a
        spreadsheet or an image as if it were prose.
      </Callout>

      <H2 id="ai">How an AI Employee uses one</H2>
      <P>
        Resources are read through tools, on demand — they never sit in an employee&apos;s prompt.
        There are three read tools and they are designed to be used in order.
      </P>
      <KeyList
        rows={[
          {
            term: "search_resources",
            def: "Finds the passage. Every word of the query has to appear somewhere, in any order — “refund policy” matches a handbook that says “our policy for refunds”. Each hit comes back with a snippet of the matching text and the exact character offset it came from.",
          },
          {
            term: "get_resource",
            def: "Reads from that offset. A window at a time, with the offset to resume from, so an employee can work through a 300-page book instead of receiving the first chapter and a note saying the rest was discarded.",
          },
          {
            term: "list_resources",
            def: "Browses the shelf — titles, summaries and tags, newest first, paginated. For when the employee wants to know what exists rather than answer a question.",
          },
        ]}
      />
      <P>
        Employees can also curate: <Code>create_resource</Code> files a URL, a paste, or a file it
        already holds — an emailed contract, a form it downloaded. <Code>update_resource</Code> and{" "}
        <Code>delete_resource</Code> need a higher grant. <Code>export_resource</Code> renders the
        body as PDF, HTML, Markdown or plain text and attaches it to the reply.
      </P>

      <H2 id="access">Who can read it</H2>
      <P>
        Every Member of the company sees every Resource. AI Employees are granted access one row at
        a time, at three escalating levels — <Strong>View only</Strong>, <Strong>Can edit</Strong>,
        and <Strong>Can delete</Strong>. Open a Resource and use <Strong>Share</Strong> to change
        them.
      </P>
      <P>
        You rarely have to. A new Resource is granted <Strong>View only</Strong> to every AI
        Employee in the company as it is created, and an employee hired later is granted the
        company&apos;s existing library as it is hired — so the order in which you fill the shelf
        and grow the team no longer decides who can read anything. An employee that files its own
        Resource gets full control of that row; teammates start at view-only.
      </P>

      <Callout kind="warn" title="An employee with no grants says so.">
        If an AI Employee genuinely has no access to any Resource, its search comes back with an
        explanation rather than an empty list — otherwise it cannot tell &quot;we have nothing on
        this&quot; from &quot;I was not given the shelf&quot;, and it will confidently tell you the
        first one.
      </Callout>

      <H2 id="reading">Reading and exporting</H2>
      <P>
        The detail page is type-aware: PDFs open in the browser&apos;s viewer, EPUBs in a reader
        with a table of contents and saved position, text Resources as an editable markdown
        document, and a URL Resource shows a card linking the original. Everything can be exported
        as PDF, HTML, Markdown or plain text from the Download menu.
      </P>
      <P>
        Originals you uploaded are served as downloads rather than rendered in the page, except for
        the three kinds Genosyn has a viewer for — PDF, EPUB and video. An uploaded HTML or SVG file
        is stored and downloadable but never rendered on the app&apos;s own origin.
      </P>

      <H2 id="limits">Limits</H2>
      <UL>
        <LI>25&nbsp;MB per uploaded file.</LI>
        <LI>
          1&nbsp;MiB of extracted text per Resource. A longer ebook is stored whole and its text
          truncated at that point.
        </LI>
        <LI>8&nbsp;MiB per export.</LI>
        <LI>
          Retrieval is lexical — it matches the words you use. Embeddings and vector search are not
          shipped yet.
        </LI>
      </UL>
    </>
  );
}
