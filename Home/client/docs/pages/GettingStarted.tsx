import { Callout, Code, DocLink, H2, LI, OL, P, PageHeader, Strong, UL } from "@/docs/Prose";

export function GettingStarted() {
  return (
    <>
      <PageHeader
        eyebrow="Get started"
        title="Set up your company"
        lead={
          <>
            Start with what your company does and where it is going. Then hire an AI Employee,
            connect an AI Model, and choose useful recurring work. Email is optional.
          </>
        }
      />

      <H2 id="company">1. Set your company direction</H2>
      <P>
        After signup, fill in <Strong>Company name</Strong>, <Strong>Mission</Strong>, and{" "}
        <Strong>Vision</Strong>, then choose <Strong>Create company and continue</Strong>. A
        sentence for each is enough:
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
        Both are required before hiring an AI Employee. If you created a company earlier without
        them, the guide opens <Strong>What is your company here to do?</Strong> first. Fill in both
        fields and choose <Strong>Save and continue</Strong>. You can refine them later in{" "}
        <Strong>Settings → Company</Strong>.
      </P>
      <P>
        The company is home to its Members, AI Employees, Connections, and work. To create another
        one later, open the company picker and choose <Strong>+ New company</Strong>.
      </P>

      <H2 id="the-guide">The setup guide</H2>
      <P>
        The guide shows four steps: <Strong>Company</Strong>, <Strong>AI Employee</Strong>,{" "}
        <Strong>Routines</Strong>, and <Strong>Email</Strong>. Your company direction is already
        saved when you arrive from signup, so you can move straight to hiring. You can return to
        earlier steps to make changes.
      </P>

      <H2 id="employee">2. Hire and connect an AI Employee</H2>
      <OL>
        <LI>
          Under <Strong>Hire your first AI Employee</Strong>, pick a starting role or enter your own{" "}
          <Strong>Name</Strong> and <Strong>Role</Strong>. Starting roles include Executive
          Assistant, Sales Development Rep, Research Analyst, and Operations Coordinator.
        </LI>
        <LI>
          Choose <Strong>Hire AI Employee</Strong>. A role template provides a{" "}
          <DocLink to="/docs/soul">Soul</DocLink> — their written constitution — and{" "}
          <DocLink to="/docs/skills">Skills</DocLink> describing how to do the work. Hiring does not
          automatically schedule Routines.
        </LI>
        <LI>
          Connect an <DocLink to="/docs/models">AI Model</DocLink>. Genosyn discovers the models
          available to the connected account and selects a suitable default. You can review the
          choice. Connecting automatically tests a real response so an invalid key, unavailable
          model, or unusable account is reported immediately.
        </LI>
        <LI>
          When the model is ready, choose <Strong>Choose Routines</Strong>.
        </LI>
      </OL>
      <P>
        Genosyn supports Claude through an Anthropic API key, OpenAI API keys, and custom
        OpenAI-compatible endpoints. Eligible ChatGPT subscription access is also available on
        trusted single-tenant installs. Credentials are encrypted when stored. See{" "}
        <DocLink to="/docs/models">AI Models</DocLink> for the available connection methods.
      </P>
      <Callout kind="info" title="You can connect a model later.">
        Choose <Strong>Continue without a model</Strong> if you are not ready yet. The AI Employee
        can answer requests and run Routines once an AI Model is connected.
      </Callout>

      <H2 id="launch-plan">3. Choose Routines that support your mission</H2>
      <P>
        A <DocLink to="/docs/routines">Routine</DocLink> is work an AI Employee does on a schedule.
        Genosyn suggests responsibilities that fit their saved role, then uses your company mission
        and vision to prioritize them. Changing the role changes the suggestions; a company focused
        on sales does not turn a Software Engineer into a salesperson.
      </P>
      <P>
        Every suggested Routine includes the role, mission, and vision in its instructions, along
        with its outcome, inputs, and schedule. An unusual role gets general planning and review
        suggestions scoped to that employee&apos;s responsibilities.
      </P>
      <OL>
        <LI>
          Review the suggested Routines and their schedules. Select only the recurring work you want
          to start; you can select up to five at once.
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
        This step creates only selected Routines. They start on their displayed schedules and use
        your AI Model. A Routine already added is marked <Strong>Scheduled</Strong> and cannot be
        duplicated. You can read each Run and change or disable schedules in{" "}
        <Strong>AI → Routines</Strong>.
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
        Choose <Strong>Skip email for now</Strong> to finish without a mailbox, or{" "}
        <Strong>Finish setup</Strong> once email is ready.
      </P>

      <H2 id="summary">Review setup and start working</H2>
      <P>
        The summary reports your AI Employee, model connection, scheduled Routines, next Run, and
        actual email access. It reads saved state, so it also reflects changes made outside the
        guide. Choose <Strong>Go to Home</Strong> or{" "}
        <Strong>Give {"{name}"} a first request</Strong>.
      </P>
      <P>
        The optional first-request screen offers examples or lets you write your own. Choosing one
        opens chat with the text filled in for you to review and send. You can also use{" "}
        <Strong>Back to summary</Strong>.
      </P>

      <H2 id="return">Leave and come back</H2>
      <P>
        Your saved work stays in place. While company direction or a connected AI Model is missing,
        Home offers a setup banner that returns to the next required step. Routines and email are
        optional. You can also reopen <Code>/c/&lt;company-slug&gt;/onboarding</Code> directly.
      </P>
      <P>
        Hiring later from <Strong>AI → Employees → Hire AI Employee</Strong> uses the same company
        direction requirement and Routine suggestions. See{" "}
        <DocLink to="/docs/employees">AI Employees</DocLink> to review the Soul, Skills, and
        connections after setup.
      </P>
    </>
  );
}
