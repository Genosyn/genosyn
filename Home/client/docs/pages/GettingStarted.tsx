import { Callout, Code, DocLink, H2, LI, OL, P, PageHeader, Strong, UL } from "@/docs/Prose";

export function GettingStarted() {
  return (
    <>
      <PageHeader
        eyebrow="Get started"
        title="Onboard your first AI Employee"
        lead={
          <>
            A new Genosyn account opens a guided launch path: describe the company, hire one AI
            Employee, turn the best recurring work into Routines, connect the services it needs,
            then give it a concrete first request.
          </>
        }
      />

      <H2 id="company">Create the company</H2>
      <P>
        After signup, name the company and optionally add its <Strong>mission</Strong> and
        <Strong> vision</Strong>. The mission explains what the company does and who it serves; the
        vision describes the future it is working toward. Genosyn saves both as company context and
        uses them to make each new AI Employee&apos;s launch plan relevant to the business.
      </P>
      <P>
        Genosyn then creates the company and opens its onboarding guide automatically. The company
        is the home for its human Members, AI Employees, Connections, and work. Mission and vision
        are optional: leave either blank and the guide still produces useful role-based suggestions,
        then add the missing context from the launch plan or <Strong>Settings → Company</Strong>
        later.
      </P>
      <P>
        To create another company later, open the company picker in the top bar and select
        <Strong> + New company</Strong>. Genosyn adds you as its owner and switches to the new
        company&apos;s onboarding guide as soon as it is ready.
      </P>

      <H2 id="employee">Hire the first AI Employee</H2>
      <OL>
        <LI>
          Pick a starting role such as Executive Assistant, SDR, Research Analyst, or Operations
          Manager.
        </LI>
        <LI>
          Review the name and role, then select <Strong>Hire AI Employee</Strong>. The template
          creates an editable <DocLink to="/docs/soul">Soul</DocLink>,
          <DocLink to="/docs/skills"> Skills</DocLink>, and starter{" "}
          <DocLink to="/docs/routines">Routines</DocLink>.
        </LI>
        <LI>
          Connect an <DocLink to="/docs/models">AI Model</DocLink>. Chat and Runs use the active
          connected model.
        </LI>
      </OL>
      <Callout kind="info" title="You can continue without a model.">
        The guide is skippable when credentials are not ready, but the AI Employee cannot answer
        chat or run a Routine until an active AI Model is connected.
      </Callout>

      <H2 id="launch-plan">Put the new hire to work</H2>
      <P>
        Every hire ends with a <Strong>Launch plan</Strong>. This is the next step in the company
        onboarding guide and the final step when you hire another AI Employee from{" "}
        <Strong>AI → Employees</Strong>. Genosyn combines the employee&apos;s role, chosen template,
        and the company mission and vision to recommend useful first work. The same inputs always
        produce a stable plan, so refreshing or returning to the guide does not reshuffle it.
      </P>

      <H2 id="suggested-routines">Choose suggested Routines</H2>
      <P>
        The launch plan shows three or four role-specific Routines. Each card explains the outcome
        and schedule and has one of two states:
      </P>
      <UL>
        <LI>
          <Strong>Ready</Strong> means that Routine already belongs to the employee — often because
          the chosen template created it. It remains in the plan so you can see value that is ready
          immediately.
        </LI>
        <LI>
          <Strong>Suggested</Strong> means the Routine has not been added. Select any combination,
          then choose <Strong>Add selected Routines</Strong> to add them together.
        </LI>
      </UL>
      <P>
        Adding suggestions is opt-in. Genosyn re-checks the current employee before creating the
        batch: it never overwrites an edited Routine, and a matching name or slug is returned as
        ready instead of being duplicated. If the mission or vision is missing, add it in the launch
        plan and refresh the recommendations before adding anything. Refine existing company
        direction later from <Strong>Settings → Company</Strong>.
      </P>

      <H2 id="recommended-integrations">Review recommended Integrations</H2>
      <P>
        The same plan recommends up to three enabled{" "}
        <DocLink to="/docs/integrations">Integrations</DocLink> that fit the employee&apos;s work. A
        recommendation never creates access by itself. Its status tells you the next safe action:
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
        A Connection belongs to the company; a Grant decides whether this AI Employee can use it.
        Connecting one account does not silently grant it, and granting one Connection does not
        expose the rest of the Integration catalog. Review every credential and Grant before moving
        on.
      </Callout>

      <H2 id="email">Connect email safely</H2>
      <P>
        The Email step connects a Gmail mailbox through Google Workspace. If a Gmail-capable Google
        Connection already exists, the guide can attach that mailbox directly. Otherwise, select{" "}
        <Strong>Connect Gmail</Strong> and complete the Google OAuth setup.
      </P>
      <P>
        The guide gives the new AI Employee <Code>draft</Code> access by default. It can read and
        triage threads, apply labels, and prepare drafts, but it cannot send. Raise the Grant to{" "}
        <Code>send</Code> later under <Strong>Email → Settings → AI access</Strong> only when you
        want that extra autonomy. See <DocLink to="/docs/email">Email</DocLink>.
      </P>
      <Callout kind="info" title="Email is optional during onboarding.">
        A self-hosted operator may need to configure a Google OAuth client first. Select{" "}
        <Strong>Set up email later</Strong> and return through <Strong>Email → Integrations</Strong>{" "}
        when those credentials are ready.
      </Callout>

      <H2 id="first-request">Make the first request</H2>
      <P>
        Pick a starter request or write your own. Genosyn opens the AI Employee&apos;s chat with
        that request filled in, but does not send it. Review it, add company context, and send when
        ready.
      </P>
      <UL>
        <LI>
          <Strong>Create a Routine</Strong> — the AI Employee asks about the outcome, inputs, and
          schedule before creating recurring work.
        </LI>
        <LI>
          <Strong>Find potential Contacts</Strong> — define the ideal customer first, research a
          focused list, and never invent contact details.
        </LI>
        <LI>
          <Strong>Triage my inbox</Strong> — group unread email and prepare drafts without sending.
        </LI>
        <LI>
          <Strong>Plan your first week</Strong> — turn the role and Soul into concrete outcomes and
          possible Routines.
        </LI>
      </UL>

      <H2 id="return">Return to the guide</H2>
      <P>
        The Launch plan and later setup steps are skippable. If you leave a company onboarding guide
        before finishing, open <Code>/c/&lt;company-slug&gt;/onboarding</Code>. Its URL keeps the
        current step and employee, and the guide re-checks the employee&apos;s Routines,
        Connections, mailbox, and Grants so completed setup does not need to be repeated.
      </P>
      <P>
        When hiring from <Strong>AI → Employees</Strong>, you can skip or finish the Launch plan and
        meet the employee immediately. The Launch URL retains the employee and template so a reload
        returns to the same plan. Skipping creates no Routines, Connections, or Grants. You can do
        the same work later from <Strong>AI → Routines</Strong>, the employee&apos;s{" "}
        <Strong>Connections</Strong> page, and <Strong>Settings → Integrations</Strong>.
      </P>
    </>
  );
}
