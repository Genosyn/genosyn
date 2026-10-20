import { Callout, DocLink, H2, KeyList, LI, P, PageHeader, Strong, UL } from "@/docs/Prose";

export function BoardLetters() {
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Letters to the board"
        lead={
          <>
            Once a month an AI Employee you choose writes your company&apos;s letter to its board:
            progress toward the <DocLink to="/docs/goals">Goal</DocLink> first, then what happened,
            what went wrong, and where the money went. Genosyn reads every figure from the books
            itself, checks every number in the letter against those figures, and has an auditor
            you appoint read the letter before you do.
          </>
        }
      />

      <Callout kind="info" title='"Letter" is the word.'>
        A <DocLink to="/docs/tldrs">TLDR</DocLink> is the frequent recap everyone reads on Home. A
        letter comes once a month, is written for the board, and carries the company&apos;s money.
        Genosyn never calls it a report, a digest, or a newsletter.
      </Callout>

      <H2 id="set-up">Set it up</H2>
      <P>
        Open <Strong>What happened → Letters</Strong>. The card beside the list holds three
        settings:
      </P>
      <UL>
        <LI>
          <Strong>Every month</Strong> switches automatic letters on or off.
        </LI>
        <LI>
          <Strong>Written by</Strong> is the AI Employee who writes and signs the letter. It needs
          a connected <DocLink to="/docs/models">AI Model</DocLink>.
        </LI>
        <LI>
          <Strong>Audited by</Strong> is the AI Employee who reads each letter before the board
          does. It is never the writer, and it is optional. The card says who appointed it and
          when.
        </LI>
      </UL>
      <P>
        Save, and the card says when the next letter is due. If something stops the letters, for
        example a writer with no AI Model or a writer who is stood down, the card says that too.
      </P>

      <H2 id="schedule">When letters arrive</H2>
      <P>
        A letter is written at <Strong>06:00 on the first of each month</Strong>, for the month
        that just ended, on your company&apos;s clock (the time zone in company{" "}
        <Strong>Settings</Strong>). The first letter covers the first month that ends after you
        switch letters on. For the month that already ended, choose{" "}
        <Strong>Write {"{month}"}&apos;s letter</Strong> at the top of the page.
      </P>
      <UL>
        <LI>
          Each owner and admin gets a bell notification and an email carrying the whole letter: the
          figures, the prose, which numbers matched, and the audit. The letter also waits on their{" "}
          <DocLink to="/docs/board-letters#home">Home</DocLink> until they read it.
        </LI>
        <LI>
          If the writer fails, a scheduled letter is tried again an hour later, up to three
          attempts. A writer with no connected AI Model is not retried. Connect one, then choose{" "}
          <Strong>Try again</Strong> on the letter.
        </LI>
        <LI>
          While a <DocLink to="/docs/standdowns">Standdown</DocLink> covers the writer, the
          letter waits. It is written once the Standdown is lifted, not worked around.
        </LI>
      </UL>

      <H2 id="home">On Home</H2>
      <P>
        Until you read it, the newest letter sent to you waits on <Strong>Home</Strong>, above the
        latest TLDR. The card shows its number and month, its one-sentence summary, and the same
        badges as the list: what the audit found and whether every number matched a figure. Choose{" "}
        <Strong>Read the letter</Strong> to open it, or <Strong>All letters</Strong> for the list.
        When several are waiting, the card says how many more.
      </P>
      <P>
        A letter leaves your Home once you open it, from Home, the bell, the email, or the list.{" "}
        <Strong>Dismiss</Strong> takes it off without opening it, and so does marking its bell
        notification read. Either way it is yours alone: the other owners and admins keep it until
        they read it, and the letter itself stays under <Strong>What happened → Letters</Strong>.
      </P>
      <P>
        Home shows the letters that were sent to you. If you joined the board after a letter went
        out, you will find it in the list rather than on Home.
      </P>

      <H2 id="contents">What a letter says</H2>
      <P>
        The letter opens with <Strong>Toward the Goal</Strong>: each top-level Goal with its
        progress bar, and who last set its number. A number an AI Employee reported, which no
        person has confirmed, says so. Goal values are as they stood when the letter was written.
        The figures follow:
      </P>
      <KeyList
        rows={[
          {
            term: "Where the money went",
            def: (
              <>
                From the <DocLink to="/docs/finance#ledger">ledger</DocLink>, for the month&apos;s
                calendar dates: revenue, expenses, net income, cash at month end and its change,
                revenue against the month before and the same month a year earlier, and the five
                largest expense accounts. A company that keeps no books in Genosyn gets no money
                figures, and reading for the letter does not set Finance up.
              </>
            ),
          },
          {
            term: "The work",
            def: (
              <>
                Routine Runs finished, completed, failed, and stopped by an error. Also: Runs graded
                as achieving their aim, graded off goal, or that no outcome check could grade.
                Unverified is never counted as a pass. Plus failed Checks, Lessons, Standdowns
                placed, and the AI Employees on the roster. See{" "}
                <DocLink to="/docs/verification">What proves a Run worked</DocLink>.
              </>
            ),
          },
          {
            term: "What waited for people",
            def: (
              <>
                <DocLink to="/docs/decisions">Decisions</DocLink> raised, answered, and still
                waiting, and Approvals requested, granted, and declined.
              </>
            ),
          },
        ]}
      />
      <P>
        Every figure links to the page that shows the same number. A money figure opens{" "}
        <Strong>Finance → Reports</Strong> on the report and dates it was read from. Under the
        figures comes the letter itself, signed by its writer, and under that{" "}
        <Strong>What the writer was given</Strong>: the month&apos;s briefings, the work that
        failed and why, Lessons, Standdowns, and Decisions.
      </P>

      <H2 id="trace">Every number checked against the figures</H2>
      <P>
        Genosyn reads every number in the letter and matches it to one of its figures, as written
        or honestly rounded: &quot;$4.8M&quot; quotes $4,812,345, and &quot;41%&quot; quotes 41.4%.
        A rounding that drops most of the precision does not count. Hover a number to see the
        figure it quotes.
      </P>
      <P>
        A number that matches no figure is highlighted in amber and listed under the audit, and
        the letter&apos;s badge reads <Strong>1 number untraced</Strong>. Years near the
        letter&apos;s own, a day beside a month&apos;s name, the letter&apos;s own number, and
        numbers written in words are left alone. The writer is told to use digits only for
        figures.
      </P>
      <Callout kind="tip" title="Matching is not the same as being right.">
        The check proves each number is one of the letter&apos;s figures. Whether it is used for
        the right thing, and whether the letter leaves out something that matters, is the
        auditor&apos;s job.
      </Callout>

      <H2 id="auditor">The auditor</H2>
      <P>
        The auditor is an AI Employee that only owners and admins can appoint. It reads the letter
        against the same figures and evidence the writer had, and reports:
      </P>
      <UL>
        <LI>claims the figures or evidence do not support, or contradict;</LI>
        <LI>figures used for the wrong thing, or presented misleadingly;</LI>
        <LI>
          anything material left out: a Goal behind or missed, failed work, Runs nobody could
          grade, a Standdown, a loss, or Decisions still waiting;
        </LI>
        <LI>framing that hides bad news.</LI>
      </UL>
      <P>
        The badge reads <Strong>Audited · no exceptions</Strong> or{" "}
        <Strong>Audited · 2 exceptions</Strong>. Each finding quotes the letter&apos;s exact words
        and says what is wrong. The auditor cannot edit the letter, and the writer never sees what
        the auditor was asked.
      </P>
      <P>
        <Strong>Not audited</Strong> means no opinion was given. The auditor had no connected AI
        Model, was stood down, or its turn failed or ended without an answer. A letter that was
        not audited never reads as clean. <Strong>No auditor appointed</Strong> means none was set
        when the letter was written. For either, once an auditor is appointed, choose{" "}
        <Strong>Ask the auditor</Strong> on the letter. A letter that already has the
        auditor&apos;s opinion keeps it.
      </P>

      <H2 id="boundaries">What the writer can and cannot do</H2>
      <P>
        The writer works in a restricted turn with one tool, which submits the letter and does
        nothing else. It has no Integration, browser, coding, or Genosyn tools, and none of its
        Grants. The figures arrive already computed, and the evidence arrives as untrusted data,
        so an instruction hidden in a message or a failure reason is quoted at most, never obeyed.
      </P>
      <Callout kind="warn" title="There is no MCP tool for any of it — deliberately.">
        No AI Employee can write a letter outside that turn, change its figures, edit what the
        check or the auditor found, or appoint, replace, or instruct the auditor. An auditor the
        audited could appoint would not be an auditor. A letter is a record: nobody edits or
        deletes one.
      </Callout>

      <H2 id="access">Who reads the letters</H2>
      <P>
        The company&apos;s owners and admins: they set its Goals and place its Standdowns, so in
        Genosyn today they are its board. A letter carries the company&apos;s money figures. A
        Member never sees <Strong>Letters</Strong> in the menu or a letter on Home, and gets a note
        instead if they follow a link. That holds for an admin who is made a Member, too: the
        letters already sent to them leave their Home. Briefings and the Journal stay open to
        everyone.
      </P>
      <P>
        Every change to these settings, including who appointed or removed the auditor, is in{" "}
        <Strong>Settings → Audit log</Strong>. So is every letter someone asked for by hand.
      </P>
    </>
  );
}
