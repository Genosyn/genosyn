import {
  Callout,
  Code,
  DocLink,
  H2,
  KeyList,
  LI,
  OL,
  P,
  PageHeader,
  Strong,
  UL,
} from "@/docs/Prose";

export function DataRooms() {
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Data rooms"
        lead={
          <>
            Share documents with investors, a buyer, auditors or a partner — each guest through a
            private link — and see what every one of them reads. The room&apos;s AI Employee briefs
            each document, checks the room against what its purpose usually needs, and answers
            guests&apos; questions from the documents themselves, quoting them.
          </>
        }
      />

      <H2 id="open">Open a data room</H2>
      <OL>
        <LI>
          Open <Strong>Data rooms</Strong> and choose <Strong>New data room</Strong>. Name it and
          pick what it is for: <Strong>Fundraising</Strong>, <Strong>Sale or acquisition</Strong>,{" "}
          <Strong>Audit</Strong>, <Strong>Partnership or security review</Strong>, or{" "}
          <Strong>Something else</Strong>. The room starts with the folders such a room usually has
          — a fundraising room opens with Company overview, Financials, Legal and corporate, Team,
          Product and market, and Customers and contracts. Rename, reorder or remove them freely.
        </LI>
        <LI>
          Choose the <Strong>AI Employee</Strong> who works the room. It briefs documents, reviews
          readiness and drafts answers; you can change it, or choose none, in the room&apos;s{" "}
          <Strong>Settings</Strong>.
        </LI>
        <LI>
          Add documents, run a readiness review, and invite guests when the room is ready. Nobody
          outside the company sees anything until you invite them.
        </LI>
      </OL>
      <Callout kind="info" title="Only owners and admins see data rooms">
        A room holds the company&apos;s most sensitive documents, and often news the rest of the
        company has not heard yet — a raise, a sale. So the section, its pages and its API are for
        owners and admins only, reads included. A Member cannot reach a room through an AI Employee
        either: the data room tools are owner-and-admin tools in a Member&apos;s chat.
      </Callout>

      <H2 id="documents">Documents and their briefs</H2>
      <P>
        On the <Strong>Documents</Strong> tab, choose <Strong>Upload</Strong>, drop files on the
        page, or drop them on a folder to file them there. Rooms take PDF, Word, Excel, PowerPoint,
        text, CSV, Markdown and image files up to 50 MB each. <Strong>From Resources</Strong> copies
        a Resource in: an uploaded file as it is, a pasted or fetched one as a Markdown document.
        The room keeps its own copy, so changing the Resource later changes nothing guests see.
      </P>
      <P>
        Every folder is numbered and every document in it too, so a guest can say &ldquo;see
        3.2&rdquo;. Genosyn reads the text out of each file as it arrives — PDF text, Word documents,
        slide text from decks, spreadsheet cells — and the room&apos;s AI Employee writes a brief:
      </P>
      <UL>
        <LI>a short summary and up to six key facts, copied from the document;</LI>
        <LI>
          <Strong>things to check before sharing</Strong> — personal data about identifiable people,
          bank details, passwords, draft markings or comments, another company&apos;s confidential
          information, figures that contradict each other, a date that makes it look out of date;
        </LI>
        <LI>
          the folder it belongs in. A document dropped outside any folder is filed there
          automatically, but only into a folder that exists; when it suggests another one, the
          document shows a one-click <Strong>move it</Strong>.
        </LI>
      </UL>
      <P>
        Scanned PDFs and images have no text to read, so they get no brief and answers cannot quote
        them; upload a text version beside them. Open a document to preview it beside its brief.
      </P>
      <P>
        The AI Employee thinks with its connected AI Model. Until it has one, the room says so at
        the top of every tab, with a link to connect one, and briefs, reviews and drafted answers
        wait; guests can still read and ask, and you answer them yourself. Once a model is
        connected, the <Strong>Documents</Strong> tab offers to brief, in one go, every document
        still without a brief.
      </P>

      <H2 id="readiness">Readiness review</H2>
      <P>
        <Strong>Review readiness</Strong> on the <Strong>Overview</Strong> tab checks the room
        against what a room of its purpose is usually expected to hold — for fundraising: pitch
        deck, financial statements, financial model, cap table, key metrics, incorporation
        documents, board records, earlier financings, material contracts, intellectual property,
        and the team and equity plan. The checklist is Genosyn&apos;s, not the model&apos;s: the AI
        Employee only says, from each document&apos;s title, folder and brief, whether an item is
        covered, partly covered or missing, and which documents cover it.
      </P>
      <P>
        The score is arithmetic over those answers: covered counts fully, partly covered half, and
        essential items twice what the rest do. An item the review skipped counts as missing, and
        &ldquo;covered&rdquo; with no document behind it is not covered. The review also writes a
        short summary and the next steps. When documents change, the card says so; review again.
      </P>

      <H2 id="guests">Invite guests</H2>
      <P>
        Choose <Strong>Invite a guest</Strong> at the top of the room. Give their name, email and
        firm, which folders they can open — every folder, including any added later, or only the
        ones you tick — and, if you like, the day their access ends. Genosyn emails them a private
        link; turn the email off to copy the link and share it yourself. The{" "}
        <Strong>Guests</Strong> tab lists everyone invited, with what they can open and when they
        last visited.
      </P>
      <KeyList
        rows={[
          {
            term: "Copy private link",
            def: "Copies the guest's current link again. Anyone holding it opens the room as that guest.",
          },
          {
            term: "Give a new link",
            def: "Replaces the link: the old one stops working at once, and the new one is emailed.",
          },
          {
            term: "Change access",
            def: "Narrows or widens their folders, or changes when their access ends.",
          },
          {
            term: "Revoke access",
            def: "Their link stops opening the room at once. Restore it later if you need to.",
          },
        ]}
      />
      <P>
        In the room&apos;s <Strong>Settings</Strong>, choose how guests may use what they open:
      </P>
      <UL>
        <LI>
          <Strong>Allow downloads</Strong> — off by default. Without it guests read in the room and
          get no download button. Anything shown on a screen can still be photographed.
        </LI>
        <LI>
          <Strong>Watermark PDFs</Strong> — on by default. Every PDF page a guest opens or downloads
          carries their email and the date. The stored original is never changed. It is a
          deterrent, not a lock.
        </LI>
        <LI>
          <Strong>Guests accept terms first</Strong> — an NDA or confidentiality terms each guest
          accepts, typing their name, before they see anything. The time, name and address are
          recorded, and changed terms must be accepted again.
        </LI>
      </UL>
      <P>
        <Strong>Close the room</Strong> turns every link away at once and keeps the whole record;
        reopen it any time. Deleting a room deletes its documents, guests, questions and activity
        for good.
      </P>
      <Callout kind="info" title="Set the public URL and an email provider first">
        Guest links use the installation URL from <Strong>Admin → General</Strong>, and invitations
        go out through the company&apos;s provider under{" "}
        <Strong>Settings → Notification email</Strong>. Without a provider nothing is sent, and the
        link is shown for you to share. See <DocLink to="/docs/self-hosting">Configuration</DocLink>.
      </Callout>

      <H2 id="guest-view">What a guest sees</H2>
      <P>
        Their link opens the room with no account and no password: the company&apos;s name, your
        welcome message, and the numbered index of the folders they were given. Documents open in
        the page — PDFs as rendered pages, images, and the text of everything else — and guests ask
        questions beside them. Each guest sees only their own questions and answers.
      </P>

      <H2 id="questions">Questions and AI answers</H2>
      <P>
        A guest&apos;s question arrives on the <Strong>Questions</Strong> tab, and the Member who
        made the room is notified. What the room&apos;s AI Employee does next is the room&apos;s{" "}
        <Strong>Guests&apos; questions</Strong> setting:
      </P>
      <KeyList
        rows={[
          { term: "Off", def: "A Member answers every question." },
          {
            term: "Draft answers for review",
            def: "The default. The AI Employee drafts an answer with quotes from the room; a Member publishes it, edits it first, or asks for a new draft.",
          },
          {
            term: "Answer when the documents do",
            def: "The AI Employee answers the guest on its own when the guest's documents answer the question and every quote checks out. Anything else waits as a draft.",
          },
        ]}
      />
      <P>Three rules keep an answer honest:</P>
      <UL>
        <LI>
          <Strong>It reads only what the guest can open.</Strong> The answer is written from the
          documents in that guest&apos;s folders and nothing else, so a question cannot talk its way
          into a folder the guest was not given — the words are not there to leak.
        </LI>
        <LI>
          <Strong>Every quote is checked.</Strong> Each fact cites a passage copied word for word;
          Genosyn keeps only quotes it finds in the document, and an answer that lost one waits for
          a Member. The guest can open the cited passage from the answer.
        </LI>
        <LI>
          <Strong>A question is a stranger&apos;s words.</Strong> The AI Employee treats it as data,
          never as instructions. One that tries to instruct it is flagged{" "}
          <Strong>Tried to instruct the AI</Strong> and never answered on its own.
        </LI>
      </UL>
      <P>
        When an answer is published — by a Member or by the room — the guest gets an email that it
        is there.
      </P>

      <H2 id="activity">Activity</H2>
      <P>
        The <Strong>Activity</Strong> tab counts what guests did: visits (a new visit starts after
        half an hour away), time reading (counted only while a document is open on their screen),
        documents opened and downloaded, and questions asked — per guest, per document, and as a
        feed. A guest&apos;s first visit sends the room&apos;s creator a notification. On the
        Overview, <Strong>Read the activity</Strong> has the AI Employee say who is most engaged and
        what to follow up; the figures are counted by Genosyn and never by the model.
      </P>

      <H2 id="ai-employees">AI Employees and data rooms</H2>
      <P>
        The AI Employee a room names needs nothing more: each brief, draft, review and reading is a
        single restricted turn the server starts, with one tool to submit its result and no access
        to anything outside the room. For an AI Employee to work with rooms through its own tools —
        in chat or in a Routine — give it access under <Strong>Data rooms → AI access</Strong>:
      </P>
      <KeyList
        rows={[
          {
            term: "Read",
            def: (
              <>
                Read rooms, their documents and activity, and guests&apos; questions (
                <Code>list_data_rooms</Code>, <Code>get_data_room</Code>,{" "}
                <Code>read_data_room_document</Code>, <Code>get_data_room_activity</Code>,{" "}
                <Code>list_data_room_questions</Code>).
              </>
            ),
          },
          {
            term: "Prepare",
            def: (
              <>
                Also create rooms, file documents from a Resource or a file it holds — an email
                attachment, a converted PDF — and draft answers for a Member (
                <Code>create_data_room</Code>, <Code>add_data_room_document</Code>,{" "}
                <Code>draft_data_room_answer</Code>). Nobody outside the company is contacted.
              </>
            ),
          },
          {
            term: "Share",
            def: (
              <>
                Also invite guests and publish answers (<Code>invite_data_room_guest</Code>,{" "}
                <Code>answer_data_room_question</Code>). Both reach people outside the company. A
                guest&apos;s link is emailed to them and never shown to the AI Employee.
              </>
            ),
          },
        ]}
      />
      <P>
        Reading guests&apos; questions marks an AI Employee&apos;s turn as having read outside
        content, so an invitation or a published answer in the same turn is held as an Approval for
        a person. A Routine can start when a guest asks: give it a Trigger on{" "}
        <Code>data_room_question</Code> (or <Code>data_room_activity</Code> for visits) — see{" "}
        <DocLink to="/docs/reactivity">Reactivity</DocLink>.
      </P>
      <P>
        Every change Members and AI Employees make to a room is in its History, at the foot of the
        room&apos;s <Strong>Settings</Strong>; invitation emails also appear under{" "}
        <Code>Settings → Notification email → Logs</Code>.
      </P>
    </>
  );
}
