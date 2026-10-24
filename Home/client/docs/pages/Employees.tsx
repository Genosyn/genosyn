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

export function Employees() {
  return (
    <>
      <PageHeader
        eyebrow="Core concepts"
        title="AI Employees"
        lead={
          <>
            An AI Employee is a persistent teammate attached to a company. They have a name, a role,
            a model, a working directory, and three editable pieces of prose that define who they
            are and how they work.
          </>
        }
      />

      <H2 id="anatomy">Anatomy</H2>
      <P>
        Every AI Employee row carries the fields you can configure from the UI plus a few the runner
        needs at spawn time:
      </P>
      <KeyList
        rows={[
          {
            term: "name + slug",
            def: "Display name (you can rename) and slug (frozen at create-time so URLs and directory paths stay stable).",
          },
          {
            term: "role",
            def: "A short role string — Brand writer, Bookkeeper, On-call SRE.",
          },
          {
            term: "soulBody",
            def: (
              <>
                Markdown stored on the row. The employee&apos;s constitution — see{" "}
                <DocLink to="/docs/soul">Soul</DocLink>.
              </>
            ),
          },
          {
            term: "skills[]",
            def: (
              <>
                One-to-many <Code>Skill</Code> rows. See <DocLink to="/docs/skills">Skills</DocLink>
                .
              </>
            ),
          },
          {
            term: "routines[]",
            def: (
              <>
                One-to-many <Code>Routine</Code> rows, managed from the top-level AI → Routines
                section. See <DocLink to="/docs/routines">Routines</DocLink>.
              </>
            ),
          },
          {
            term: "model",
            def: (
              <>
                One or more <Code>AIModel</Code> brains, one active at a time. See{" "}
                <DocLink to="/docs/models">AI Models</DocLink>.
              </>
            ),
          },
          {
            term: "team",
            def: (
              <>
                Optional Team the employee belongs to — Engineering, Revenue, Ops. Pick it on the
                employee&apos;s <Strong>Settings → General</Strong>; it saves as you pick it, and
                is put back with the reason if the save is refused. Create teams at{" "}
                <Strong>Settings → Teams</Strong>. It shows on the employee&apos;s card in the
                Employees list.
              </>
            ),
          },
          {
            term: "browserEnabled",
            def: (
              <>
                Flips on the built-in <Code>browser</Code> MCP server that drives real Google
                Chrome. Off by default. See <DocLink to="/docs/browser">Browser</DocLink>.
              </>
            ),
          },
          {
            term: "browserAllowedHosts",
            def: (
              <>
                Newline-separated host patterns limiting where the browser may navigate —{" "}
                <Code>mail.google.com</Code> is exactly that host, <Code>*.github.com</Code> the
                domain and every subdomain. Blank means unrestricted. Edited as{" "}
                <Strong>Allowed websites</Strong> under the Browser page&apos;s{" "}
                <Strong>Advanced</Strong>.
              </>
            ),
          },
          {
            term: "browserApprovalRequired",
            def: (
              <>
                When on, form submits queue an Approval a human must grant before the browser fires
                them — <Strong>Ask before submitting forms</Strong> on the Browser page. See{" "}
                <DocLink to="/docs/browser">Browser</DocLink>.
              </>
            ),
          },
        ]}
      />

      <H2 id="lifecycle">Lifecycle</H2>
      <OL>
        <LI>
          <Strong>Hire.</Strong> Write the company&apos;s Goal first, then choose{" "}
          <Strong>AI → Employees → Hire AI Employee</Strong> and answer one question,{" "}
          <Strong>What should they do?</Strong> Pick a role — Executive Assistant, Sales Development
          Rep, Customer Support, Research Analyst, Operations Coordinator, or Software Engineer — or
          open <Strong>More roles</Strong> for the rest, or type your own <Strong>Role</Strong>. A
          role comes with a starter Soul and Skill set. The <Strong>Name</Strong> is filled in from
          the role and you can change it; picking a different role swaps in its suggested name,
          unless you typed your own, and a name a teammate already has is flagged before you hire.
          Then press <Strong>Hire {"{name}"}</Strong>. Hiring does not schedule Routines. The slug
          freezes; you can rename freely afterward.
        </LI>
        <LI>
          <Strong>Attach a model.</Strong> If another AI Employee already runs on an API key or
          custom endpoint, hiring connects the new employee to a copy of that{" "}
          <DocLink to="/docs/models#reuse-model">AI Model</DocLink> automatically — nothing to
          paste — and the next screen says <Strong>Uses the same AI Model as</Strong> that
          employee, with a link to <Strong>Settings → Model</Strong> to change it. Otherwise the
          next screen connects one: Anthropic takes an API key; OpenAI takes an API key or eligible
          ChatGPT subscription access; Custom takes an OpenAI-compatible endpoint. If none is
          connected when you choose <Strong>Choose Routines</Strong> (<Strong>Continue</Strong> on
          the longer path below), the step says so and offers{" "}
          <Strong>Continue without a model</Strong>; connect one later from{" "}
          <Strong>Settings → Model</Strong>.
        </LI>
        <LI>
          <Strong>Write the Soul (optional).</Strong> Choose <Strong>Customize the Soul first</Strong>{" "}
          instead of <Strong>Hire {"{name}"}</Strong> to hire and then answer the short About
          questions and review the generated constitution before choosing Routines. A blank answer
          gets a sensible default, except <Strong>Reference material</Strong>: it starts empty,
          and the Soul has no reference section unless you add links. You can rewrite the Soul at
          any time under <Strong>Settings → Soul</Strong>.
        </LI>
        <LI>
          <Strong>Choose Routines.</Strong> Genosyn selects responsibilities that fit the saved role
          and uses the company Goal, with its mission and vision when written, to rank them and
          write their instructions. An edited
          role takes precedence over the starting template. Suggestions remain opt-in until you
          select them and choose the primary <Strong>Schedule N Routines and continue</Strong>,
          which creates them and advances in one press.
        </LI>
        <LI>
          <Strong>Connect the work.</Strong> Integration cards distinguish between Connect, Grant
          needed, Attention, and Ready. A Connection alone does not give the AI Employee access; it
          still needs an explicit Grant.
        </LI>
        <LI>
          <Strong>Grant access.</Strong> Press <Strong>Next: choose what {"{name}"} can reach</Strong>{" "}
          and the hire ends on the new employee&apos;s <Strong>Settings → Access</Strong>, with a
          note saying that is the next step — a new hire reaches nothing until it is granted
          something. Tick what the job needs and grant it in one go, or choose{" "}
          <Strong>Done — meet {"{name}"}</Strong> to go to Chat. See{" "}
          <DocLink to="/docs/employees#access">Access</DocLink>.
        </LI>
        <LI>
          <Strong>Fire.</Strong> Deleting an employee removes their DB rows, including the encrypted
          credential row for every model they held. There&apos;s no shared key to revoke.
        </LI>
      </OL>

      <Callout kind="tip" title="Routine suggestions appear after every hire.">
        The first-company guide opens them between the AI Employee and Email steps. The regular{" "}
        <Strong>AI → Employees → Hire AI Employee</Strong> flow opens it right after the AI Model
        (or after the Soul review, if you chose <Strong>Customize the Soul first</Strong>). Both
        use the same recommendation rules, and both can be skipped — in the guide with{" "}
        <Strong>Continue without adding them</Strong>. Suggestions never overwrite an existing
        Routine or create a duplicate; skipping creates no Routines, Connections, or Grants.
        Anything you do add starts running on its own schedule straight away. See{" "}
        <DocLink to="/docs/getting-started">Getting started</DocLink> for the full flow.
      </Callout>

      <H2 id="working-directory">Working directory</H2>
      <P>Each employee gets their own folder on disk under the company:</P>
      <pre className="mt-4 overflow-x-auto rounded-2xl border border-line bg-paper-raised px-5 py-4 font-mono text-[12.5px] leading-[1.7] text-ink-600">
        {`data/companies/<co-slug>/employees/<emp-slug>/
└── ...   # files enabled coding tools read and write`}
      </pre>
      <P>
        API-key and custom models use OpenCode. Ordinary employee work uses its native coding tools
        in the default host mode, including shell commands. They run directly on the host (inside
        the App container under Docker) with the App process user&apos;s filesystem and network
        authority; this directory is the starting location, not an OS sandbox. Disabled mode omits
        coding and employee repository materialization. Repository work sessions use their own
        worktrees and scoped tools. The runner captures the transcript into the Run log.
      </P>
      <P>
        A Routine does not make its AI Employee unavailable: Members can keep chatting with that
        employee and start independent Routines in parallel. Only two turns in one conversation are
        serialized. Concurrent work shares this directory when coding is enabled, so give
        overlapping Runs distinct output files and avoid simultaneous edits to the same git working
        tree.
      </P>
      <P>
        Model credentials stay encrypted in the database. Genosyn configures OpenCode in a temporary
        runtime directory outside the employee working directory. OpenAI subscription models use the
        official Codex app-server with a locked temporary <Code>CODEX_HOME</Code> for a login or
        Run. Managed ChatGPT sessions are materialized there; access tokens enter only the child
        process environment. Genosyn removes temporary authentication state afterward. Subscription
        auth works in host or disabled mode on a single App process.
      </P>

      <H2 id="surfaces">Surfaces inside the app</H2>
      <P>
        <Strong>AI → Employees</Strong> lists every AI Employee as a card with their name, role, and
        team. Open a card to reach that employee, or choose <Strong>New employee</Strong> to hire
        one. An employee with no connected AI Model — who can&apos;t answer a message or run a
        Routine yet — says <Strong>No AI Model connected</Strong> on their card, and their header
        carries the same warning as a link to <Strong>Settings → Model</Strong>.
      </P>
      <P>
        An AI Employee is two places: <Strong>Chat</Strong> and <Strong>Settings</Strong>. The
        switch between them sits at the top right of the employee&apos;s header, next to their name.
        Everything you configure or inspect about an employee lives under Settings. The rail keeps
        the everyday panes up front, grouped as <Strong>Employee</Strong> (General, Soul, Model),{" "}
        <Strong>Work</Strong> (links to this employee&apos;s Skills and Routines), and{" "}
        <Strong>Access</Strong> (Access, Connections, Autonomy). Everything you visit now and then sits
        under <Strong>Advanced</Strong>: Memory, Journal, Handoffs, Phone, MCP, Browser, and a link
        to Integrations. It starts closed and opens by itself whenever you are on one of those
        pages. Each page leads with its basics; anything rarely changed sits behind that
        page&apos;s own <Strong>Advanced</Strong>, whose closed line says what is set inside.
        Owners and admins change an employee&apos;s settings; other Members read them.
      </P>
      <P>
        <Strong>Group chat</Strong>, beside the switch, starts a group chat with this employee
        leading: pick the colleagues to join them, say what they should work out, and they discuss
        it together and come back with an outcome. See{" "}
        <DocLink to="/docs/collaboration">AI Employees working together</DocLink>.
      </P>
      <UL>
        <LI>
          <Strong>Chat.</Strong> Free-form conversations with the employee. Messages persist; action
          pills surface tool calls inline. Opening a chat or switching threads puts the cursor in
          the message box, after any draft already there, so you can start typing straight away (on
          a phone or tablet the box waits for a tap, so the keyboard does not cover the thread).
          Type <Code>/new</Code> to open a fresh context, or{" "}
          <Code>#</Code> and a name to tag a product area or any company resource you can see. Use
          <Code>@</Code> for people and AI Employees; <Code>#</Code> tells the employee what product
          or record to work on, and you can add several tags to one instruction. Attach files with
          the paperclip, or paste a screenshot and drag files onto the composer. When the employee
          creates a file for you, it appears beneath their reply; select the attachment chip to
          download it. During substantial multi-step work, the employee can replace the typing dots
          with a live activity card and update it at meaningful milestones. A new live turn keeps
          the quiet typing indicator until the employee reports real progress; after that, the card
          shows its current step and percentage. A restored turn stays indeterminate until its next
          real milestone, and the card distinguishes live updates from saved updates or a
          reconnecting browser. As soon as the reply begins, the progress card gives way to the
          response. Long turns can run for up to six hours. If the live connection drops, you reload
          the page, or the Genosyn server restarts, Genosyn follows the persisted turn automatically
          instead of marking it failed. After a server restart, a short renewable database lease
          lets one replacement worker resume the request safely from its saved context and latest
          milestone; it checks current state before continuing so completed side effects are not
          repeated. The final reply reappears in the same thread. You can keep writing while the
          employee works — follow-ups queue and send in order within that thread, while your other
          conversations with the same employee carry on answering in parallel. When the answer in
          flight has stopped being the one you want, choose <Strong>Interrupt &amp; send</Strong> on
          the queued message (or press <Code>⌘/Ctrl+Enter</Code> in the composer) and the employee
          puts down what it is doing so that message goes next. To stop without sending anything,
          select the <Strong>Stop</Strong> button that replaces Send while a reply runs and the box
          is empty; the cursor returns to the box for your correction. Either way, whatever it had
          already written stays in the thread, marked <Strong>interrupted</Strong>, and the next
          turn can see it. A
          stop lands as soon as the step already running hands back, so a long tool call can take a
          moment. Chat stays available while that employee&apos;s Routines run.
          <br />
          <br />
          Under the composer, next to the model picker, Genosyn shows{" "}
          <Strong>how full the model&apos;s context window is</Strong> — the share of it the last
          turn&apos;s prompt occupied. The number comes from the provider&apos;s own token count for
          that turn, never a local estimate, and it updates as the employee works. Hover it for the
          exact figures. Past 80% it turns amber: the runtime may need to compact history soon.
          OpenCode manages that compaction for API-key and custom models. You can also finish the
          conversation or type <Code>/new</Code> for a fresh context. If the AI Model has no known
          context window the badge shows the token count alone and links to the active
          model&apos;s card with its <Strong>Advanced</Strong> section open, where the window is
          set, because there is no ceiling to measure against — see{" "}
          <DocLink to="/docs/models#context-window">AI Models</DocLink>.
          <br />
          <br />
          An employee can inspect its current turn with <Code>get_runtime_diagnostics</Code>:
          the active runtime, latest measured context usage, configured step and command limits,
          observed retries and compactions, and whether a named tool is registered or deferred.
          Missing measurements stay unknown. Diagnostics expose no credentials or prompt content,
          and a registered tool still checks current Grants when called. They are available through
          tool discovery in ordinary conversations and Runs; confined work surfaces retain their
          own tool sets.
        </LI>
        <LI>
          <Strong>Settings → Soul.</Strong> The employee&apos;s constitution: who they are and how
          they work, read before every chat and Routine Run. Markdown, ⌘S to save.
        </LI>
        <LI>
          <Strong>Settings → Model.</Strong> The AI Models this employee thinks with, one card each:
          its status, <Strong>Test connection</Strong>, <Strong>Make active</Strong>, and its own{" "}
          <Strong>Advanced</Strong> section for its keys, model, endpoint or sign-in, context window,
          concurrent Runs and Remove. <Strong>Add an AI Model</Strong> sits under the cards — see{" "}
          <DocLink to="/docs/models#advanced">AI Models</DocLink>.
        </LI>
        <LI>
          <Strong>Settings → Advanced → Memory.</Strong> Durable facts and preferences injected
          into every conversation and routine run. Unlike the free-form Soul, each item is one
          short fact you can add, edit, or delete on its own.
        </LI>
        <LI>
          <Strong>Settings → Skills / Routines.</Strong> These are company-wide sections, not
          per-employee ones: they live at AI → <DocLink to="/docs/skills">Skills</DocLink> and AI →{" "}
          <DocLink to="/docs/routines">Routines</DocLink>. The two entries under Settings open those
          lists filtered to this employee, and are marked with a corner arrow to say so.
        </LI>
        <LI>
          <Strong>Settings → Advanced → Journal.</Strong> Append-only diary the employee writes
          about their own work via the built-in MCP server. Routine runs land here automatically,
          and the last seven days are injected into every chat and routine run. For the
          server&apos;s own account of
          the same work, rather than the employee&apos;s, see{" "}
          <DocLink to="/docs/employees#work-timeline">the work timeline</DocLink> below.
          {" "}Employee-written entries allow a title of 1–200 characters and a body of up to
          10,000 characters. Keep summaries compact and link to existing detailed records;
          the tool advertises these limits before the employee writes an entry. You can add an
          entry yourself too: press Enter in its title, or <Code>⌘/Ctrl+Enter</Code> in its detail
          box. <Strong>Settings → Advanced → Memory</Strong> works the same way.
        </LI>
        <LI>
          <Strong>Settings → Advanced → Handoffs.</Strong> Work this employee has delegated to
          another, and work delegated to them. Creating a Handoff starts the receiver working
          immediately in a
          background session (when they have a connected model) — delegation is a &quot;go&quot;
          signal, not a note on a desk. A Handoff always names the employee who receives it. A
          pending Handoff past its due date escalates: the company&apos;s owners and admins get a
          bell, once. In a brief or a <Strong>Complete</Strong> / <Strong>Decline</Strong> note,{" "}
          <Code>⌘/Ctrl+Enter</Code> submits it.
        </LI>
        <LI>
          <Strong>Settings → Access.</Strong> Everything the company has that this employee could
          be granted, what it holds of each, and a way to grant, change or revoke many at once —
          see <DocLink to="/docs/employees#access">Access</DocLink> below.
        </LI>
        <LI>
          <Strong>Settings → Connections.</Strong> The{" "}
          <DocLink to="/docs/integrations">Connection Grants</DocLink> this employee holds, with
          each account&apos;s status.
        </LI>
        <LI>
          <Strong>Settings → Autonomy.</Strong> <Strong>Stand down</Strong> first — a revocable
          stop on everything they do, kept one click away (see{" "}
          <DocLink to="/docs/standdowns">Standdowns</DocLink>) — then the{" "}
          <DocLink to="/docs/autonomy">earned-autonomy</DocLink> record and this employee&apos;s
          Wakeups.
        </LI>
        <LI>
          <Strong>Settings → Advanced → Phone.</Strong> The Twilio numbers given to this employee,
          and their texts and calls — see <DocLink to="/docs/phone-numbers">Phone numbers</DocLink>.
        </LI>
        <LI>
          <Strong>Settings → Advanced → MCP.</Strong> Extra Model Context Protocol servers this
          employee can use, plus the external endpoint that lets another MCP client reach Genosyn
          as this employee.
        </LI>
        <LI>
          <Strong>Settings → Advanced → Browser.</Strong> Whether this employee may use a browser;
          the allowed websites and <Strong>Ask before submitting forms</Strong> sit under its{" "}
          <Strong>Advanced</Strong> — see <DocLink to="/docs/browser">Browser</DocLink>.
        </LI>
        <LI>
          <Strong>Settings → General.</Strong> Name and role, profile picture, team — and, at the
          bottom, deleting the employee. The slug (the last part of the employee&apos;s address)
          sits under <Strong>Advanced</Strong> in Basics.
        </LI>
      </UL>

      <Callout kind="info" title="Models are employee-owned, on purpose.">
        Each employee owns their own provider credentials, stored encrypted (AES-256-GCM) in the
        database — even when they register several models, every API key, endpoint credential, or
        OpenAI subscription credential belongs to that one employee. There&apos;s no shared
        company-wide model credential: when a new hire{" "}
        <DocLink to="/docs/models#reuse-model">reuses the company&apos;s AI Model</DocLink>,
        Genosyn copies the encrypted credential onto them on the server, and the copy is a row of
        its own. Firing an employee deletes all of their encrypted credential rows and leaves
        everyone else&apos;s copies working; rotate the key at the provider to change it for
        everyone who holds one.
      </Callout>

      <H2 id="access">Access</H2>
      <P>
        An AI Employee reaches only what it has been granted. <Strong>Settings → Access</Strong>{" "}
        lists everything the company has that it could be granted, grouped by kind —{" "}
        <Strong>Connections</Strong>, <Strong>Mailboxes</Strong>, <Strong>Calendars</Strong>,{" "}
        <Strong>Repositories</Strong>, <Strong>Notes and notebooks</Strong>, <Strong>Bases</Strong>,{" "}
        <Strong>Charts and dashboards</Strong>, <Strong>Resources</Strong> (the library-wide level
        and each Resource), <Strong>Vault items</Strong>, <Strong>Member browsers</Strong>,{" "}
        <Strong>Routines</Strong>, and the <Strong>Company sections</Strong>: Finance, Revenue,
        Marketing, Recruiting and Document signing. Kinds the company has none of yet share one line
        at the end, linking to where to add them. Every row links to the thing itself and says what
        the employee holds:
      </P>
      <KeyList
        rows={[
          { term: "A level", def: "The Grant and its level, in the words of its own section — Draft, Can edit, Invoicing." },
          {
            term: "· default",
            def: "Routines and the Resources library: every AI Employee holds Read + write until someone narrows it.",
          },
          {
            term: "via notebook / via note",
            def: "A page reached through its notebook's Grant or a parent page's, which covers every page beneath it.",
          },
          { term: "No access", def: "Nothing reaches it." },
          {
            term: "Not shown to you",
            def: "You may not see who holds this one: Finance without Finance access, a Vault item you cannot share, another Member's browser.",
          },
        ]}
      />
      <P>
        Search finds a row by its name, its second line or its kind; <Strong>Has access</Strong> and{" "}
        <Strong>No access</Strong> split the list; <Strong>Every kind</Strong> narrows it to one
        group. Each kind lists its first 250 rows plus every one the employee holds; a search reaches
        the rest.
      </P>
      <P>
        Tick rows of any kinds — a group&apos;s own box ticks all of it, and{" "}
        <Strong>Select all … shown</Strong> ticks everything the filters show — then choose{" "}
        <Strong>Grant</Strong>, <Strong>Change level</Strong> or <Strong>Revoke</Strong> from the bar
        at the bottom. The confirmation says, kind by kind, what will happen. A Grant starts each
        kind at its own default level (a mailbox at Draft, a note at Can edit, Finance at Read only);
        open <Strong>Advanced</Strong> to choose another. Rows already as asked are left alone and
        audit nothing, so asking twice changes nothing.
      </P>
      <Callout kind="info" title="Every Grant still follows its own section's rules.">
        Each change is made through the same route as the section&apos;s own AI access panel, with
        your own sign-in, so it is decided and audited exactly as it would be there. Only owners
        and admins grant Connections, mailboxes, calendars, Repositories, Routines, the Resources
        library and the company sections; any Member grants notes, Bases, charts and Resources. A
        Vault item is shared by whoever added it, or an owner or admin. A{" "}
        <DocLink to="/docs/member-browsers">Member browser</DocLink> runs on a person&apos;s own
        computer, so only that person can grant it — everyone else sees it locked, with that reason.
        A row you cannot change says why, its box stays disabled, and if a change is refused anyway
        the confirmation names that row and the reason while the rest go through. API keys and
        connected apps cannot list or change Connections, Repositories, Vault items or Member
        browsers. No AI Employee can reach this page or grant itself anything.
      </Callout>
      <P>
        The first-company guide has an <Strong>Access</Strong> step after Email with the same list,
        and its summary counts the Grants. Press <Code>⌘K</Code> and type <Strong>access</Strong>{" "}
        (or an employee&apos;s name and <Strong>access</Strong>) to jump to any employee&apos;s
        page. The sections&apos; own panels — a mailbox&apos;s AI access, a note&apos;s Share,
        Finance → AI access — keep working and show the same Grants.
      </P>

      <H2 id="work-timeline">The work timeline</H2>
      <P>
        Your <DocLink to="/docs">Home page</DocLink> keeps a compact{" "}
        <Strong>bubble for each AI Employee</Strong> to the right of your greeting. The bubbles form
        a small horizontal row in the header, leaving the cards below the full width of the page. On
        a narrow screen, they stay beside the greeting. Scroll the row sideways when the whole team
        does not fit. Their status distinguishes
        <Strong> Working now</Strong>, <Strong>Waiting for input</Strong>, recent work, and a quiet
        day. Work details stay hidden until you choose an employee.
      </P>
      <P>
        Choose a bubble to open the employee&apos;s <Strong>Routine Runs</Strong> and{" "}
        <Strong>work timeline</Strong> in a popup. The Runs list shows Routines working now
        and any pending work, including when a retry or continuation is waiting until later or a
        Standdown is stopping the work. Pending Runs are listed in the order they will start, each
        with its place in the company&apos;s queue — <Strong>Next up</Strong>, <Strong>#2</Strong>,
        … — and a <DocLink to="/docs/routines#priority">High priority</DocLink> Routine carries a{" "}
        <Strong>High</Strong> mark. An AI Employee can run multiple Routines together, and the
        list updates as work starts and finishes. It always shows current work, even while you
        browse an earlier day below. A long pending list starts with five Routines; expand it to see
        more.
      </P>
      <P>
        The calendar opens on today, with the clock down the left and recorded work arranged through
        the day, like a calendar&apos;s day view. Each entry says what happened and shows its
        result, and work happening in the same hour stays readable as separate entries. Use{" "}
        <Strong>Previous day</Strong> and <Strong>Next day</Strong>, or choose a date with{" "}
        <Strong>Work day</Strong>, to browse today and the previous six days. Choose{" "}
        <Strong>Today</Strong> to return to the current day. Dates and times follow your
        browser&apos;s local time, with the timezone shown above the calendar. Choose{" "}
        <Strong>Go to first work</Strong> to skip the empty hours before the day&apos;s first entry.
      </P>
      <P>Everything you need to follow up stays close to the work:</P>
      <UL>
        <LI>
          <Strong>Read a Routine Run&apos;s summary</Strong> beside its time, such as &quot;Created
          five overdue invoices and sent three payment reminders. Two invoices need your
          review.&quot; Its status, outcome and Check badges remain visible. Tool calls, Connection
          counts and individual changes stay in the run log.
        </LI>
        <LI>
          <Strong>Check in</Strong> opens the employee&apos;s Chat, and{" "}
          <Strong>Employee details</Strong> opens their Settings. Close the popup to return to Home.
        </LI>
      </UL>
      <P>The timeline includes:</P>
      <UL>
        <LI>
          <Strong>Routine runs</Strong> show a concise outcome in the employee&apos;s day. If no
          outcome summary was recorded, the entry says so; an active Run says it is still working.
          The status, outcome and checks badges from <DocLink to="/docs/routines">Routines</DocLink>{" "}
          remain visible. Choose <Strong>Open the run log</Strong> for the full report, tool calls
          and <DocLink to="/docs/verification#effects">Effects</DocLink>, without leaving Home.
        </LI>
        <LI>
          <Strong>Conversations.</Strong> One line per thread, saying how many times the employee
          replied. A reply still in flight is shown as current work, including its latest progress
          label and percentage for the Member who started it. A thread you did not start is reported
          without its subject or progress — transcripts stay private to the Member who asked for
          them.
        </LI>
        <LI>
          <Strong>Repository work</Strong>, with the files, insertions and deletions each turn
          produced — see <DocLink to="/docs/repositories">Repositories</DocLink>.
        </LI>
        <LI>
          <Strong>Approvals required by actions they attempted</Strong>, so an employee waiting at a
          system gate is visible rather than only as a queue entry.
        </LI>
        <LI>
          <Strong>Wakeups</Strong> that fired and <Strong>Lessons</Strong> taken from a graded run —
          see <DocLink to="/docs/reactivity">Reactivity</DocLink> and{" "}
          <DocLink to="/docs/improvement">Improvement</DocLink>.
        </LI>
        <LI>
          <Strong>Changes</Strong> — the individual records an employee created, edited or sent.
          Changes made inside a Run stay with its run log. Conversation changes appear under their
          conversation; changes with no parent stand on their own. An Email handover names the
          people and mailbox it came from, says whether a Member or an Email rule started it, and
          links back to the original thread.
        </LI>
        <LI>
          <Strong>Email analysis</Strong> entries explain an incoming email review: the AI Employee
          reads the message, classifies it, summarises it and suggests next steps. The card names
          the email and mailbox, links to the conversation, and shows the recorded category,
          summary and suggested actions when available. Suggestions are not completed actions.
          A failed review shows its recorded reason; the card says when result details are
          unavailable. Reviewing the same email again never replaces an earlier card&apos;s
          result with the newer review.
        </LI>
      </UL>
      <P>
        The roster stays visible even when the whole team is quiet, because it is also the quickest
        way to reach an employee and check in, and an employee&apos;s own day says plainly when
        there is nothing recorded for the selected date. A busy employee cannot crowd another
        employee&apos;s status out of the roster: the circles use a per-employee summary the server
        calculates before any display limit is applied, and opening one employee&apos;s day asks for
        that employee and date alone. Work still running — and an unresolved Approval still waiting
        — remains in the current status even when it began before the recent-work window. The day
        view stays bounded to the selected date and says when there is more recorded work than it
        can display.
      </P>
      <Callout kind="info" title="An outcome summary is a report; Checks and verdicts assess it.">
        A Run&apos;s summary comes from its recorded final report, or the outcome assessment when a
        final report is unavailable. The employee&apos;s report does not prove the work succeeded:
        read the independent <DocLink to="/docs/verification">Checks and verdicts</DocLink> beside
        it, and open the run log for evidence. Timeline entries still come from recorded work;
        writing a Journal entry does not create one. The work timeline is available to every
        Member. The <DocLink to="/docs/security#audit-log">audit log</DocLink> is the separate admin
        tool for investigating every actor across all of history.
      </Callout>
    </>
  );
}
