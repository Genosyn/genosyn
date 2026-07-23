import { Callout, Code, DocLink, H2, LI, P, PageHeader, Strong, UL } from "@/docs/Prose";

export function ToolDiscovery() {
  return (
    <>
      <PageHeader
        eyebrow="Brains & tools"
        title="How tools reach the model"
        lead={
          <>
            An AI employee has more tools than it is shown. A small working set goes out with every
            request; everything else sits in a searchable catalogue the employee reaches on demand.
            This is what keeps a turn cheap as Genosyn grows.
          </>
        }
      />

      <H2 id="why">Why it works this way</H2>
      <P>
        Every request to a model carries the description and argument schema of every tool the
        employee can use. That list only ever grew — each new feature added its own tools, and every
        unrelated turn paid for them. Before this change a single request carried around{" "}
        <Strong>21,000 tokens</Strong> of tool definitions before the employee had a single
        Integration connected.
      </P>
      <P>
        The cost was the smaller problem. The bigger one was that an employee doing a code review
        was handed the whole finance and mail surface too, and had to pick its way through tools
        that had nothing to do with the job.
      </P>

      <H2 id="working-set">The working set</H2>
      <P>
        Roughly twenty tools go out on every request — about <Strong>4,500 tokens</Strong>. They are
        chosen by consequence, not by how often they are used:
      </P>
      <UL>
        <LI>
          <Strong>Coding tools</Strong> — <Code>bash</Code>, <Code>read_file</Code>,{" "}
          <Code>write_file</Code> and the rest. Their arguments are large free-form strings, which
          survive better sent directly.
        </LI>
        <LI>
          <Strong>Everything that writes</Strong> — creating a Routine, a Project, a Todo, a journal
          entry. Models have a habit of <Strong>saying</Strong> they scheduled something without
          calling anything, and making the call harder than the sentence makes that worse.
        </LI>
        <LI>
          <Strong>Browser tools</Strong>, when the employee has the browser enabled.
        </LI>
        <LI>
          <Code>find_tools</Code> and <Code>call_tool</Code> — the door to everything else.
        </LI>
      </UL>

      <H2 id="catalogue">The catalogue</H2>
      <P>
        Everything else — mail, finance, Bases, Notes, Resources, charts, dashboards, workspace
        channels, handoffs, and every{" "}
        <DocLink to="/docs/integrations">Integration</DocLink> tool — lives in the catalogue. The
        employee calls <Code>find_tools</Code> with what it is trying to do (&quot;record a
        payment&quot;, &quot;reply to that email&quot;, &quot;read a spreadsheet&quot;) and gets back
        the matching tools with their exact arguments, then runs one.
      </P>
      <P>
        Every search result also carries the complete list of catalogue tool names. So even when a
        search misses, the employee can see what exists — the difference between one extra step and
        a capability that has quietly vanished.
      </P>

      <Callout kind="info" title="Grants are unchanged.">
        Discovery decides what an employee is <Strong>shown</Strong>, never what it is{" "}
        <Strong>allowed</Strong>. A tool the employee holds no Grant for is still refused when
        called, and <Code>find_tools</Code> labels it as such before the employee wastes a step
        on it.
      </Callout>

      <H2 id="skill-toolsets">Skipping the search</H2>
      <P>
        Searching costs a round-trip, and a search can miss. If you already know which tools a
        procedure uses, say so: open a <DocLink to="/docs/skills">Skill</DocLink>, go to{" "}
        <Strong>Settings → Tools</Strong>, and pick them. Those tools are loaded up-front for any
        turn where that Skill applies, and the employee never searches for them.
      </P>
      <P>
        This is the recommended fix if you ever find an employee saying it cannot do something it
        can. Declaring a tool does not grant access to it.
      </P>

      <H2 id="reading-the-log">Reading the run log</H2>
      <P>
        Every run records how its catalogue was split, so you can tell &quot;never used the
        tool&quot; from &quot;never saw the tool&quot;:
      </P>
      <UL>
        <LI>
          <Code>[tools] 22 loaded, 89 in the catalogue behind find_tools — bases, mail, finance…</Code>
        </LI>
        <LI>
          When a Skill declared tools, they are named:{" "}
          <Code>[tools] 24 loaded (2 from Skills: send_invoice, record_payment), …</Code>
        </LI>
      </UL>

      <H2 id="turning-it-off">Turning it off</H2>
      <P>
        Set <Code>agent.toolDiscovery.enabled</Code> to <Code>false</Code> in{" "}
        <Code>App/config.ts</Code> and every tool is sent on every request again, exactly as before.
        Nothing else changes. The switch exists because a model that does not think to search is the
        one real risk this design carries, and an operator who hits it should not need to downgrade.
      </P>
      <P>
        Older employees are unaffected in one specific way worth knowing: Skills written before this
        change often name grouped tools like <Code>mail</Code> or <Code>base_rows</Code> with an{" "}
        <Code>op</Code> argument. Those names still work and always will.
      </P>
    </>
  );
}
