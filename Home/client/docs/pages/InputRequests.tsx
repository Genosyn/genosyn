import { Callout, Code, DocLink, H2, KeyList, LI, OL, P, PageHeader, Strong, UL } from "@/docs/Prose";

export function InputRequests() {
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="When AI needs a person"
        lead={
          <>
            Sometimes work needs something only a person has: a sign-in code on your phone, a push
            to approve, a fact nobody wrote down. An AI Employee asks, the work stops without
            costing anything, and it carries on by itself when you answer, whether that&apos;s in a
            minute or on Monday.
          </>
        }
      />

      <H2 id="first-the-vault">First, it doesn&apos;t ask if it doesn&apos;t have to</H2>
      <P>
        A person is the last resort. For a sign-in code, an AI Employee looks in this order, and
        only the last one involves you:
      </P>
      <OL>
        <LI>
          <Strong>The Vault.</Strong> A login with its{" "}
          <DocLink to="/docs/vault#authenticator">authenticator saved</DocLink> gets its code with
          nobody asked. If you set up one thing from this page, set up this one: it&apos;s how a
          monthly VAT return files itself at 3am.
        </LI>
        <LI>
          <Strong>Its own phone number or inbox.</Strong> A code sent to an AI Employee&apos;s own{" "}
          <DocLink to="/docs/phone-numbers">Phone number</DocLink> or mailbox is its to read.
        </LI>
        <LI>
          <Strong>You.</Strong> It reaches the prompt in the browser and asks.
        </LI>
      </OL>

      <H2 id="answering">Answering</H2>
      <P>
        You get a bell, a push to your phone if you&apos;ve set one up, and a card at the top of the{" "}
        <DocLink to="/docs/decisions">Decision stack</DocLink>. The card also shows on the Run, the
        Todo, or the chat it came from. What you can do depends on whether a page is waiting right
        now:
      </P>
      <KeyList
        rows={[
          {
            term: "A page is waiting",
            def: "There's a box and a countdown of a few minutes. Type the code and press Send. It goes straight into the page and is submitted, and Genosyn doesn't show it to the AI Employee.",
          },
          {
            term: "Nobody got to it in time",
            def: "There's no box, on purpose: the page has timed out, so any code typed now would be dead. Press I'm ready when you have your phone to hand.",
          },
          {
            term: "You pressed I'm ready",
            def: "The work starts again, signs in from the start, and reaches the prompt, usually within a minute or two. Your box appears on the card as soon as the page asks, with a push to say so. Your code will be fresh, because the site only sends it now.",
          },
          {
            term: "Something to do, not type",
            def: "For a push to approve on your phone, or a captcha, you do it and press Done. Owners and admins can open the browser from the card to take over.",
          },
          {
            term: "A question in words",
            def: "Type your answer whenever you like. It doesn't go stale, so there's nothing to get ready for. The AI Employee reads this one, so don't put a password in it.",
          },
          {
            term: "You can't",
            def: "Press I can't, with a note if it helps. The work carries on without it and says plainly what stayed undone. It won't ask again in that Run.",
          },
        ]}
      />
      <P>
        Whoever the AI Employee was told to ask gets the card, then the owner of the browser if it
        runs on someone&apos;s computer, the Member the work is for, whoever saved the login, or
        whoever filed the Todo. With none of those, it goes to the company&apos;s owners and admins.
        Owners and admins can always answer. Nobody else can see it.
      </P>

      <H2 id="nobody-comes">If nobody comes</H2>
      <P>
        Nothing is lost, and nothing is spent. A <DocLink to="/docs/routines#runs">Run</DocLink>{" "}
        pauses as itself, keeping its transcript and progress. It holds no slot on its AI Model and
        uses no tokens, and it doesn&apos;t count as a failure. A{" "}
        <DocLink to="/docs/tasks#waiting">Todo</DocLink> waits. Meanwhile:
      </P>
      <UL>
        <LI>
          You get an email once the page has stopped waiting, then reminders an hour in, at 4 hours,
          at 12 hours, at a day, and once a day after that.
        </LI>
        <LI>From a day in, the company&apos;s owners and admins hear about it too.</LI>
        <LI>
          If you come back and leave again, the work goes back to waiting and the reminders start
          over. This can repeat as often as it takes, and each round needs someone to press the
          button, so it never burns tokens with nobody there.
        </LI>
        <LI>
          After a week it gives up. The work is told nobody came, finishes what it can without it,
          and reports what stayed undone.
        </LI>
      </UL>
      <Callout kind="info" title="A chat just asks">
        In a chat you&apos;re right there, so the card appears above the box you type in. If you
        miss the window, the employee says so. When you&apos;re ready, say so in the chat.
      </Callout>

      <H2 id="what-it-holds">What it can and can&apos;t do</H2>
      <UL>
        <LI>
          <Strong>Your code goes to one place.</Strong> The card shows the page&apos;s real address,
          read from the browser rather than written by the AI Employee. The code goes to that
          address and nowhere else. If the page has moved to another site by the time you answer,
          it isn&apos;t typed.
        </LI>
        <LI>
          <Strong>It isn&apos;t kept.</Strong> A code waits, encrypted, only until the session
          holding the page takes it, usually about a second. Genosyn never gives it to the AI Model
          or puts it in a transcript, an audit entry, a notification or a log. Like any browser
          work, snapshots and recordings show whatever the page shows, so a site that leaves a code
          in its box after refusing it can show that used code there.
        </LI>
        <LI>
          <Strong>Check before you type.</Strong> If the session has read something from outside your
          company, the card says so: only give a code if you expected to sign in to that site. Email
          never asks you for a code, so don&apos;t reply to one with a code.
        </LI>
        <LI>
          <Strong>Answering grants nothing.</Strong> The work carries on with what it could already
          do. Approvals, Grants and Policies apply as before, and a{" "}
          <DocLink to="/docs/standdowns">Standdown</DocLink> still holds everything: pressing
          I&apos;m ready doesn&apos;t start work a Standdown has stopped.
        </LI>
        <LI>
          <Strong>Wrong codes stop.</Strong> After 5 codes the page won&apos;t accept, it stops
          asking, because wrong codes lock accounts.
        </LI>
        <LI>
          <Strong>It takes a person.</Strong> Answering works only in a signed-in browser, never with
          an API key, and no AI Employee can answer one.
        </LI>
        <LI>
          <Strong>Approval-gated browsers.</Strong> If an employee&apos;s browser needs Approval to
          submit, only owners and admins can give it a code, since the code gets submitted.
        </LI>
      </UL>
      <P>
        A browser on a Member&apos;s own computer is different: a code goes in by your hand there,
        not through Genosyn. See <DocLink to="/docs/member-browsers">Member browsers</DocLink>.
      </P>

      <H2 id="decision-or-this">Decision, Approval, or this?</H2>
      <KeyList
        rows={[
          {
            term: "Decision",
            def: "A choice the company has to make, with options the employee wrote. Sign the contract? Which price?",
          },
          {
            term: "Approval",
            def: "The system stopping an action the employee already tried, until an owner or admin says yes.",
          },
          {
            term: "Input request",
            def: "Something the work physically can't get any other way. There's no judgement in it: you have the code, and it doesn't.",
          },
        ]}
      />

      <H2 id="for-ai">For AI Employees</H2>
      <P>
        <Code>browser_ask_person</Code> asks on the page that needs it, and holds the page for up to 4
        minutes. <Code>ask_person</Code> asks for a fact in words and stops straight away. An AI
        Employee can have 3 open at once and one at a time per piece of work. Your brief can name who
        to ask: &quot;If FreeAgent wants a code, ask valeria@acme.com.&quot; A company{" "}
        <DocLink to="/docs/policies">Policy</DocLink> can forbid either tool.
      </P>
    </>
  );
}
