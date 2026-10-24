import { Callout, Code, DocLink, H2, LI, OL, P, PageHeader, Strong, UL } from "@/docs/Prose";

export function GettingStarted() {
  return (
    <>
      <PageHeader
        eyebrow="Get started"
        title="Set up your company"
        lead={
          <>
            Start with one Goal: a direction and a number. Then hire an AI Employee, connect an AI
            Model, and choose useful recurring work. Email is optional.
          </>
        }
      />

      <H2 id="company">1. Write your company&apos;s Goal</H2>
      <P>
        After signup, fill in <Strong>Company name</Strong> and <Strong>Your Goal</Strong>, then
        choose <Strong>Create company and continue</Strong>. A{" "}
        <DocLink to="/docs/goals">Goal</DocLink> is one sentence with a number in it. For example,
        &quot;Reach 50 paying customers by March.&quot; Every AI Employee you hire reads it before
        they work.
      </P>
      <P>Once you type a sentence, three details appear beneath it, filled in from your words:</P>
      <UL>
        <LI>
          <Strong>Target:</Strong> the first number in the sentence. <Code>50</Code>,{" "}
          <Code>2,000</Code>, <Code>$2M</Code>, <Code>10k</Code> and <Code>40%</Code> are all read,
          and a date such as 2026 is not mistaken for it. If there is no number, type one.
        </LI>
        <LI>
          <Strong>Direction:</Strong> <Strong>Increase to target</Strong>, unless the sentence says
          reduce, cut, lower, decrease, drive down, below, under, fewer or less, which makes it{" "}
          <Strong>Decrease to target</Strong>.
        </LI>
        <LI>
          <Strong>Unit:</Strong> what the number counts: <Code>$</Code>, <Code>%</Code>, or the noun
          after it, such as <Code>paying customers</Code>.
        </LI>
      </UL>
      <P>
        Change any of them if they look wrong, and Genosyn stops overwriting that one as you keep
        typing. They are details, not extra questions: only the sentence and the target are needed.
        The Goal is created with your company as an active, top-level Goal whose progress you or an
        AI Employee report by hand. It has no deadline and no owner until you add one on the{" "}
        <DocLink to="/docs/goals">Goals</DocLink> page.
      </P>
      <P>
        <Strong>Add a mission and vision (optional)</Strong> opens two boxes under the Goal. A
        sentence for each helps Genosyn suggest fitting work, but neither is required:
      </P>
      <UL>
        <LI>
          <Strong>Mission:</Strong> what you do, for whom, and why it matters. For example,
          &quot;Help small shops keep accurate stock without spending their evenings on admin.&quot;
        </LI>
        <LI>
          <Strong>Vision:</Strong> the future you want to build. For example, &quot;Every
          independent shop can run as confidently as a national retailer.&quot;
        </LI>
      </UL>
      <P>
        A Goal is required before hiring an AI Employee. A company set up earlier with a mission and
        a vision already has direction and is not asked again. If you created a company without
        either, the guide opens <Strong>What is your company&apos;s Goal?</Strong> first, with the
        cursor in the Goal box. Write the sentence and choose <Strong>Save and continue</Strong>.
        When the company already has a Goal, this step shows it instead, with{" "}
        <Strong>Edit in Goals</Strong>. You can add a mission and vision, or refine them, any time
        in <Strong>Settings → Company</Strong>.
      </P>
      <P>
        The company is home to its Members, AI Employees, Connections, and work. To create another
        one later, open the company picker and choose <Strong>+ New company</Strong>.
      </P>
      <P>
        A new company starts in your browser&apos;s time zone, and Routine schedules follow it:
        &ldquo;every morning at 8&rdquo; means 8:00 AM there. Change it in{" "}
        <Strong>Settings → Company → Time zone</Strong>. See{" "}
        <DocLink to="/docs/routines#time-zone">Routines</DocLink> for what it covers.
      </P>

      <H2 id="the-guide">The setup guide</H2>
      <P>
        The guide shows five steps: <Strong>Company</Strong>, <Strong>AI Employee</Strong>,{" "}
        <Strong>Routines</Strong>, <Strong>Email</Strong>, and <Strong>Access</Strong>. Your Goal is
        already saved when you
        arrive from signup, so you can move straight to hiring. You can return to earlier steps to
        make changes.
      </P>

      <H2 id="employee">2. Hire and connect an AI Employee</H2>
      <OL>
        <LI>
          Under <Strong>Hire your first AI Employee</Strong>, pick a starting role or enter your own{" "}
          <Strong>Name</Strong> and <Strong>Role</Strong>. Starting roles include Executive
          Assistant, Sales Development Rep, Research Analyst, and Operations Coordinator. Picking a
          different role swaps in its suggested name too, unless you typed your own.
        </LI>
        <LI>
          Choose <Strong>Hire AI Employee</Strong>. A role template provides a{" "}
          <DocLink to="/docs/soul">Soul</DocLink> — their written constitution — and{" "}
          <DocLink to="/docs/skills">Skills</DocLink> describing how to do the work. Hiring does not
          automatically schedule Routines.
        </LI>
        <LI>
          Connect an <DocLink to="/docs/models">AI Model</DocLink>. Need a key? The link under the{" "}
          <Strong>API key</Strong> field opens the key page for the service you selected. Genosyn
          discovers the models available to the connected account and selects a suitable default.
          You can review the choice. Connecting automatically tests a real response so an invalid
          key, unavailable model, or unusable account is reported immediately.
        </LI>
        <LI>
          When the model is ready, choose <Strong>Choose Routines</Strong>.
        </LI>
      </OL>
      <P>
        Genosyn supports Claude through an Anthropic API key, OpenAI API keys, and custom
        OpenAI-compatible endpoints. Eligible ChatGPT subscription access is also available for
        OpenAI. Credentials are encrypted when stored. See{" "}
        <DocLink to="/docs/models">AI Models</DocLink> for the available connection methods.
      </P>
      <Callout kind="info" title="You can connect a model later.">
        Choose <Strong>Continue without a model</Strong> if you are not ready yet. The AI Employee
        can answer requests and run Routines once an AI Model is connected.
      </Callout>

      <H2 id="launch-plan">3. Choose Routines that move your Goal</H2>
      <P>
        A <DocLink to="/docs/routines">Routine</DocLink> is work an AI Employee does on a schedule.
        Genosyn suggests responsibilities that fit their saved role, then uses your company Goal,
        and your mission and vision if you wrote them, to prioritize them. Changing the role changes
        the suggestions; a company focused on sales does not turn a Software Engineer into a
        salesperson.
      </P>
      <P>
        Every suggested Routine quotes your Goal (and any mission and vision) in its instructions,
        along with its outcome, inputs, and schedule. An unusual role gets general planning and
        review suggestions scoped to that employee&apos;s responsibilities. If you did not write a
        mission and vision, <Strong>Add a mission and vision (optional)</Strong> on this screen adds
        them and refreshes the suggestions.
      </P>
      <OL>
        <LI>
          Review the suggested Routines and their schedules. Select only the recurring work you want
          to start; the counter shows how many you have selected.
        </LI>
        <LI>
          Choose <Strong>Schedule N Routines and continue</Strong> to create your selections and
          move on.
        </LI>
        <LI>
          To leave recurring work for later, choose <Strong>Continue without adding them</Strong>
          when a selection is active, or <Strong>Continue to email</Strong> with nothing selected.
        </LI>
      </OL>
      <P>
        This step creates only the Routines you select. They start on their displayed schedules and
        use your AI Model. A Routine already added is marked <Strong>Scheduled</Strong> and cannot
        be duplicated. You can read each Run and change or disable schedules in{" "}
        <Strong>AI → Routines</Strong>.
      </P>
      <P>
        Each of these Routines is graded. It comes with a short, checkable definition of done, its{" "}
        <Strong>acceptance criteria</Strong>, and every completed Run is checked against it. A
        company that is brand new has little to report on yet, so a Run that says its inputs were
        missing or empty meets the bar. Read or change the criteria under{" "}
        <Strong>Settings → What counts as done</Strong> on the Routine; see{" "}
        <DocLink to="/docs/routines#outcome-check">The outcome check</DocLink> for what grading
        costs.
      </P>

      <H2 id="also-set-up">Also set up for your AI Employee</H2>
      <P>
        Some work arrives without being picked. Under <Strong>Also set up for {"{name}"}</Strong>{" "}
        the guide lists it, so nothing starts that you have not been shown:
      </P>
      <UL>
        <LI>
          <Strong>Standing work.</Strong> Automatic setup gives a ready AI Employee a few built-in
          responsibilities, such as <Strong>Advance my responsibilities</Strong> (weekdays at
          08:00), <Strong>Follow through on open work</Strong> (every 30 minutes),{" "}
          <Strong>Improve my work</Strong> (Fridays at 15:00) and{" "}
          <Strong>Find useful work to take on</Strong> (Mondays at 11:00). Each row shows its
          schedule. They are assigned within a minute of the AI Model connecting, the list is the
          same one Genosyn assigns from, and it counts on top of the Routines you selected. A row
          reads <Strong>Added</Strong> once it exists.
        </LI>
        <LI>
          <Strong>The TLDR briefing.</Strong> Hiring your first AI Employee starts a daily{" "}
          <DocLink to="/docs/tldrs">TLDR</DocLink> that they write. It appears as its own row with
          its schedule and writer.
        </LI>
      </UL>
      <P>
        Owners and admins also see the <Strong>Set up standing work automatically</Strong> switch.
        It is the same switch as <Strong>Automatic setup</Strong> on the{" "}
        <DocLink to="/docs/reactivity">Proactive</DocLink> page. Turn it off and the standing work
        is listed as <Strong>Not added</Strong>: Genosyn assigns nothing new, and work already set
        up keeps its own state. You can change or pause any of it later in{" "}
        <Strong>Proactive</Strong> and <Strong>TLDRs</Strong>.
      </P>
      <P>
        The screen also suggests relevant <DocLink to="/docs/integrations">Integrations</DocLink>. A{" "}
        <Strong>Connection</Strong> is one account your company connects; a <Strong>Grant</Strong>{" "}
        is this employee&apos;s access to it. Cards indicate whether to connect, grant access,
        repair an existing Connection, or continue with one that is ready. These are optional and do
        not create access merely by being recommended.
      </P>

      <H2 id="gmail">4. Optionally connect email</H2>
      <P>
        Enter the mailbox address. For Gmail and Google Workspace, choose{" "}
        <Strong>Continue with Google</Strong> and sign in with Google. Gmail uses OAuth only; there
        is no Gmail password or IMAP setup. If Google sign-in is not configured on your install, the
        screen explains what the administrator must enable.
      </P>
      <P>
        Other mail services use their own connection details. If a mailbox is already connected,
        choose <Strong>Grant draft access</Strong>. A newly connected mailbox also grants draft
        access to this employee.
      </P>
      <P>
        Draft access lets the employee read and triage mail and prepare replies. You press Send.
        Change access later in <Strong>Email → Settings → AI access</Strong>. See{" "}
        <DocLink to="/docs/email">Email</DocLink> for the full connection and access options.
      </P>
      <P>
        Choose <Strong>Skip email for now</Strong> to go on without a mailbox, or{" "}
        <Strong>Continue</Strong> once email is ready.
      </P>

      <H2 id="access">5. Choose what they can reach</H2>
      <P>
        An AI Employee reaches nothing it has not been granted, so the next step lists everything
        your company has that it could be — the mailbox you just connected, notebooks, Vault items,
        Member browsers, and the company sections such as Finance and Revenue. Tick what the job
        needs and press <Strong>Grant</Strong>; each Grant follows its own section&apos;s rules.
        Nothing is required: <Strong>Finish setup</Strong> works with nothing ticked, and the same
        list is always on the employee&apos;s{" "}
        <DocLink to="/docs/employees#access">Settings → Access</DocLink>.
      </P>

      <H2 id="summary">Review setup and start working</H2>
      <P>
        The summary reports your AI Employee, model connection, the Routines you scheduled, the
        standing work Automatic setup added (counted on its own line, so the total is never read as
        a limit), next Run, actual email access, and how many Grants the employee holds. It reads
        saved state, so it also reflects changes made outside the guide. Choose{" "}
        <Strong>Go to Home</Strong> or <Strong>Give {"{name}"} a first request</Strong>.
      </P>
      <P>
        The optional first-request screen offers examples or lets you write your own. Choosing one
        opens chat with the text filled in for you to review and send. You can also use{" "}
        <Strong>Back to summary</Strong>.
      </P>

      <H2 id="return">Leave and come back</H2>
      <P>
        Your saved work stays in place. While your company has no Goal (or mission and vision) or no
        connected AI Model, Home offers a setup banner that returns to the next required step.
        Routines and email are optional. When Home has nothing waiting on you, its all-clear card
        shows your Goal and how far along it is, or <Strong>Set your Goal</Strong> if you have not
        written one. You can also reopen <Code>/c/&lt;company-slug&gt;/onboarding</Code> directly.
      </P>
      <P>
        Hiring later from <Strong>AI → Employees → Hire AI Employee</Strong> uses the same Goal
        requirement and Routine suggestions. See{" "}
        <DocLink to="/docs/employees">AI Employees</DocLink> to review the Soul, Skills, and
        connections after setup.
      </P>
      <P>
        Once employees are working in your repositories, Home shows a{" "}
        <Strong>Repository AI work</Strong> card whenever a session needs attention. Open one to
        review its changes or continue working with the employee. See{" "}
        <DocLink to="/docs/repositories#work-sessions">Repository work sessions</DocLink>.
      </P>
    </>
  );
}
