import { Callout, Code, DocLink, H2, H3, LI, OL, P, PageHeader, Strong, UL } from "@/docs/Prose";

export function Email() {
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Email"
        lead={
          <>
            Connect a Gmail account and work your inbox inside Genosyn — read threads, reply, and
            file mail like a normal client. Then put your{" "}
            <DocLink to="/docs/employees">AI Employees</DocLink> on it: chat with them right beside
            the inbox, hand them threads to draft answers, and set <Strong>rules</Strong> that use
            static filters or AI judgment to act on new mail. Everything syncs both ways.
          </>
        }
      />

      <H2 id="what">What this is</H2>
      <P>
        The <Strong>Email</Strong> section is a real mail client backed by your Gmail mailbox.
        Genosyn imports your <Strong>whole mailbox</Strong> into a local index and keeps it in step
        with Gmail in both directions: mail that arrives in Gmail shows up here within about a
        minute, and anything you do here — read, star, archive, label, draft, send, forward — is
        written straight back to Gmail. The goal is that you never need to open Gmail to work your
        inbox; read it there or here, act on it here, and neither drifts.
      </P>

      <Callout kind="info" title="Different from the email that Genosyn sends.">
        This is your inbox. It is unrelated to the transactional email Genosyn sends for password
        resets and invoices (Settings → Email), which stays exactly as it was.
      </Callout>

      <H2 id="connect">Connecting a mailbox</H2>
      <P>
        Email rides on the existing <DocLink to="/docs/integrations">Google integration</DocLink>,
        so a mailbox is one Google connection that granted the Gmail product at consent time.
      </P>
      <Callout kind="info" title="Connect once, with nothing to set up.">
        If an instance admin has registered this install&apos;s Google app at{" "}
        <Strong>Admin → Integrations</Strong> — a one-time job, described under{" "}
        <DocLink to="/docs/integrations">Integrations</DocLink> — connecting a mailbox is just:
        click <Strong>Google Workspace</Strong>, tick <Strong>Gmail</Strong>, approve on
        Google&apos;s screen. There is no Google Cloud project to create and no Client ID to paste.
        Without that registration, the connect form asks for a Client ID and Secret of your own,
        which means registering a Web OAuth client in Google Cloud Console first.
      </Callout>
      <OL>
        <LI>
          Open <Strong>Email → Integrations</Strong> and add (or reconnect) a{" "}
          <Strong>Google</Strong> connection. On Google&apos;s consent screen, tick the{" "}
          <Strong>Gmail</Strong> product so the connection carries the Gmail scope.
        </LI>
        <LI>
          Open <Strong>Email</Strong> from the section menu and pick that connection. Genosyn reads
          the account address and starts the first sync in the background.
        </LI>
        <LI>
          The first sync imports your <Strong>entire mailbox</Strong>, newest first, so everything
          is searchable here. A big account fills in over a few minutes in the background (the
          sidebar shows the running count); after that, sync is incremental. The import checkpoints
          every conversation, so a restart, a rate limit, or a dropped connection resumes at the
          exact remaining email instead of replaying a whole page. Temporary Gmail failures are
          retried with backoff, and unusually large conversations fall back to smaller per-message
          reads. Mail that arrives <em>while</em> the import is still running shows up (and triggers
          your rules) within a minute, without waiting for it to finish. You can connect more than
          one mailbox and switch between them from the account picker at the top of the sidebar.
        </LI>
      </OL>

      <Callout kind="info" title="No Google Cloud Pub/Sub required.">
        Sync is poll-based on a short interval, so there is nothing to set up beyond the Google
        connection itself. Self-hosted installs get a working inbox with zero extra ceremony. (On a
        very large account a master admin can cap the first import to recent mail with{" "}
        <Strong>Backfill days</Strong> at <Code>Admin → Runtime</Code>; the default imports
        everything.)
      </Callout>

      <H2 id="using">Reading and answering mail</H2>
      <P>
        The folder rail carries the usual views — Inbox, Starred, Sent, Drafts, All mail, Spam,
        Trash — plus your Gmail labels. Open a thread to read it, then <Strong>Reply</Strong>,{" "}
        <Strong>Reply all</Strong>, <Strong>Forward</Strong>, or <Strong>Compose</Strong> a new
        message — with file attachments if you need them, added from the Attach button or by pasting
        a screenshot straight into the message box. Star, archive, trash, mark read/unread, and
        apply labels all act on the whole thread and land in Gmail immediately.
      </P>
      <P>
        The Inbox header shows when the mailbox last synced <Strong>successfully</Strong>. Click{" "}
        <Strong>Sync now</Strong> to check Gmail immediately. Genosyn records that pass before it
        starts, so the button follows a real queued, running, succeeded, or failed state even if you
        reload the page or miss a live update. A temporary timeout is retried automatically; if the
        retry budget is exhausted, the button stops, the mailbox shows a useful explanation, and{" "}
        <Strong>Retry sync</Strong> starts another resumable pass. Background sync also retries an
        errored mailbox on a slower cadence.
      </P>
      <P>
        If Google asks you to authorize again, or you need to change the Gmail access granted to
        Genosyn, an owner or admin can open <Strong>Email → Settings</Strong> and click{" "}
        <Strong>Reconnect Google</Strong>. This refreshes the existing Connection in place, so your
        imported mail, rules, AI access, and mailbox settings stay intact. After Google confirms the
        connection, return to Email and click <Strong>Retry sync</Strong> if the mailbox was showing
        an error. Reconnect with the same Google address and keep the Gmail product selected; to
        replace the mailbox with a different address, disconnect this mailbox first.
      </P>
      <P>
        Search (press <Code>/</Code> to jump to the box) covers <Strong>all mail</Strong> — every
        folder except Spam and Trash — and matches subjects, participants, and the{" "}
        <Strong>full text of every message</Strong> in the index. Terms combine, quotes match exact
        phrases, and Gmail-style operators narrow things down: <Code>from:</Code>, <Code>to:</Code>,{" "}
        <Code>subject:</Code>, <Code>label:</Code>, <Code>has:attachment</Code>,{" "}
        <Code>is:unread</Code>, <Code>is:starred</Code>, <Code>before:</Code>/<Code>after:</Code>{" "}
        with a date, and <Code>in:</Code> to pick a folder (<Code>in:archive</Code>,{" "}
        <Code>in:trash</Code>, …). So <Code>from:acme has:attachment after:2026-01-01 invoice</Code>{" "}
        finds the attachment-carrying Acme invoice threads from this year, wherever they were filed.
        AI Employees get the exact same grammar through their mail search tool.
      </P>
      <P>
        Message bodies are rendered safely — scripts are stripped and remote images stay blocked
        behind a <Strong>Show images</Strong> click, so a tracking pixel can&apos;t phone home just
        because you opened a message.
      </P>
      <H2 id="drafts">The Drafts review queue</H2>
      <P>
        AI Employees write drafts; you decide what actually goes out. <Strong>Drafts</Strong> opens
        as a review queue built for that job — one row per draft rather than one per thread, so a
        night&apos;s work is a single scannable list instead of a folder to click through.
      </P>
      <P>
        Every row shows who wrote it: the <Strong>AI Employee</Strong> and the{" "}
        <Strong>Routine</Strong> that produced it, next to the recipient, subject, and a preview.
        Filter the queue <Strong>by AI Employee</Strong> or <Strong>by routine</Strong> from the
        toolbar — each option carries its own count — and group the list the same way to review one
        routine&apos;s output as a batch. Drafts you wrote yourself show you instead; anything
        written before this shipped, or synced in from Gmail, reads as <Strong>Unattributed</Strong>{" "}
        rather than guessing at an author.
      </P>
      <P>
        Press <Code>Enter</Code> to peek at a draft inline, or open it for full review: the whole
        message, its attachments, the message it is replying to, the Run that produced it, and the
        thread&apos;s AI chat — all in one panel, without leaving the queue.
      </P>

      <H3 id="sending-in-bulk">Marking drafts to send, and sending everything</H3>
      <P>
        Tick the drafts you want and press <Strong>Send selected</Strong>, or take the whole
        filtered queue with <Strong>Send all</Strong>. The header checkbox selects every draft
        matching the current filter — not only the ones on screen — so a 300-draft queue is two
        clicks rather than 300.
      </P>
      <P>
        Because sending cannot be undone, every batch stops at a confirmation that shows what a
        count alone hides: <Strong>who is about to receive mail</Strong> — a sample of the real
        addresses — a breakdown per routine, and the mailbox it goes out from. Past 25 drafts, or
        whenever you selected everything matching a filter, the confirm button stays disabled until
        you acknowledge the size explicitly.
      </P>
      <P>
        Confirming adds the drafts to a durable send queue instead of releasing them together. The
        first email waits a random one to two minutes; after every attempt, Genosyn chooses a fresh
        one-to-two minute pause before the next. A progress bar stays at the top of{" "}
        <Strong>Drafts</Strong> with sent, failed, and remaining counts, the next-send countdown,
        and an approximate finish time for the whole queue. You can leave the page or restart the
        app without collapsing the remaining mail into a burst.
      </P>
      <P>
        A draft with no recipient can never be selected: its checkbox is disabled rather than being
        silently dropped at send time. Those drafts collect in a pinned{" "}
        <Strong>Needs attention</Strong> group along with anything Gmail refused, so nothing
        vanishes without being accounted for. Drafts disappear from the review list as soon as they
        enter the send queue, leaving the page ready for more review. You can add newly approved
        drafts while sending is in progress; they join the same paced queue and its finish estimate
        updates automatically. The progress bar disappears when the queue finishes. A failed attempt
        returns to <Strong>Needs attention</Strong> with Gmail&apos;s reason while the rest of the
        queue continues.
      </P>

      <H2 id="suppressed">Sending refuses suppressed recipients</H2>
      <P>
        Every send from this mailbox is checked against the company&apos;s{" "}
        <DocLink to="/docs/deliverability">suppression list</DocLink> — the addresses that
        unsubscribed, hard-bounced, or were marked do-not-email. The check sits at the one outbound
        choke-point, so it covers a Member pressing Send, a bulk send from the Drafts queue, a
        sequence step, and an AI Employee&apos;s mail tools identically, and it runs when the
        message actually goes out rather than when the draft was written.
      </P>
      <P>
        A single message is refused <Strong>all or nothing</Strong>: if any recipient in To, Cc or
        Bcc is on the list, the send fails and names the addresses, rather than quietly delivering
        to the rest. A bulk send skips the blocked drafts and tells you which ones. Manage the list,
        and read the unsubscribe and bounce rules, under{" "}
        <DocLink to="/docs/deliverability">Deliverability</DocLink>.
      </P>

      <H2 id="power-user">Keyboard, bulk actions, and ⌘K</H2>
      <P>
        Mail is keyboard-drivable end to end. In any list, <Code>j</Code> and <Code>k</Code> move,{" "}
        <Code>x</Code> selects, <Code>e</Code> archives — or sends, in Drafts — <Code>#</Code>{" "}
        trashes, <Code>s</Code> stars, <Code>u</Code> toggles read, <Code>o</Code> opens a draft for
        review, <Code>c</Code> composes from anywhere in mail, and <Code>Esc</Code> clears the
        selection. Press <Code>?</Code> for the full list. Shortcuts pause automatically while you
        are typing in a field or a dialog is open.
      </P>
      <P>
        The inbox has the same multi-select: tick rows — <Strong>shift-click</Strong> takes a range
        — then archive, trash, star, or mark read across all of them in one action, instead of one
        thread at a time.
      </P>
      <P>
        <Code>⌘K</Code> runs mail actions as well as finding pages: compose, sync the mailbox, jump
        to any folder, and — when something is selected — act on that selection. In the Drafts queue
        it offers <Strong>Send all drafts</Strong> directly.
      </P>

      <H3 id="saved-searches">Quick filters and saved searches</H3>
      <P>
        Above the thread list, one-click chips narrow what you are looking at —{" "}
        <Strong>Unread</Strong>, <Strong>Starred</Strong>, <Strong>Has attachment</Strong> — scoped
        to the folder you are standing in. They are not a separate filtering system: each chip
        writes the same operators you could have typed, so <Code>is:unread</Code> from a chip and{" "}
        <Code>is:unread</Code> from the box are the same query.
      </P>
      <P>
        Any search you can type, you can keep. With a query in the box, press{" "}
        <Strong>Save search</Strong>, give it a name, and it becomes a chip you can click from then
        on. Saved searches are <Strong>yours alone</Strong> — they are stored per person, so a
        shared mailbox does not turn into a shared list of everybody&apos;s shortcuts — and hovering
        one reveals an × to remove it.
      </P>

      <H2 id="analysis">Every email arrives already triaged</H2>
      <P>
        You do not have to ask. As each email lands, an AI Employee reads it once and puts a short
        summary and a row of <Strong>action buttons</Strong> at the top of the thread — the next
        steps that <em>this</em> email actually deserves. A customer asking to be billed gets{" "}
        <Strong>Create the invoice</Strong>. Someone asking what it would cost gets{" "}
        <Strong>Draft an estimate</Strong>. A newsletter you never signed up for gets{" "}
        <Strong>Unsubscribe</Strong>. Anything that needs an answer gets{" "}
        <Strong>Draft a reply</Strong>, with the reply already written.
      </P>
      <P>
        The buttons vary because the reasoning does. There is no fixed list per sender and no rule
        to write: the employee reads the email, decides what a person would do next, and offers up
        to four things. Often the honest answer is none, and then you just get the one-line summary
        and a category chip.
      </P>
      <P>What a button does when you press it:</P>
      <UL>
        <LI>
          <Strong>Draft a reply</Strong> — saves a Gmail draft on the thread and puts it in the{" "}
          <DocLink to="/docs/email#drafts">Drafts review queue</DocLink>. Nothing sends until you
          send it.
        </LI>
        <LI>
          <Strong>Create the invoice</Strong> / <Strong>Draft an estimate</Strong> — pulls the line
          items out of the email, matches the sender to a customer (or creates one), and opens the{" "}
          <DocLink to="/docs/finance">draft</DocLink> for you to check. Drafts carry no number and
          post nothing to the ledger until you issue them.
        </LI>
        <LI>
          <Strong>Unsubscribe</Strong> — sends the sender&apos;s own one-click unsubscribe request.
          It is only ever offered when the email carries a verified, signed one-click header, so it
          cannot become a link the email talked us into visiting.
        </LI>
        <LI>
          <Strong>Archive</Strong>, <Strong>Star</Strong>, <Strong>Label</Strong> — ordinary triage
          on the thread.
        </LI>
        <LI>
          <Strong>Hand to an employee</Strong> — starts a{" "}
          <DocLink to="/docs/email#hand-to-ai">handover</DocLink> with the instruction already
          written.
        </LI>
      </UL>
      <Callout kind="tip" title="Nothing runs by itself.">
        Analysis only ever <em>proposes</em>. Buttons act with your access, not the employee&apos;s
        — which is why an employee on <Strong>Draft</Strong> can offer to write a reply you then
        send. What you see under each label is the fact the server checked, not the employee&apos;s
        claim about it: the total an invoice adds up to, the host an unsubscribe would talk to, the
        address a reply would go to. Buttons that consume something are marked done once they run,
        so a reload cannot fire them twice. Acting with <em>your</em> access cuts both ways: if your{" "}
        <DocLink to="/docs/finance">finance</DocLink> access is read-only, the invoice and estimate
        buttons appear greyed out with the reason, because they would be refused anyway — you still
        see what the email was read as.
      </Callout>
      <P>
        Email is untrusted text, and it is treated that way. The employee reading it gets one
        submission tool and nothing else — no repositories, no secrets, no browser, no company tools
        — so an email that tries to give instructions is evidence about its sender, not a command.
        It also cannot choose its own affordances: whether <Strong>Unsubscribe</Strong>
        may be offered at all is decided by Genosyn before the employee ever sees the email.
      </P>
      <H3 id="analysis-settings">Choosing who reads, and turning it off</H3>
      <P>
        <Strong>Email → Settings → AI analysis</Strong> is on for every mailbox. Leave the employee
        picker on <Strong>Choose automatically</Strong> and Genosyn uses whichever employee you have
        granted the most access to — so a mailbox works the day you connect it. Pick one explicitly
        when you want a particular voice on your replies, and pin one of their{" "}
        <DocLink to="/docs/models">models</DocLink> when you want a particular brain. The card
        always tells you who would read the next email to arrive, so an on switch never means
        nothing is happening. Turn it off and new mail simply arrives plain.
      </P>
      <Callout kind="info" title="Read access categorises; Draft access can reply.">
        An employee on <Strong>Read</Strong> can summarise and triage but will not offer to write a
        reply. Raise them to <Strong>Draft</Strong> under{" "}
        <DocLink to="/docs/email#access">AI access</DocLink> for that.
      </Callout>

      <H2 id="assistant">AI chat on every email</H2>
      <P>
        Open any email and its <Strong>Ask AI</Strong> chat is already docked beside it. Type what
        you want directly — &ldquo;summarize this email&rdquo;, &ldquo;draft a reply&rdquo;,
        &ldquo;make this draft shorter and friendlier&rdquo;, or &ldquo;label and archive
        this&rdquo;. Type <Code>@</Code> when you want to choose a particular AI Employee. The
        employee you tagged stays on that email until you tag somebody else. Type <Code>#</Code> to
        attach a product area or company resource to the instruction, or <Code>/new</Code> by itself
        to clear this email&apos;s AI context. Use several <Code>#</Code> tags when the work crosses
        products—for example an account, Invoices, and a Workspace channel. The same panel sits
        beside every <DocLink to="/docs/routines#assistant">Routine</DocLink>, where it answers
        about the schedule and the Run log instead.
      </P>
      <P>
        Every email has an independent chat, including each item in the Drafts review queue, so
        instructions and replies never bleed into another conversation. The employee already has the
        opened email and current draft in context — no ids or copy-pasting. With{" "}
        <Strong>Draft</Strong>
        access it can rewrite the actual Gmail draft in place, and the review pane refreshes with
        the result. An employee without mailbox access can chat but cannot see or change the email.
        Everything it actually does appears as a small action pill under its reply.
      </P>
      <P>
        Replies can also carry <Strong>action buttons</Strong> — concrete next steps the employee
        proposes that run with <em>your</em> authority when you click them: open a pre-filled reply,
        send a draft it just wrote, archive or label the thread, start a handover, or create an
        inbox rule it spotted a pattern for. That is the human-in-the-loop sweet spot: an employee
        on the default <Strong>Draft</Strong> level can prepare and propose a send, and the send
        happens only when you press the button. Buttons that consume something (send, triage,
        handover, rule) are marked done after they run, so a reload can&apos;t re-arm them.
      </P>
      <P>
        <Strong>Files go both ways.</Strong> An employee can open anything attached to the email
        itself — a supplier form, a signed order, a statement — without you downloading and
        re-uploading it. Ask it to fill in a PDF form that arrived on the thread and it reads the
        form&apos;s fields, completes them from what your company already knows, and hands the
        finished file back as a download on its reply. It can attach that same file to a Gmail
        draft, so the reply leaves with the paperwork on it. If the blank form isn&apos;t on the
        thread at all, the employee can search the web for the current version, check the page, and
        download it to work on.
      </P>
      <P>
        You can attach files to the chat too — the paperclip in the composer. Text, Markdown, CSV
        and PDF contents are read directly; anything else is announced by name so the employee knows
        it arrived. Files in an email&apos;s chat are visible to anyone who can open that mailbox,
        since the conversation belongs to the email rather than to one person.
      </P>
      <P>
        <Strong>Picking the model.</Strong> When the tagged employee has more than one connected{" "}
        <DocLink to="/docs/models">AI Model</DocLink>, a selector appears under the composer. It
        defaults to that employee&apos;s active model, and an email&apos;s chat stays on whichever
        model answered last — so reopening it days later does not quietly continue on a different
        brain. Tagging a different employee switches to their models.
      </P>
      <P>
        A reply in progress belongs to the server, not to your browser tab. Work that takes a while
        shows as <Strong>working</Strong> beside the email; if the connection drops, the panel says{" "}
        <Strong>reconnecting</Strong> and picks the same reply back up when it lands — closing the
        panel, switching threads, or reloading the page is safe. Each email thread is answered
        independently, so a reply running on one email never holds up the one you are reading; only
        a second message on the <em>same</em> email waits its turn, and it waits instead of asking
        you to send it again. Replies that genuinely could not run — the server restarted
        mid-answer, or the employee stayed busy for several minutes — say so plainly and offer{" "}
        <Strong>Try again</Strong>, which re-sends that same instruction.
      </P>

      <H2 id="hand-to-ai">Handing a thread to an AI Employee</H2>
      <P>
        Open any thread and click <Strong>Hand to AI</Strong>. Pick an employee, write a short
        instruction, and choose what it should do:
      </P>
      <UL>
        <LI>
          <Strong>Draft a reply.</Strong> The employee writes a reply as a Gmail draft on the
          thread. Nothing is sent — you review the draft and press <Strong>Send</Strong> when it is
          right. This is the default and the safe way to put AI on your inbox.
        </LI>
        <LI>
          <Strong>Reply directly.</Strong> The employee composes and sends the reply itself. Only
          offered to employees you trust with <Strong>send</Strong> access.
        </LI>
        <LI>
          <Strong>Triage.</Strong> No writing — the employee reads the thread and files it: applies
          a label, archives, stars, or marks it read.
        </LI>
      </UL>
      <P>
        A handover you start runs with the employee&apos;s <DocLink to="/docs/soul">Soul</DocLink>{" "}
        and <DocLink to="/docs/skills">Skills</DocLink>, while every action is limited by both your
        current access and the employee&apos;s Grants. Starting or retrying one requires a logged-in
        browser session. Rule-created handovers remain trusted automation and use the
        employee&apos;s Grants. Progress and results appear on the thread and on the{" "}
        <Strong>AI handovers</Strong> page, and Genosyn notifies you when the handover finishes.
      </P>

      <H2 id="access">Giving AI Employees mailbox access</H2>
      <P>
        Under <Strong>Email → Settings → AI access</Strong>, grant the employees who should be able
        to act on the mailbox, at one of three levels:
      </P>
      <UL>
        <LI>
          <Strong>Read.</Strong> Browse and search threads and labels — no changes.
        </LI>
        <LI>
          <Strong>Draft.</Strong> Also write drafts, apply labels, archive, star, and mark read. The
          default: an employee can triage the inbox and put a finished reply in the thread, but a
          human still sends it.
        </LI>
        <LI>
          <Strong>Send.</Strong> Also send mail on the account&apos;s behalf. Reserve this for
          employees trusted to speak for the company unattended.
        </LI>
      </UL>
      <P>
        An employee used for a rule&apos;s <Strong>AI judgment</Strong> needs a connected AI Model
        and at least <Strong>Read</Strong> access to that mailbox. The rule editor shows both beside
        every employee and disables anyone who is not ready, so a broken AI judgment step cannot be
        saved for future mail.
      </P>
      <Callout kind="warn" title="Members always have full access; grants govern AI only.">
        Human members of the company can already use every connected mailbox. These levels only
        decide what an AI Employee&apos;s tools and rules are allowed to do.
      </Callout>
      <P>
        The level covers <em>every</em> route an employee has to the mailbox, not just the mail
        tools. The <DocLink to="/docs/integrations">Google connector</DocLink> exposes its own{" "}
        <Code>gmail_*</Code> tools on the same account, and once you connect a mailbox here those
        tools answer to the level you set — an employee on <Strong>Draft</Strong> is refused a send
        whichever tool it reaches for. An employee you never granted is refused outright, even if it
        holds a grant on the underlying Google Connection.
      </P>
      <Callout kind="info" title="A mailbox you haven't connected here isn't governed.">
        These levels start applying to the <Code>gmail_*</Code> tools the moment you connect the
        mailbox under <Strong>Email</Strong>. Before that there is no mailbox record to attach a
        level to, so an employee granted the Google Connection can still read and send through it —
        the Connection grant is the only thing you told Genosyn. Connect the mailbox to bring it
        under these levels.
      </Callout>

      <H2 id="rules">Rules — automating the inbox</H2>
      <P>
        A <Strong>rule</Strong> runs on every new message that arrives:{" "}
        <em>when an email matches these conditions, do these actions.</em> Static filters match on
        sender, recipient, subject, body text, and whether there&apos;s an attachment. Every filled
        filter must match. You can then turn on <Strong>AI judgment</Strong>, choose an eligible AI
        employee, and describe the messages that count in plain language. Static filters run first;
        the AI Employee sees only mail that passes them, and its answer must also be yes before any
        action runs. Each message that reaches AI judgment uses the employee&apos;s active model, so
        narrow static filters are also the simplest way to control cost on a busy mailbox.
      </P>
      <P>
        For example, create a rule called <Strong>Remove marketing spam</Strong>, turn on AI
        judgment, and write &ldquo;Legitimate marketing or newsletter email I did not ask for;
        exclude receipts, security alerts, suspicious spam, and messages from people.&rdquo; Add{" "}
        <Strong>Unsubscribe safely</Strong> and, if you want, <Strong>Archive</Strong>. Static
        filters are optional, but adding one is a useful way to narrow what the AI Employee has to
        review. Every rule that matches still fires, so labelling, filing, safe unsubscribe, and
        handovers compose naturally.
      </P>
      <Callout kind="warn" title="Safe unsubscribe never clicks a link in the email body.">
        The action only uses one HTTPS URL advertised by RFC unsubscribe headers that Gmail confirms
        were covered by a valid DKIM signature. It rejects redirects, never sends browser cookies or
        authorization, and never follows body links. If the sender did not provide that
        standards-based method, the action fails safely and the rule continues with its other
        actions. Saving an enabled unsubscribe rule always asks for confirmation because the
        external request cannot be undone. Treat suspicious or phishing mail as spam instead: even a
        standards-shaped endpoint controlled by an attacker could confirm that your address is
        active.
      </Callout>
      <Callout kind="info" title="Rules never fire on your backfill.">
        Connecting a mailbox imports history quietly; rules only run on genuinely new mail after
        that, and never on drafts or your own sent messages — so connecting an account can&apos;t
        stampede an employee with hundreds of historical handovers.
      </Callout>

      <H3 id="routines">Rules vs. Routines</H3>
      <P>
        Rules are reactive — they fire when mail arrives. For scheduled email work (&ldquo;every
        morning, summarize yesterday&apos;s unread support threads&rdquo;), give an employee a{" "}
        <DocLink to="/docs/routines">Routine</DocLink> instead: a granted employee can search, read,
        draft, and send through the same mailbox from any routine, no new machinery required.
      </P>

      <H2 id="ai-tools">What employees can do with mail</H2>
      <P>
        Granted employees get a <Code>mail</Code> tool on the built-in <Code>genosyn</Code> MCP
        surface, with operations to list accounts, search and read threads, write drafts, triage
        (label / archive / mark read), edit existing drafts, propose the email chat&apos;s{" "}
        <DocLink to="/docs/email#assistant">action buttons</DocLink>, and — with{" "}
        <Strong>send</Strong> access — send. Search runs over the same full-text index humans use
        and takes structured filters (sender, recipient, date range, label, has-attachment), so an
        employee can answer &ldquo;what did the vendor say about pricing last quarter?&rdquo;
        without a human forwarding anything. Every action an employee takes is checked against its
        grant level and recorded in the audit log and the employee&apos;s journal, so you can always
        see what it did after the fact.
      </P>

      <Callout kind="warn" title="Disconnecting is safe.">
        Removing a mailbox from Genosyn deletes the local mirror, rules, AI handovers, and grants
        here. Your Gmail account and the underlying Google connection are never touched — other
        Google surfaces keep working.
      </Callout>
    </>
  );
}
