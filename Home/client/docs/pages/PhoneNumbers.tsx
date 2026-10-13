import {
  Callout,
  Code,
  DocLink,
  ExtLink,
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

export function PhoneNumbers() {
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Phone numbers"
        lead={
          <>
            Give an AI Employee its own phone number. It texts, reads the texts that arrive —
            verification codes included — answers calls and places them, all through your own{" "}
            <Strong>Twilio</Strong> account.
          </>
        }
      />

      <H2 id="what-it-is">What this is</H2>
      <P>
        A <Strong>Phone number</Strong> is a Twilio number your company reserved and gave to one{" "}
        <DocLink to="/docs/employees">AI Employee</DocLink>. The number belongs to the company; the
        assignment is the employee&apos;s only access to it, so moving a number to another employee
        moves everything with it. The employee can:
      </P>
      <UL>
        <LI>
          <Strong>Receive texts</Strong>, and wait for a verification code while it signs up for
          something in its <DocLink to="/docs/browser">browser</DocLink>.
        </LI>
        <LI>
          <Strong>Send texts</Strong> to anyone its work calls for.
        </LI>
        <LI>
          <Strong>Answer calls</Strong> to its number and talk with the caller.
        </LI>
        <LI>
          <Strong>Place calls</Strong> — book the table, chase the supplier, confirm the appointment
          — and read the transcript afterwards.
        </LI>
      </UL>
      <P>
        Numbers, texts and minutes are billed to your Twilio account. Genosyn adds nothing on top.
      </P>

      <H2 id="setup">Set it up</H2>
      <OL>
        <LI>
          In Twilio Console, copy your <Strong>Account SID</Strong> and <Strong>Auth Token</Strong>{" "}
          from <Strong>Account info</Strong>.
        </LI>
        <LI>
          In Genosyn open <Strong>Settings → Integrations</Strong>, choose <Strong>Twilio</Strong>,
          and paste both. Genosyn checks them with Twilio before saving.
        </LI>
        <LI>
          Open <Strong>Settings → Phone numbers</Strong> and click <Strong>Get a number</Strong>.
          Either <Strong>Find a new number</Strong> — pick a country, a type and optionally an area
          code, then <Strong>Reserve number</Strong> — or <Strong>Use a number you own</Strong> to
          bring in one already on the Twilio account. Choose who to give it to in the same step.
        </LI>
        <LI>
          On the number&apos;s page, write its <Strong>Instructions for callers and texters</Strong>{" "}
          and pick what happens when someone calls or texts.
        </LI>
      </OL>
      <P>
        You can also start from the employee: <Strong>AI Employee → Settings → Phone</Strong> shows
        its numbers and their texts and calls, and <Strong>Get a number</Strong> there gives the new
        number straight to that employee.
      </P>

      <H3 id="public-url">Texts work anywhere; calls need a public URL</H3>
      <P>
        Twilio tells Genosyn about each text and call by sending a webhook. With a public HTTPS
        address set at <Strong>Admin → General → Public URL</Strong>, Genosyn points every
        number&apos;s webhooks at itself automatically, and keeps them pointed there when the
        address changes.
      </P>
      <P>
        Without one — Genosyn on a laptop, say — texts still arrive: Genosyn fetches them from
        Twilio every minute, and every few seconds while an employee is waiting for a code. Calls
        cannot work that way, because Twilio has to reach the call in real time, so answering and
        placing calls needs the public URL.
      </P>

      <H2 id="calls">What happens on a call</H2>
      <KeyList
        rows={[
          {
            term: "The AI Employee answers",
            def: "It greets the caller (your greeting, or a short one that says it is an AI assistant), listens, and replies — Twilio turns speech into text and the employee's words back into speech, so any AI Model can take a call.",
          },
          {
            term: "Forward to a person",
            def: "The call rings another phone instead.",
          },
          {
            term: "Decline",
            def: "Callers hear a busy tone.",
          },
        ]}
      />
      <P>
        To place a call, the employee writes a <Strong>brief</Strong> — who it is calling, why, the
        facts it needs, and what it may agree to — and an opening line. The call is conducted from
        that brief alone. It listens for &ldquo;hello&rdquo; before speaking, can press keys to work
        through a phone menu, leaves a short voicemail when nobody answers, and hangs up when the
        conversation is done. The full transcript is on the call afterwards. No audio is recorded.
      </P>
      <P>
        To try a number yourself, open its page and click <Strong>Test call</Strong>: the employee
        rings the number you enter, guided by a short test brief.
      </P>

      <H2 id="texts">What happens to a text</H2>
      <KeyList
        rows={[
          {
            term: "Keep it for the AI Employee",
            def: "The default. The text is kept and nothing is sent back — what a verification code needs.",
          },
          {
            term: "The AI Employee replies",
            def: "It answers each text, following the number's instructions. It never replies to short codes or named senders, to STOP, HELP or other keywords, or more than ten times an hour to one person.",
          },
        ]}
      />

      <H2 id="strangers">Callers and texters are strangers</H2>
      <P>
        Anyone can call or text a number, and caller ID is trivially faked, so Genosyn never treats
        a caller as one of your Members. On a call or an automatic reply the employee works from the
        number&apos;s instructions — plus, on a call it placed, its own brief — and nothing else: no
        Soul, no Memory, no Skills, no company records and no tools. Write in the instructions
        exactly what it may tell the public, the way{" "}
        <DocLink to="/docs/chat-surfaces">external chat surfaces</DocLink> handle an unlinked
        sender. Whatever a caller asks for beyond that, the employee takes a message, and the
        transcript is there for the follow-up.
      </P>

      <H2 id="tools">The AI Employee&apos;s phone tools</H2>
      <P>
        An employee with a number is told so in its prompt, and finds these tools with{" "}
        <DocLink to="/docs/tool-discovery">find_tools</DocLink>:
      </P>
      <KeyList
        rows={[
          {
            term: "list_phone_numbers",
            def: "Its numbers, what each can do, and how much of today's limits are left.",
          },
          { term: "send_text_message", def: "Text someone from its number." },
          {
            term: "list_text_messages",
            def: "Its texts, newest first, with the likely codes in each incoming one.",
          },
          {
            term: "wait_for_text_message",
            def: "Wait up to four minutes for a text — the way to receive a verification code after asking a site to send one.",
          },
          {
            term: "place_phone_call",
            def: "Call someone, from a brief and an opening line. Returns at once.",
          },
          {
            term: "get_phone_call",
            def: "A call's status and transcript, optionally waiting for it to end.",
          },
          { term: "list_phone_calls", def: "Recent calls on its numbers." },
        ]}
      />
      <P>
        An employee only reads the texts and calls from while a number was its own, or while it had
        nobody — a number that moves between employees does not carry one employee&apos;s
        verification codes to the next.
      </P>

      <H2 id="guardrails">Guardrails</H2>
      <UL>
        <LI>
          <Strong>Daily limits.</Strong> Each number has a limit on AI-sent texts (50 by default)
          and AI-placed calls (10). Texts you send and test calls you place from the app do not
          count.
        </LI>
        <LI>
          <Strong>Standdowns.</Strong> A <DocLink to="/docs/standdowns">Standdown</DocLink> on the
          company or the employee stops every text it would send and every call it would place or
          answer.
        </LI>
        <LI>
          <Strong>Held like email.</Strong> Texting and calling are treated like sending an email: a
          turn that has read web content has the text or call held for approval, and a Routine
          limited to email review cannot text or call instead.
        </LI>
        <LI>
          <Strong>Owners and admins only.</Strong> Phone numbers, texts and calls are visible only
          to owners and admins — texts carry the codes for the accounts an employee signs into. A
          Member chatting with an employee cannot have it text or call.
        </LI>
        <LI>
          <Strong>Calls end on their own</Strong> after about twenty minutes, or after two silences
          in a row.
        </LI>
      </UL>
      <P>
        Every number reserved, released or changed, every text sent and every call placed or
        received is in the <Strong>Audit log</Strong>, and a Run&apos;s texts and calls appear in
        its <DocLink to="/docs/verification">Effects</DocLink>. To react to new texts and calls,
        give a Routine a <DocLink to="/docs/routines">Trigger</DocLink> on <Code>phone</Code>.
      </P>

      <H2 id="remove">Removing a number</H2>
      <P>
        <Strong>Remove</Strong> on a number&apos;s page takes it out of Genosyn along with its texts
        and call history. Tick <Strong>Also release it from Twilio</Strong> to give the number back
        so it stops billing — it cannot be got back afterwards. Left unticked, the number stays on
        your Twilio account and simply stops sending its texts and calls to Genosyn. A Twilio
        Connection that still has numbers cannot be deleted, and deleting a company does not release
        its numbers, so remove them first.
      </P>

      <Callout kind="warn" title="Compliance is yours">
        Texting and calling people is regulated. In the US, texts from 10-digit numbers need an
        approved A2P 10DLC registration and toll-free numbers need verification, or carriers filter
        them; calls to consumers made with an AI voice can need their prior consent. Trial Twilio
        accounts can only text and call numbers you have verified. See{" "}
        <ExtLink href="https://www.twilio.com/docs/messaging/compliance">
          Twilio&apos;s messaging compliance guide
        </ExtLink>
        .
      </Callout>
    </>
  );
}
