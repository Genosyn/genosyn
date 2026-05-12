import {
  Callout,
  Code,
  DocLink,
  H2,
  LI,
  P,
  PageHeader,
  Pre,
  Strong,
  UL,
} from "@/docs/Prose";

export function Soul() {
  return (
    <>
      <PageHeader
        eyebrow="Core concepts"
        title="Soul"
        lead={
          <>
            A Soul is the <Strong>written constitution</Strong> of an AI
            employee. Values, voice, decision rules, things they refuse to do.
            One markdown document, stored on{" "}
            <Code>AIEmployee.soulBody</Code>.
          </>
        }
      />

      <H2 id="why-not-just-a-prompt">Why not just a prompt?</H2>
      <P>
        A system prompt tells a model how to act for one conversation. A Soul
        tells <em>this specific employee</em> how to act forever — across every
        conversation, every routine, every handoff. Treat it like a job
        description, not a chat instruction.
      </P>

      <H2 id="what-belongs">What belongs in a Soul</H2>
      <UL>
        <LI>
          <Strong>Identity.</Strong> Who they are. Role, scope of authority,
          who they report to.
        </LI>
        <LI>
          <Strong>Voice.</Strong> How they write. Concrete or theatrical?
          Short or thorough? Polished or first-person?
        </LI>
        <LI>
          <Strong>Decision rules.</Strong> Heuristics the employee applies when
          something is ambiguous. <Code>Prefer shipping a draft over polishing
          a blank page.</Code>
        </LI>
        <LI>
          <Strong>Refusals.</Strong> The explicit list of things they will not
          do. <Code>Never promise features that haven&apos;t shipped.</Code>
        </LI>
      </UL>

      <H2 id="what-doesnt-belong">What doesn&apos;t belong</H2>
      <UL>
        <LI>
          <Strong>Step-by-step procedures.</Strong> Those go in{" "}
          <DocLink to="/docs/skills">Skills</DocLink>.
        </LI>
        <LI>
          <Strong>Schedules and one-time tasks.</Strong> Those go in{" "}
          <DocLink to="/docs/routines">Routines</DocLink>.
        </LI>
        <LI>
          <Strong>Credentials, tokens, secrets.</Strong> The Soul is plain text
          on the DB row. Use{" "}
          <DocLink to="/docs/integrations">Integrations</DocLink> instead.
        </LI>
      </UL>

      <H2 id="example">A short example</H2>
      <Pre lang="markdown">{`# Alex Brand
Senior brand writer for an open-source company.

## Voice
- Concrete over clever. Real sentences, no marketing jargon.
- Shorter is braver. If a paragraph can be a sentence, make it one.
- Write like an engineer who shipped the feature would write about it.

## Decision rules
- When in doubt, link to the code or the changelog.
- If a claim cannot be verified from public artifacts, cut it.

## Never
- Promise features that haven&#x27;t shipped.
- Use the word "leverage" as a verb.
- Reuse a phrase that already appears in last week&#x27;s digest.`}</Pre>

      <H2 id="editing-it">Editing it</H2>
      <P>
        The in-app Soul editor renders markdown with a live preview pane. ⌘S
        saves. Every save replaces the body — there&apos;s no soft history
        today, so if you want diffs, commit the rendered text outside the app
        (most teams paste it into a private repo).
      </P>

      <Callout kind="tip" title="Treat it like a hiring document.">
        Short Souls work. Long Souls work too. What matters is whether a new
        teammate could read it and explain how the employee thinks. If they
        can&apos;t, the model probably can&apos;t either.
      </Callout>
    </>
  );
}
