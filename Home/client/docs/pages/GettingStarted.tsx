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

export function GettingStarted() {
  return (
    <>
      <PageHeader
        eyebrow="Get started"
        title="Onboard your first AI Employee"
        lead={
          <>
            A new Genosyn account opens a five-step first-run guide at{" "}
            <Code>/c/&lt;company-slug&gt;/onboarding</Code>: it explains what an AI Employee is,
            hires one, connects the AI Model it thinks with, turns the best recurring work into
            Routines, offers mailbox access, and ends on a summary of what is now running.
          </>
        }
      />

      <H2 id="company">Name your company</H2>
      <P>
        Signup lands on <Strong>Name your company</Strong> — &quot;Genosyn runs a company with AI
        Employees working alongside your team. First, the company they will work for — we explain
        the rest on the next screen.&quot; Fill in <Strong>Company name</Strong>, and optionally{" "}
        <Strong>Mission (optional)</Strong> and <Strong>Vision (optional)</Strong>, then choose{" "}
        <Strong>Create company and continue</Strong>.
      </P>
      <P>
        The mission field carries a hint explaining why it is worth writing: it is used to pick the
        recurring work Genosyn suggests for your first AI Employee. Both fields are optional and can
        be written later — from the launch plan step itself, or from{" "}
        <Strong>Settings → Company</Strong>.
      </P>
      <P>
        Genosyn creates the company, adds you as its owner, and opens the guide automatically. The
        company is the home for its human Members, AI Employees, Connections, and work. To create
        another one later, open the company picker in the top bar and select{" "}
        <Strong>+ New company</Strong>.
      </P>

      <H2 id="the-guide">The five steps</H2>
      <P>
        The guide is headed <Strong>Set up your first AI Employee</Strong> and shows a rail of five
        steps, each with a one-line hint. On a narrow screen the rail collapses to{" "}
        <Strong>Step N of 5</Strong> and the step name. Completed steps stay clickable, so going
        back to change something is always allowed — every step re-reads its state from the server
        rather than trusting what the guide thinks it did.
      </P>
      <KeyList
        rows={[
          { term: "How it works", def: "What an AI Employee is." },
          { term: "AI Employee", def: "Hire one and connect a model." },
          { term: "Launch plan", def: "Recurring work for the role." },
          { term: "Email", def: "Optional mailbox access." },
          { term: "First request", def: "Watch them work." },
        ]}
      />
      <P>
        Steps 1 to 4 run in order and end on a summary headed <Strong>You are set up</Strong>. The
        first request is reached from that summary rather than before it, and its back button reads{" "}
        <Strong>Back to summary</Strong>.
      </P>

      <H2 id="how-it-works">Step 1 — How it works</H2>
      <P>
        The guide explains the product before asking you to configure it. This step defines every
        word the rest of the flow leans on, at first use: <DocLink to="/docs/soul">Soul</DocLink>{" "}
        (their written constitution), <DocLink to="/docs/skills">Skills</DocLink> (markdown
        playbooks, one per piece of work they know how to do), and{" "}
        <DocLink to="/docs/routines">Routines</DocLink> (work that runs on a schedule instead of
        waiting to be asked, where each firing becomes a Run you can read line by line).
      </P>
      <Callout kind="warn" title="You bring the AI Model.">
        Genosyn does not include one. Each AI Employee runs on an{" "}
        <DocLink to="/docs/models">AI Model</DocLink> you register — an Anthropic or OpenAI API key,
        billed by them and not by Genosyn, or any OpenAI-compatible endpoint you point it at. It is
        worth having a key ready before you start.
      </Callout>
      <Callout kind="info" title="You stay in control.">
        An AI Employee can only reach what you hand it. A <Strong>Connection</Strong> is one account
        your company has linked; a <Strong>Grant</Strong> is one employee&apos;s access to one
        Connection. Email starts at draft-only — they can triage and write replies, you press send.
        You can also gate any Routine so a human approves it before it acts.
      </Callout>
      <P>
        <Strong>How a working day goes</Strong> walks the same loop the product actually runs: a
        Routine comes due on its schedule; the AI Employee reads its Soul and the Skills for that
        job; it does the work using only the Connections you granted it; it writes up the Run — and
        if you gated that Routine, it waits for your approval before acting.
      </P>
      <P>
        The step closes with a preview of what is left — hire an AI Employee and connect an AI
        Model, review their launch plan, connect a mailbox, give them a first request — and the button{" "}
        <Strong>Hire my first AI Employee</Strong>.
      </P>

      <H2 id="employee">Step 2 — AI Employee</H2>
      <OL>
        <LI>
          Pick a starting role under <Strong>Who should join the team?</Strong> — Executive
          Assistant, Sales Development Rep, Research Analyst, or Operations Coordinator. Each card
          names the Skills and the Routines that template ships with, and states each schedule in
          plain English, so both words are taught by example.
        </LI>
        <LI>
          Review <Strong>Name</Strong> and <Strong>Role</Strong>, then choose{" "}
          <Strong>Hire AI Employee</Strong>. Selecting a template fills these in but never
          overwrites a name you already typed.
        </LI>
        <LI>
          Connect an <DocLink to="/docs/models">AI Model</DocLink> in the panel that follows. It
          links straight out to <Strong>Get an Anthropic key</Strong> and{" "}
          <Strong>Get an OpenAI key</Strong>. The key is encrypted before it is stored, and this one
          model powers both chat and every Routine.
        </LI>
        <LI>
          Choose <Strong>Build the launch plan</Strong>. Genosyn checks for an active, connected
          model before advancing.
        </LI>
      </OL>
      <Callout kind="info" title="You can continue without a model.">
        If the check finds none, the guide says <Strong>No AI Model is connected yet</Strong> and
        offers <Strong>Continue without a model</Strong> as a real button beside the primary action.
        Until a model is connected, the AI Employee cannot answer a request or run a Routine. A
        failed request is reported as an error with <Strong>Try again</Strong> instead of an empty
        role picker.
      </Callout>

      <H2 id="launch-plan">Step 3 — Launch plan</H2>
      <P>
        The <Strong>Launch plan</Strong> is the same surface you get after hiring anyone from{" "}
        <Strong>AI → Employees</Strong>. Genosyn combines the employee&apos;s role, chosen template,
        and the company mission and vision to recommend useful first work. The same inputs always
        produce a stable plan, so refreshing or returning to the guide does not reshuffle it.
      </P>
      <P>
        If mission or vision is missing, the plan opens with{" "}
        <Strong>Give the recommendations your company&apos;s direction</Strong>. Fill either field
        and choose <Strong>Save and refresh plan</Strong> to rebuild the suggestions against real
        context.
      </P>

      <H3 id="suggested-routines">Suggested Routines</H3>
      <P>
        Each card is a checkbox tile with its schedule in plain English and one of three states:
      </P>
      <UL>
        <LI>
          <Strong>Scheduled</Strong> — the Routine came with the role and is already running. It
          stays in the plan so you can see what is live, and it cannot be selected again.
        </LI>
        <LI>
          <Strong>Suggested</Strong> — not added yet. Select up to five at a time.
        </LI>
        <LI>
          <Strong>Selected</Strong> — chosen, and waiting to be created.
        </LI>
      </UL>
      <P>
        A note above the list is explicit about what selecting means: anything you add starts
        running on its own schedule straight away, using the AI Employee&apos;s AI Model and so the
        credit on the key you registered, and any of them can be turned off at any time from{" "}
        <DocLink to="/docs/routines">Routines</DocLink>. Two controls create them:
      </P>
      <UL>
        <LI>
          <Strong>Add selected Routines</Strong> — inside that note. Creates the selection and stays
          on the step, so you can keep working through the Integrations below.
        </LI>
        <LI>
          <Strong>Schedule N Routines and continue</Strong> — the primary button, which creates the
          selection and then advances. With nothing selected it reads{" "}
          <Strong>Continue to email</Strong> instead. If the write fails you stay on the step with
          the error rather than moving past it.
        </LI>
      </UL>
      <P>
        When something is selected, <Strong>Continue without adding them</Strong> appears beside the
        primary button as the way to move on and create nothing. Either way, Genosyn confirms with{" "}
        <Strong>N Routines are now scheduled for {"{name}"}</Strong> and re-checks the employee
        before creating the batch: it never overwrites an edited Routine, and a matching name or
        slug comes back as already scheduled rather than being duplicated.
      </P>

      <H3 id="recommended-integrations">Recommended Integrations</H3>
      <P>
        The plan also recommends enabled <DocLink to="/docs/integrations">Integrations</DocLink>{" "}
        that fit the work, and defines the three words in one sentence: an{" "}
        <Strong>Integration</Strong> is a connector type; a <Strong>Connection</Strong> is one
        account your company links through it; a <Strong>Grant</Strong> is this employee&apos;s
        access to that one Connection. A recommendation never creates access by itself — its status
        tells you the next safe action:
      </P>
      <UL>
        <LI>
          <Strong>Connect</Strong> — the company has no Connection for this Integration yet.
        </LI>
        <LI>
          <Strong>Grant needed</Strong> — a healthy company Connection exists, but this employee
          does not have a Grant to it.
        </LI>
        <LI>
          <Strong>Attention</Strong> — a Connection exists, but it must be repaired or reconnected
          before the employee can use it.
        </LI>
        <LI>
          <Strong>Ready</Strong> — the employee already has a Grant to a healthy Connection.
        </LI>
      </UL>
      <Callout kind="info" title="Recommendations do not widen access.">
        Connecting one account does not silently grant it, and granting one Connection does not
        expose the rest of the Integration catalog. Review every credential and Grant before moving
        on. All of it is optional at this point.
      </Callout>

      <H2 id="gmail">Step 4 — Connect email</H2>
      <P>
        Type the address of the mailbox you want the employee to work. Genosyn works out the rest
        from the domain — Gmail, Outlook, Fastmail, iCloud, Zoho, a company Exchange server, or a
        mail server you run yourself. What you see depends on what already exists:
      </P>
      <UL>
        <LI>
          A mailbox already connected with no Grant for this employee offers{" "}
          <Strong>Grant draft access</Strong>.
        </LI>
        <LI>
          Otherwise, one field. Press Continue and finish however that address wants to be
          finished: a <Strong>Continue with Google</Strong> button for a Google address on an
          install whose admin has registered a Google app, or a password field with the servers
          already filled in for everything else. Connecting here also grants the employee draft
          access in the same step.
        </LI>
      </UL>
      <P>
        A note names all three access levels: <Strong>Read</Strong> browses threads;{" "}
        <Strong>Draft</Strong> — what this step grants — also writes replies, applies labels,
        archives, and marks read, so the employee can clear an inbox and leave a finished reply in
        the thread while a human presses Send; <Strong>Send</Strong> is never granted here. Change
        the level any time at <Strong>Email → Settings → AI access</Strong>. See{" "}
        <DocLink to="/docs/email">Email</DocLink>.
      </P>
      <Callout kind="info" title="Email is optional.">
        Nothing else in the guide depends on it — choose <Strong>Skip email for now</Strong> and
        connect a mailbox later from the <Strong>Email</Strong> section. Most providers want an{" "}
        <Strong>app password</Strong> rather than your sign-in password, and Genosyn says which and
        links to the page that issues it; see <DocLink to="/docs/email">Email</DocLink>. The primary
        button reads <Strong>Finish setup</Strong> once a mailbox is ready, and{" "}
        <Strong>Continue</Strong> otherwise.
      </Callout>

      <H2 id="summary">You are set up</H2>
      <P>
        The guide ends on a summary rather than dropping you into a chat box. It reads the
        company&apos;s onboarding status back from the server — derived from real state, never a
        stored flag — so it reports what is genuinely true. Under <Strong>What is set up</Strong> it
        confirms four things:
      </P>
      <UL>
        <LI>
          The AI Employee and their role, with a count of the Skills they arrived with. Hiring
          without a template creates none, and the row says so rather than claiming otherwise.
        </LI>
        <LI>
          <Strong>AI Model</Strong> — connected, or not connected yet with a link to connect one.
          When it is missing, the heading also warns that scheduled Runs will be skipped until it is
          there.
        </LI>
        <LI>
          <Strong>N Routines scheduled</Strong> — counting only the ones that will actually fire,
          with the time of the next Run and a link to turn any of them off.
        </LI>
        <LI>
          <Strong>Email access</Strong> — the level actually granted (read, draft, or send), or a
          pointer to add a mailbox later.
        </LI>
      </UL>
      <P>
        <Strong>Where everything lives</Strong> then links the three places this work continues:{" "}
        <Strong>AI → AI Employees</Strong> to read and edit the Soul and Skills,{" "}
        <Strong>AI → Routines</Strong> for every schedule, its on/off switch, and the transcript of
        each Run, and <Strong>Approvals</Strong> for the work you have gated. The two exits are{" "}
        <Strong>Go to Home</Strong> and <Strong>Give {"{name}"} a first request</Strong>.
      </P>

      <H2 id="first-request">Step 5 — First request</H2>
      <P>
        Pick a starter request or write your own. Genosyn opens the AI Employee&apos;s chat with
        that request filled in, but does not send it — review it, add company context, and send when
        ready. Every example asks the employee to check with you before creating or sending
        anything.
      </P>
      <UL>
        <LI>
          <Strong>Create a Routine</Strong> — turn a recurring responsibility into scheduled work.
          The employee asks about the outcome, inputs, and time before creating anything.
        </LI>
        <LI>
          <Strong>Find potential Contacts</Strong> — define an ideal profile, then research a
          focused list. It never invents contact details and sends no outreach.
        </LI>
        <LI>
          <Strong>Triage my inbox</Strong> — group unread mail into needs a reply, needs a decision,
          and FYI, and draft replies without sending.
        </LI>
        <LI>
          <Strong>Plan your first week</Strong> — turn the role and Soul into concrete outcomes and
          the work that should become a Routine.
        </LI>
      </UL>
      <P>
        <Strong>Or write your own</Strong> takes any text and <Strong>Open chat</Strong> carries it
        across. <Strong>Back to summary</Strong> returns to the completed-setup screen.
      </P>

      <H2 id="return">Leave and come back</H2>
      <P>
        Every step after the first is skippable, and leaving is not a one-way door. While setup is
        unfinished, Home shows a <Strong>Finish setting up {"{name}"}</Strong> banner — or, before
        anyone is hired, that the company has no AI Employees yet — with{" "}
        <Strong>Finish setup</Strong> or <Strong>Open the guide</Strong> leading back to the right
        step. Because the status is derived from the company&apos;s real state (an AI Employee with
        a connected AI Model), the banner disappears by itself when setup is finished outside the
        guide.
      </P>
      <P>
        You can also open <Code>/c/&lt;company-slug&gt;/onboarding</Code> directly. The URL keeps
        the current step and employee, and each step re-checks the employee&apos;s Routines,
        Connections, mailbox, and Grants so completed setup is never repeated.
      </P>
      <P>
        When hiring from <Strong>AI → Employees</Strong> instead, the same Launch plan appears after
        the Soul review and can be skipped the same way. Skipping creates no Routines, Connections,
        or Grants. All of that work can be done later from <Strong>AI → Routines</Strong>, the
        employee&apos;s <Strong>Settings → Connections</Strong>, and{" "}
        <Strong>Settings → Integrations</Strong>. See{" "}
        <DocLink to="/docs/employees">AI Employees</DocLink> for the full lifecycle.
      </P>
    </>
  );
}
