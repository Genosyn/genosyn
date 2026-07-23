import {
  Callout,
  Code,
  DocLink,
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

export function Deliverability() {
  return (
    <>
      <PageHeader
        eyebrow="Revenue"
        title="Deliverability"
        lead={
          <>
            Your sending domain is an asset you can destroy in an afternoon and spend months
            rebuilding. This page is the short list of what protects it in Genosyn — the suppression
            list, unsubscribe links, bounce handling and send caps — and what to do if you have
            already done the damage. Read it before you turn on{" "}
            <DocLink to="/docs/sequences#autosend">autoSend</DocLink>.
          </>
        }
      />

      <Callout kind="warn" title="The failure mode here is not recoverable by support.">
        Mail somebody who asked you to stop, mail dead addresses in volume, or ramp cold outbound
        from a domain with no sending history, and mailbox providers quietly start routing you to
        spam — including your invoices, your password resets, and your replies to customers. Nobody
        sends you a warning, and there is no button that undoes it. Every default described below is
        conservative on purpose. Do not raise one because a campaign feels slow.
      </Callout>

      <H2 id="suppression">The suppression list</H2>
      <P>
        A <Strong>Suppression</Strong> is an address this company must never email. The list lives at{" "}
        <Code>Revenue → Suppressions</Code>, searchable and filterable by reason.
      </P>
      <KeyList
        rows={[
          {
            term: "unsubscribe",
            def: <>They asked to stop. Only a human may remove it, and the UI warns first.</>,
          },
          {
            term: "bounce",
            def: (
              <>
                The address is dead. Mailing it again is what tells a provider you do not clean your
                list.
              </>
            ),
          },
          {
            term: "complaint",
            def: <>Somebody marked your mail as spam. The most expensive signal there is.</>,
          },
          { term: "manual", def: <>Somebody added it deliberately.</> },
          { term: "imported", def: <>Carried in from another system&apos;s opt-out list.</> },
        ]}
      />
      <P>
        All five block equally; the reason exists for the human reading the audit trail. The list is
        scoped to the <Strong>company</Strong>, not to a mailbox: a person who unsubscribed from one
        of your addresses has not consented to hear from another one, and the reputational damage of
        getting that wrong lands on the whole domain either way.
      </P>
      <P>
        Adding an address is idempotent — suppressing one that is already suppressed changes nothing
        and keeps the original reason, so a bounce report arriving twice is harmless. If you are
        moving from another outbound tool, <Strong>export its opt-out list and import it here before
        you send anything</Strong>. That is the single highest-value five minutes in this page.
      </P>
      <Callout kind="warn" title="Removing a suppression is a deliberate act, and it is audited.">
        The cheapest way to get a sending domain blocklisted is to mail somebody who already said no.
        Deletion asks for confirmation and records who removed it, when, and what reason the row
        carried — because &quot;who un-suppressed this address&quot; is the first question asked
        afterwards. Remove one only to correct a mistake you can name.
      </Callout>

      <H3 id="do-not-contact">Do not contact vs. suppression</H3>
      <P>
        They are different objects and both are checked on every send. A <Strong>Suppression</Strong>{" "}
        says <em>never mail this address</em>. <Strong>Do not contact</Strong>, the flag on a{" "}
        <DocLink to="/docs/revenue#contacts-vs-customers">Contact</DocLink>, says{" "}
        <em>never contact this person</em> — and blocks every address you hold for them, including
        ones that were never suppressed individually. Use the contact flag when somebody asks you to
        stop by phone or in a meeting.
      </P>

      <H2 id="enforcement">Sending refuses suppressed recipients</H2>
      <P>
        The check sits at the single outbound choke-point, so it covers every path equally and there
        is deliberately no way to send that skips it:
      </P>
      <UL>
        <LI>a Member pressing <Strong>Send</Strong> or <Strong>Reply</Strong> in the inbox;</LI>
        <LI>
          a bulk send from the <DocLink to="/docs/email#drafts">Drafts review queue</DocLink>;
        </LI>
        <LI>
          a <DocLink to="/docs/sequences">Sequence</DocLink> step, whether or not autoSend is on;
        </LI>
        <LI>
          an AI employee calling its mail tools, at any grant level, including the{" "}
          <Code>gmail_*</Code> tools from the Google connector.
        </LI>
      </UL>
      <P>
        For a single message the refusal is <Strong>all or nothing</Strong>: if any recipient in To,
        Cc or Bcc is blocked, the send fails and names the addresses. Quietly delivering to three of
        four recipients is a bug the sender discovers weeks later, if ever. For a sequence the
        behaviour is the tolerant one — a blocked contact is skipped with the reason recorded on the
        enrolment, and the other ninety-nine go out.
      </P>
      <Callout kind="info" title="Re-checked at send, not at draft.">
        Somebody who unsubscribes an hour after a draft was written must not receive that draft. The
        gate runs when the message actually goes out, so an approved queue that sits overnight is
        still safe in the morning.
      </Callout>

      <H2 id="unsubscribe">Unsubscribe links and one-click</H2>
      <P>
        Outbound mail carries an unsubscribe link in its footer and the RFC 8058 header pair that
        makes Gmail and Outlook render their own native <Strong>Unsubscribe</Strong> button next to
        your sender name, with a <Code>mailto:</Code> fallback for older clients. Gmail and Yahoo
        expect at least one of those on bulk mail; without them, the only way a recipient can stop
        you is the spam button.
      </P>
      <P>Four properties of that link, because each one exists to stop a specific failure:</P>
      <OL>
        <LI>
          <Strong>It never expires.</Strong> A dead unsubscribe link is a compliance failure and,
          practically, a spam complaint. Links keep working years later.
        </LI>
        <LI>
          <Strong>It needs no login and no JavaScript.</Strong> Gmail&apos;s servers POST the URL
          themselves the moment somebody presses the native button — no cookie, no browser, no human
          present.
        </LI>
        <LI>
          <Strong>It is idempotent.</Strong> The mail client&apos;s POST and the recipient&apos;s
          later click on the footer link both succeed, and the timeline records the opt-out once.
        </LI>
        <LI>
          <Strong>A bad or unknown token reveals nothing.</Strong> Tampered, truncated and simply
          unrecognised links all render the same neutral page, so the endpoint cannot be used to
          test whether an address is in your system.
        </LI>
      </OL>
      <P>
        One click writes three things: a suppression with reason <Code>unsubscribe</Code>, an{" "}
        <Code>unsubscribe</Code> activity on the contact&apos;s timeline, and a stop on every live
        sequence enrolment for that person. There is nothing to process afterwards.
      </P>
      <Callout kind="info" title="A link scanner can unsubscribe somebody who never clicked.">
        Acting on the plain GET is a deliberate trade. Some corporate security tools follow every URL
        in an inbound message, so an opt-out occasionally lands that the recipient did not intend.
        The alternative — a confirmation button — loses real opt-outs from clients that strip forms,
        and a <em>missed</em> unsubscribe is a spam complaint. An over-eager one is a row you can
        remove from the list. We chose the recoverable failure.
      </Callout>

      <H2 id="bounces">Bounces</H2>
      <P>
        Mail sync reads the delivery reports that come back to the mailbox. A report from a mail
        daemon — <Code>mailer-daemon@</Code>, <Code>postmaster@</Code> and the other addresses
        reserved for exactly this — carrying a permanent failure (a 5xx reply or a{" "}
        <Code>5.x.x</Code> status) is treated as a <Strong>hard bounce</Strong>: the failed address
        is suppressed with reason <Code>bounce</Code>, the contact is stamped as bounced, a{" "}
        <Code>bounce</Code> activity lands on the timeline, and any live sequence enrolment stops.
      </P>
      <P>
        Soft failures — a full mailbox, a temporary defer — are not suppressed, because the address
        is fine and will accept mail tomorrow. Vendor envelope senders like <Code>bounces@</Code> are
        deliberately not treated as daemons either; they are also used for ordinary bulk mail, and
        treating one as a bounce report would let a newsletter suppress your contacts.
      </P>
      <Callout kind="warn" title="A rising bounce rate is a stop signal, not a nuisance.">
        Bounces above roughly 2% of a send mean your list is stale, and mailbox providers read that
        as a list you did not earn. Pause the sequence, fix the source of the addresses, and clear
        the dead rows before you send again. Do not keep sending and hope the average recovers.
      </Callout>

      <H2 id="caps">Send caps and windows</H2>
      <P>
        Volume and timing are per-sequence, set in the sequence builder and described in full under{" "}
        <DocLink to="/docs/sequences#caps">Sequences</DocLink>:
      </P>
      <UL>
        <LI>
          <Strong>Daily cap</Strong> — the maximum touches a sequence may produce in a day, default
          50. Both sent and drafted touches count. <Code>0</Code> means uncapped; it is not a setting
          for a sequence you have not watched run.
        </LI>
        <LI>
          <Strong>Send window</Strong> — weekdays 08:00 to 17:00 in the timezone you choose, by
          default. Mail that lands at 3am reads as automated however good the copy is.
        </LI>
        <LI>
          <Strong>Per-sweep budget</Strong> — the scheduler dispatches a bounded number of touches
          per pass across the whole installation, so a backlog trails rather than bursting.
        </LI>
      </UL>
      <P>
        If you are sending from a domain with little history, start far below these defaults. A new
        domain that emits two hundred cold emails on its first day is indistinguishable from a
        compromised account. Ramp over weeks, keep replies high and complaints near zero, and let
        volume follow engagement rather than ambition.
      </P>
      <Callout kind="tip" title="Do the boring DNS work first.">
        SPF, DKIM and a DMARC policy on the sending domain are prerequisites, not optimizations —
        Google and Yahoo require them from bulk senders, and Genosyn cannot supply them for you. Set
        them up on the Google Workspace domain behind the mailbox you connected under{" "}
        <DocLink to="/docs/email">Email</DocLink> before your first campaign.
      </Callout>

      <H2 id="burned">If the domain is already burned</H2>
      <P>
        The symptoms: replies stop, open rates collapse, customers say your mail lands in spam, or
        your own transactional mail — invoices, password resets — starts going missing. What to do,
        in order:
      </P>
      <OL>
        <LI>
          <Strong>Stop sending outbound entirely.</Strong> Pause every{" "}
          <DocLink to="/docs/sequences">Sequence</DocLink>, disable every{" "}
          <DocLink to="/docs/signals">Signal</DocLink> whose action enrols or hands off, and turn off
          autoSend. Every additional message makes the hole deeper.
        </LI>
        <LI>
          <Strong>Find out what you sent.</Strong> The per-step run history on each enrolment records
          exactly what went to whom and when, and what was skipped. Read it before you theorize.
        </LI>
        <LI>
          <Strong>Clean the list.</Strong> Suppress every bounced and unresponsive address, import
          any opt-out list you had elsewhere, and delete the source of the addresses if you cannot
          say where they came from.
        </LI>
        <LI>
          <Strong>Protect the transactional path.</Strong> Move invoice, receipt and password-reset
          mail to a subdomain or a separate sending identity that has never carried cold outbound, so
          the business keeps working while the reputation recovers.
        </LI>
        <LI>
          <Strong>Fix authentication and monitor it.</Strong> Confirm SPF, DKIM and DMARC pass, and
          watch the DMARC aggregate reports rather than guessing.
        </LI>
        <LI>
          <Strong>Rebuild slowly, to people who reply.</Strong> Weeks of low-volume mail to engaged
          recipients is what restores a reputation. There is no faster route, and buying a fresh
          domain to escape the problem simply moves it, because the behaviour that burned the first
          one is still in your process.
        </LI>
      </OL>
      <P>
        Then change the thing that caused it. In practice it is almost always one of three: a list
        you did not earn, autoSend enabled before anybody read the drafts, or a{" "}
        <DocLink to="/docs/signals#dedupe">Signal with no dedupe column</DocLink> re-firing the same
        people every tick.
      </P>

      <H2 id="advanced">Advanced</H2>
      <H3 id="advanced-public-url">The unsubscribe endpoint must be publicly reachable</H3>
      <P>
        Unsubscribe links are served from <Code>/u/&lt;token&gt;</Code> at the root of your install,
        outside every auth, session and origin check — because the caller is a stranger&apos;s mail
        client. If your Genosyn instance is only reachable on a VPN or an internal hostname, those
        links do not work for recipients, and one-click unsubscribe fails silently at Gmail. Set the
        instance&apos;s public URL to something the internet can resolve before you send outbound
        mail. A reverse proxy must pass <Code>POST /u/*</Code> through unmodified; it carries no
        Origin header and needs no body.
      </P>
      <H3 id="advanced-secret">Rotating the encryption secret invalidates outstanding links</H3>
      <P>
        Unsubscribe tokens are signed with a key derived from{" "}
        <Code>security.encryptionSecret</Code> in{" "}
        <DocLink to="/docs/self-hosting">config.ts</DocLink>. Changing that secret makes every link
        already sitting in somebody&apos;s inbox stop verifying, and a dead unsubscribe link is the
        thing this whole page exists to avoid. If you must rotate it, expect complaints from anyone
        who tries to opt out of older mail, and be ready to suppress those addresses by hand.
      </P>
    </>
  );
}
