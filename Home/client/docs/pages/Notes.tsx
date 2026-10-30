import { Callout, Code, DocLink, H2, H3, KeyList, LI, P, PageHeader, Strong, UL } from "@/docs/Prose";

export function Notes() {
  return (
    <>
      <PageHeader
        eyebrow="Core concepts"
        title="Notes"
        lead={
          <>
            Notes are pages your team and your AI Employees write together — runbooks, briefs, plans,
            meeting notes. They work like Notion: click anywhere and type, press <Code>/</Code> for
            any kind of block, and everything saves as you go.
          </>
        }
      />

      <H2 id="what">Notebooks and pages</H2>
      <P>
        Open <Strong>Notes</Strong> in the sidebar. Pages live in <Strong>notebooks</Strong> — a
        handbook, product briefs, post-mortems — and a page can hold pages of its own, nested as
        deep as you like. The Notes sidebar shows every notebook with its page tree, the pages
        edited most recently, and a search box. Every company starts with a notebook called{" "}
        <Strong>General</Strong>.
      </P>
      <P>
        A note is different from a <DocLink to="/docs/resources">Resource</DocLink> (someone
        else&apos;s words, ingested for study) and from an AI Employee&apos;s Memory (short facts
        injected into every prompt): it is a document you write and keep up to date.
      </P>

      <H2 id="write">Write a page</H2>
      <UL>
        <LI>
          <Strong>New page</Strong> — the pencil button at the top of the Notes sidebar makes a page
          in the notebook you&apos;re in; the <Code>+</Code> beside a notebook or page makes one
          inside it. A new page opens with the caret in its title.
        </LI>
        <LI>
          <Strong>Title and icon</Strong> — click the title and type. Press <Code>Enter</Code> to
          start the page. Hover above the title for <Strong>Add icon</Strong>.
        </LI>
        <LI>
          <Strong>No Save button.</Strong> The top of the page says <Strong>Saving…</Strong> and
          then <Strong>Saved</Strong>. Leaving the page, closing the tab or losing the connection
          never loses what you typed: unsaved edits are kept in your browser and saved the next time
          the page opens. <Code>⌘S</Code> / <Code>Ctrl+S</Code> saves at once.
        </LI>
        <LI>
          <Strong>Edits from AI Employees arrive live.</Strong> If one changes the page while you
          are on it, its changes appear in place and are merged with yours line by line. Where you
          both changed the same line, your version is kept and the page tells you.
        </LI>
      </UL>

      <H2 id="blocks">Blocks</H2>
      <P>
        Every paragraph, heading, list item or image is a block. Type <Code>/</Code> to open the
        block menu, keep typing to filter it (<Code>/h2</Code>, <Code>/todo</Code>,{" "}
        <Code>/call</Code>), and press <Code>Enter</Code>. The <Code>+</Code> that appears beside
        a block when you hover adds one below it.
      </P>
      <KeyList
        rows={[
          { term: "Text, Headings 1–3", def: "Plain paragraphs and section headings." },
          { term: "Bulleted, numbered, to-do lists", def: "Click a to-do's box to check it off." },
          {
            term: "Toggle list",
            def: "A line that hides what's under it. Click the arrow to open it; press Enter at the end of an open toggle to write inside it.",
          },
          { term: "Quote, Callout", def: "Click a callout's icon to change it: Note, Tip, Important, Warning or Caution." },
          { term: "Code", def: "Pick the language at its top left; Tab indents, Mod+Enter leaves the block." },
          { term: "Divider, Table, Image", def: "An image is embedded from a link. A table shows as a table; Edit table changes its Markdown." },
          { term: "Page", def: "Makes a page inside this one and opens it." },
        ]}
      />

      <H3 id="markdown">Markdown as you type</H3>
      <P>Type these at the start of an empty line and the block changes as you press space:</P>
      <KeyList
        rows={[
          { term: "# · ## · ###", def: "Heading 1, 2 or 3" },
          { term: "- or *", def: "Bulleted list" },
          { term: "1.", def: "Numbered list" },
          { term: "[] or [x]", def: "To-do, unchecked or checked" },
          { term: '> or "', def: "Quote" },
          { term: "```", def: "Code block (```ts for a language)" },
          { term: "---", def: "Divider" },
        ]}
      />
      <P>
        Inline, <Code>**bold**</Code>, <Code>*italic*</Code>, <Code>~~strikethrough~~</Code> and{" "}
        <Code>`code`</Code> format as soon as you type the closing mark, and a pasted or typed web
        address becomes a link.
      </P>

      <H3 id="formatting">Formatting and links</H3>
      <P>
        Select text for the formatting bar: change the block&apos;s type, or make the selection
        bold, italic, struck through, inline code or a link. The keyboard works too —{" "}
        <Code>⌘B</Code>, <Code>⌘I</Code>, <Code>⌘⇧S</Code>, <Code>⌘E</Code> and <Code>⌘K</Code>{" "}
        (<Code>Ctrl</Code> on Windows and Linux). Pasting a link over selected text links it.{" "}
        <Code>⌘</Code>-click a link to open it.
      </P>

      <H3 id="keys">Moving around</H3>
      <UL>
        <LI>
          <Code>Enter</Code> splits a block and continues a list; on an empty list item it steps out
          of the list. <Code>Shift+Enter</Code> adds a line inside the block.
        </LI>
        <LI>
          <Code>Backspace</Code> at the start of a block turns it back into text, then steps it out
          of its parent, then joins it to the block above.
        </LI>
        <LI>
          <Code>Tab</Code> and <Code>Shift+Tab</Code> nest a block under the list item or toggle
          above it, and back out. The arrow keys move between blocks.
        </LI>
        <LI>
          <Code>⌘Z</Code> undoes and <Code>⌘⇧Z</Code> redoes — splits, merges and moves included.
        </LI>
      </UL>

      <H3 id="select">Selecting and moving blocks</H3>
      <P>
        Drag the <Strong>⋮⋮</Strong> handle beside a block to move it (with anything nested under
        it). Click the handle for its menu: <Strong>Turn into</Strong>,{" "}
        <Strong>Duplicate</Strong>, <Strong>Move up/down</Strong>, <Strong>Copy as Markdown</Strong>{" "}
        and <Strong>Delete</Strong>. Press <Code>Esc</Code>, or drag across several blocks, to
        select whole blocks; then <Code>Backspace</Code> deletes them, <Code>⌘C</Code> copies them,{" "}
        <Code>⌘D</Code> duplicates them, <Code>Tab</Code> nests them and <Code>⌘⇧↑</Code>/
        <Code>↓</Code> moves them.
      </P>

      <H3 id="paste">Pasting</H3>
      <P>
        Paste from a web page, Google Docs or another note and it keeps its headings, lists,
        to-dos, quotes, code, tables and links. Pasted Markdown is read as Markdown; plain lines
        become one paragraph each. Copying blocks out of a note gives Markdown to anything that
        takes text.
      </P>

      <H2 id="organize">Organise pages</H2>
      <UL>
        <LI>
          <Strong>Drag a page</Strong> in the sidebar onto another to put it inside, or above or
          below it to reorder. Drop it on a notebook to move it to that notebook&apos;s top level.
          Pages inside it always come along.
        </LI>
        <LI>
          A page&apos;s <Strong>⋯</Strong> menu (in the sidebar, or at the top of the page) adds a
          page inside it, duplicates it, <Strong>Move to…</Strong> another notebook or page, copies
          its link, or moves it to the trash.
        </LI>
        <LI>
          <Strong>Search pages</Strong> in the sidebar finds titles as you type and page text a
          moment later; <Code>↑</Code>/<Code>↓</Code> and <Code>Enter</Code> open one. The Notes
          home page searches every page and shows what matched.
        </LI>
        <LI>
          A notebook&apos;s own page lists its pages in order; click its name or icon to change
          them.
        </LI>
      </UL>

      <H2 id="trash">Trash</H2>
      <P>
        <Strong>Move to trash</Strong> takes the page and every page inside it. Open{" "}
        <Strong>Trash</Strong> at the bottom of the Notes sidebar to restore a page — the pages
        trashed with it come back too — or delete it forever. A trashed page can still be opened
        and read, but not edited, until it is restored.
      </P>

      <H2 id="ai">AI Employees and notes</H2>
      <P>
        Members can always read and edit every note. An AI Employee sees only what it is shared:
        use <Strong>Share</Strong> on a page (it covers every page inside it too) or on a notebook
        (every page in it, including ones added later), and choose <Strong>Can edit</Strong> or{" "}
        <Strong>View only</Strong>. See <DocLink to="/docs/employees">AI Employees</DocLink> for
        how Grants work.
      </P>
      <P>
        With access, an employee uses its note tools — <Code>list_notes</Code>,{" "}
        <Code>search_notes</Code>, <Code>get_note</Code>, <Code>create_note</Code>,{" "}
        <Code>update_note</Code> — and reads and writes the same Markdown you edit. Callouts are
        written as GitHub alerts (<Code>{"> [!NOTE]"}</Code>), toggles as{" "}
        <Code>{"<details><summary>…</summary>"}</Code>, to-dos as <Code>- [ ]</Code>, so what an
        employee writes shows up as proper blocks. Moving a page under another needs edit access
        to both, and trashing a page through a tool takes its sub-pages along, the same as in the
        app.
      </P>
      <P>
        Listing and searching reach every page the employee may read, however large the knowledge
        base grows: <Code>list_notes</Code> and <Code>search_notes</Code> answer a page at a time
        with how many match in all, and each row shows the start of its page — a search also shows
        the words around what it found — so the employee opens only the pages it needs with{" "}
        <Code>get_note</Code>. Pages it has no access to never appear and never count.
      </P>

      <Callout kind="tip" title="Editing never rewrites what you didn't touch.">
        Notes are stored as Markdown. When you edit one block of a page an AI Employee wrote, only
        that block is written back; every other line — tables, HTML, unusual list markers, even
        trailing spaces — stays exactly as it was. Markdown the editor doesn&apos;t turn into a
        block (raw HTML, footnotes, a heading underlined with <Code>===</Code>) shows as a{" "}
        <Strong>Markdown</Strong> block you can still edit as text.
      </Callout>
    </>
  );
}
