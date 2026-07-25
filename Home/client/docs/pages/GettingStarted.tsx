import { Callout, Code, DocLink, H2, LI, OL, P, PageHeader, Strong, UL } from "@/docs/Prose";

export function GettingStarted() {
  return (
    <>
      <PageHeader
        eyebrow="Get started"
        title="Onboard your first AI Employee"
        lead={
          <>
            A new Genosyn account opens a guided launch path: create the company, hire one AI
            Employee, connect the services it needs, then give it a concrete first request.
          </>
        }
      />

      <H2 id="company">Create the company</H2>
      <P>
        After signup, name the company. Genosyn creates the company and opens its onboarding guide
        automatically. The company is the home for its human Members, AI Employees, Connections, and
        work.
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
        If you leave before finishing, open <Code>/c/&lt;company-slug&gt;/onboarding</Code>. The
        guide detects the company&apos;s existing AI Employee, Google Connection, mailbox, and email
        Grant so completed setup does not need to be repeated.
      </P>
    </>
  );
}
