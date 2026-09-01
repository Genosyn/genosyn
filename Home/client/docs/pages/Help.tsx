import { Callout, Code, DocLink, H2, LI, OL, P, PageHeader, Strong, UL } from "@/docs/Prose";

export function Help() {
  return (
    <>
      <PageHeader
        eyebrow="Get started"
        title="Genosyn Help"
        lead={
          <>
            Ask any AI Employee in your company how Genosyn works. Help combines that
            employee&apos;s own voice with the product documentation, roadmap, and the exact source
            code shipped in the running release.
          </>
        }
      />

      <H2 id="ask">Ask a question</H2>
      <OL>
        <LI>
          Click the <Strong>Help</Strong> icon in the app&apos;s top bar.
        </LI>
        <LI>
          Select an AI Employee. An employee needs a connected{""}
          <DocLink to="/docs/models">AI Model</DocLink> before it can answer.
        </LI>
        <LI>
          Ask a product, configuration, troubleshooting, deployment, or implementation question.
          Replies stream into the page and the conversation is saved.
        </LI>
        <LI>
          Click <Strong>New</Strong> when you want a fresh Help context. Each AI Employee keeps
          their own separate list of Help conversations.
        </LI>
      </OL>

      <H2 id="context">What the AI Employee can inspect</H2>
      <P>
        Help does not rely on a generic model&apos;s memory of Genosyn. The App image includes a
        read-only snapshot of the source that produced that release, and the selected AI Employee
        receives dedicated tools to list, search, and read it. The snapshot includes:
      </P>
      <UL>
        <LI>
          <Code>AGENTS.md</Code> and <Code>ROADMAP.md</Code> for vocabulary, architecture, and
          shipped product decisions.
        </LI>
        <LI>
          <Code>Home/client/docs/pages/</Code> for the public, user-facing instructions.
        </LI>
        <LI>
          <Code>App/client/</Code> and <Code>App/server/</Code> for the React UI, Express API, and
          AI runtime.
        </LI>
        <LI>
          <Code>CLI/</Code>, <Code>.github/workflows/</Code>, and <Code>RELEASING.md</Code> for
          self-hosting and delivery behavior.
        </LI>
      </UL>
      <P>
        For code-level questions, the AI Employee is instructed to inspect the relevant source and
        cite repository paths in its answer. The source is retrieved only as needed instead of
        placing the whole repository in every model prompt.
      </P>

      <Callout kind="info" title="Help is a separate, read-only support surface.">
        Help conversations never appear in ordinary employee Chat, so their Genosyn-specific context
        cannot bleed into day-to-day work. Source access cannot edit the running application. To ask
        the employee to perform company work or change one of your granted Repositories, open that
        {""}
        <DocLink to="/docs/employees">AI Employee</DocLink>&apos;s regular <Strong>Chat</Strong>.
      </Callout>
    </>
  );
}
