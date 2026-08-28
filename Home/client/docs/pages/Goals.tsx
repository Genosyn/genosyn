import {
  Callout,
  Code,
  DocLink,
  H2,
  KeyList,
  LI,
  P,
  PageHeader,
  Strong,
  UL,
} from "@/docs/Prose";

export function Goals() {
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Goals"
        lead={
          <>
            A <Strong>Goal</Strong> is a measurable objective the company is steering toward — a
            number, a direction, and optionally a deadline and an accountable{" "}
            <Strong>AI Employee</Strong>. Humans set the intent; every AI Employee reads it in every
            prompt, and every <DocLink to="/docs/routines">Routine</DocLink> can declare which Goal
            its work serves.
          </>
        }
      />

      <Callout kind="info" title='"Goal" is the word.'>
        Genosyn never says &quot;OKR,&quot; &quot;KPI,&quot; or &quot;Target.&quot; One noun, in the
        UI, the tools, and these docs: <Strong>Goal</Strong>.
      </Callout>

      <H2 id="where-they-live">Where they live</H2>
      <P>
        Goals have their own section in the nav, under <Strong>AI → Goals</Strong>. Every Member can
        open it — a Goal is the company&apos;s shared direction, and everyone should see where it
        stands. Creating, editing, archiving, and deleting Goals is owner/admin-only: Goals are
        human-set intent, and which humans is the same call as who may reorganize the company&apos;s
        Routines. AI Employees report progress but never author a Goal.
      </P>

      <H2 id="anatomy">Anatomy</H2>
      <KeyList
        rows={[
          { term: "Title", def: "What the company calls this objective." },
          {
            term: "Description",
            def: "Why the Goal exists and what done means, in prose. Shown on the Goals page and injected under the title wherever the Goal is folded into a prompt.",
          },
          {
            term: "Target",
            def: (
              <>
                The number to hit, with a direction: <Strong>reach</Strong> for metrics that should
                go up (revenue, signups), <Strong>drive down to</Strong> for metrics that should go
                down (churn, error rate).
              </>
            ),
          },
          {
            term: "Unit",
            def: (
              <>
                Optional free-text label rendered beside values — <Code>$</Code>, <Code>%</Code>,{" "}
                <Code>signups</Code>. Display only, never parsed.
              </>
            ),
          },
          {
            term: "Deadline",
            def: (
              <>
                Optional. A Goal with no deadline is open-ended — it can be achieved but never{" "}
                <Strong>missed</Strong>.
              </>
            ),
          },
          {
            term: "Owner",
            def: (
              <>
                Optional <DocLink to="/docs/employees">AI Employee</DocLink> accountable for the
                Goal. Ownership drives prompt injection: an employee&apos;s active Goals ride into
                its system prompt.
              </>
            ),
          },
          {
            term: "Parent goal",
            def: (
              <>
                Optional. Goals cascade company → employee, up to <Strong>4 levels</Strong> deep — a
                company Goal at the top, sharper and more owned as you descend. Deleting a parent
                never orphans children; they move up to the deleted Goal&apos;s own parent.
              </>
            ),
          },
          {
            term: "Metric source",
            def: (
              <>
                <Strong>Manual</Strong> or <Strong>Chart</Strong> — where the current value comes
                from. See <DocLink to="/docs/goals#metric-source">below</DocLink>.
              </>
            ),
          },
        ]}
      />

      <H2 id="metric-source">Where the number comes from</H2>
      <P>
        Every Goal tracks a <Strong>current value</Strong> against its target. There are exactly two
        ways that value moves:
      </P>
      <UL>
        <LI>
          <Strong>Manual</Strong> — a Member or an AI Employee reports the number. The platform
          never computes it; the last reported value stands until the next report.
        </LI>
        <LI>
          <Strong>Chart</Strong> — the Goal is bound to an{" "}
          <DocLink to="/docs/explore">Explore Chart</DocLink>, and the first numeric cell of the
          chart&apos;s first result row becomes the current value. That is the same first-cell
          contract the <DocLink to="/docs/explore#viz-types">scalar visualization</DocLink> renders,
          so a chart that already shows your MRR as a big number is already the right shape. Genosyn
          refreshes chart-bound Goals automatically on the scheduler heartbeat — nobody has to
          remember to update them.
        </LI>
      </UL>
      <Callout kind="tip" title="Bind the Goal to a Chart when you can.">
        A manual Goal is only as honest as its last report. A chart-bound Goal reads the database
        and cannot forget, drift, or flatter.
      </Callout>

      <H2 id="lifecycle">Lifecycle</H2>
      <P>
        A Goal starts <Strong>active</Strong> and settles itself:
      </P>
      <UL>
        <LI>
          <Strong>Achieved</Strong> — the current value met the target, in the Goal&apos;s
          direction.
        </LI>
        <LI>
          <Strong>Missed</Strong> — the deadline passed with the target unmet.
        </LI>
      </UL>
      <P>
        Settling happens automatically and <Strong>exactly once</Strong>, with a bell notification
        to the company&apos;s owners and admins — however many processes race, one settle, one
        notification. <Strong>Archived</Strong> is the manual off-switch for an objective that no
        longer applies: an archived Goal is never graded, injected into prompts, or refreshed. Any
        settled or archived Goal can be <Strong>reactivated</Strong>, which clears the settle stamp
        so it can be graded again — a missed quarter target becomes next quarter&apos;s.
      </P>

      <H2 id="employees">What AI Employees see</H2>
      <P>
        Every AI Employee&apos;s system prompt now opens with the company&apos;s{" "}
        <Strong>Mission</Strong> and <Strong>Vision</Strong> — written during onboarding or edited
        any time in company <Strong>Settings</Strong> — followed by a <Strong>Goals</Strong> block:
        the active Goals that employee owns, then the company&apos;s top-level Goals for shared
        direction. An employee with no Goals of its own still knows what the company is steering
        toward; an employee that owns one knows it is accountable.
      </P>
      <P>
        This is the point of the feature: an AI Employee choosing between two reasonable actions
        picks the one that moves a number the company actually wrote down — without anyone pasting
        strategy into a brief.
      </P>

      <H2 id="routines">Goals and Routines</H2>
      <P>
        A <DocLink to="/docs/routines">Routine</DocLink> can declare which Goal its scheduled work
        serves: pick one in the <Strong>Goal</Strong> field on the routine&apos;s{" "}
        <Strong>Settings</Strong> tab. Two things follow:
      </P>
      <UL>
        <LI>
          The linked Goal is folded into every Run&apos;s brief, beside the acceptance criteria — the
          employee is told the objective, not just the task.
        </LI>
        <LI>
          The <DocLink to="/docs/routines#outcome-check">outcome checker</DocLink> receives the Goal
          as judging context. The acceptance criteria remain the bar, but work that met the letter
          of the criteria while plainly working against the objective is graded{" "}
          <Code>off goal</Code> — a digest that technically posted on time but buried the churn
          spike the Goal exists to catch.
        </LI>
      </UL>

      <H2 id="tools">Tools</H2>
      <P>Every AI Employee holds three built-in Goal tools:</P>
      <KeyList
        rows={[
          {
            term: "list_goals",
            def: "The company's Goals — status, target, current value, owner.",
          },
          { term: "get_goal", def: "One Goal in full, description included." },
          {
            term: "update_goal_progress",
            def: (
              <>
                Report a new current value for a <Strong>Manual</Strong> Goal. Chart-bound Goals
                refuse it — they track themselves. Every report is written to the{" "}
                <DocLink to="/docs/employees">audit log</DocLink> and to the reporting
                employee&apos;s journal, so a number never moves without a trail.
              </>
            ),
          },
        ]}
      />
      <P>
        Employees are told to report when their own work moves a Goal&apos;s number. What they are{" "}
        <em>not</em> given is any tool to create, edit, or archive a Goal — the definitions stay
        human.
      </P>

      <Callout kind="info" title="Humans set intent. AI reports against it.">
        That asymmetry is deliberate. An AI Employee that could quietly rewrite the target it is
        graded against would make every green number meaningless.
      </Callout>
    </>
  );
}
