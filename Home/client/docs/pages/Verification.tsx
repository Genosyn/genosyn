import {
  Callout,
  Code,
  DocLink,
  H2,
  H3,
  KeyList,
  LI,
  P,
  PageHeader,
  Pre,
  Strong,
  UL,
} from "@/docs/Prose";

export function Verification() {
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="What proves a Run worked"
        lead={
          <>
            Almost everything Genosyn used to know about a <Strong>Run</Strong> came from the Run.
            The status said the loop returned; the transcript was the model narrating its own work;
            the verdict was a second model reading that narration. <Strong>Checks</Strong> and the
            {""}
            <Strong>Effects</Strong> list are the parts no model has a say in.
          </>
        }
      />

      <Callout kind="info" title='"Check" is the word.'>
        Genosyn never says &quot;test,&quot; &quot;assertion,&quot; or &quot;gate&quot; for this. A
        {""}
        <Strong>Check</Strong> is a machine-verifiable assertion a Run must pass before it finalizes
        green. System Health keeps the word <Strong>probe</Strong> for its own diagnostics precisely
        so this one stays free.
      </Callout>

      <H2 id="three-axes">Three axes, three different claims</H2>
      <P>
        A Run carries three independent judgements, and reading any one of them as the others is how
        a convincingly wrong Run passes for a good one. They never overwrite each other — a Run with
        failing Checks still ends <Code>completed</Code>, because that word has a narrow meaning
        worth keeping.
      </P>
      <KeyList
        rows={[
          {
            term: "status",
            def: (
              <>
                <Strong>The loop returned.</Strong> <Code>completed</Code> means the agent finished
                without erroring, timing out, or being interrupted. It is a statement about the
                runtime, not about the work. See <DocLink to="/docs/routines#runs">Runs</DocLink>.
              </>
            ),
          },
          {
            term: "checksVerdict",
            def: (
              <>
                <Strong>The machine-verifiable bar.</Strong> <Code>passed</Code>,{""}
                <Code>failed</Code>, or <Code>not_run</Code> when the Routine declares no Checks.
                Decided by the server running assertions an operator wrote — the only axis with no
                model in it anywhere.
              </>
            ),
          },
          {
            term: "outcomeVerdict",
            def: (
              <>
                <Strong>A restricted model graded the evidence.</Strong> <Code>achieved</Code>,{""}
                <Code>unclear</Code>, <Code>off_goal</Code>, or <Code>unverified</Code>, against the
                Routine&apos;s acceptance criteria. Judgement, not proof — see{""}
                <DocLink to="/docs/routines#outcome-check">the outcome check</DocLink>.
              </>
            ),
          },
        ]}
      />

      <H2 id="checks">Checks</H2>
      <P>
        Acceptance criteria are prose, and prose is graded by a model. A Check is the opposite
        shape: an assertion the operator writes, that the server evaluates, and that the employee
        being graded cannot author, edit, or delete. There is no MCP tool that writes one. An AI
        Employee may <Strong>read</Strong> its Routine&apos;s Checks — they ride into the Run brief,
        so it aims at the bar rather than discovering it afterwards — and that is the whole of its
        access.
      </P>
      <P>
        Checks live on the Routine&apos;s <Strong>Settings → Checks</Strong> panel, beside{""}
        <Strong>Outcome check</Strong> — at most <Strong>10</Strong> per Routine, run in the order
        you arrange them. Each one has a name, a kind, the assertion itself, and three switches:
      </P>
      <KeyList
        rows={[
          {
            term: "required",
            def: "A required Check that does not pass fails the Run's checks verdict. A non-required one reports its result and changes nothing — the way to watch a new signal for a fortnight before letting it stop work.",
          },
          {
            term: "enabled",
            def: "Off keeps the row and its history without running it.",
          },
          {
            term: "timeoutSec",
            def: (
              <>
                Wall-clock ceiling for a <Code>command</Code> Check — 120 seconds by default, up to
                15 minutes. Always clamped further by what remains of the Run&apos;s own deadline,
                so Checks can never extend <Code>timeoutSec</Code> on the Routine.
              </>
            ),
          },
        ]}
      />

      <H3 id="effect-checks">Writing an effect Check</H3>
      <P>
        An <Code>effect</Code> Check is a predicate over what the server recorded this Run changing
        — the <DocLink to="/docs/verification#effects">Effects</DocLink> list below. It needs no
        shell, no sandbox, and no extra model turn, which is what keeps Checks from being a luxury
        only some installs get. Four fields:
      </P>
      <UL>
        <LI>
          <Code>action</Code> — the recorded action to count, such as <Code>mail.send</Code> or{""}
          <Code>deal.update</Code>.
        </LI>
        <LI>
          <Code>targetType</Code> — optional, narrows the count to one kind of record.
        </LI>
        <LI>
          <Code>min</Code> — how many the Run must have recorded. The usual assertion.
        </LI>
        <LI>
          <Code>max</Code> — optional ceiling. This is the one that catches a loop: a digest routine
          that sent 400 emails passes every <Code>min</Code> ever written.
        </LI>
      </UL>
      <Pre lang="json">{`{ "action": "mail.send", "targetType": "mail_thread", "min": 1, "max": 3 }`}</Pre>
      <P>
        The result records the arithmetic, not a verdict word — <em>expected at least 1</em>
        {""}
        <Code>mail.send</Code>, <em>the ledger has 0</em> — so the person reading it later does not
        have to re-derive why it failed.
      </P>

      <H3 id="command-checks">Writing a command Check</H3>
      <P>
        A <Code>command</Code> Check runs a shell command inside the same bubblewrap boundary the
        {""}
        <Code>bash</Code> tool uses, rooted at the employee&apos;s working directory, and passes on
        exit <Code>0</Code>. Anything the sandbox can run is fair game — a test suite, a{""}
        <Code>git diff --exit-code</Code>, a script that curls the endpoint the Run was supposed to
        deploy. The exit code and the tail of the output land on the result.
      </P>
      <Callout kind="warn" title="Command Checks need the sandbox.">
        They are available only where bubblewrap can actually start — the same rule that governs the
        {""}
        <Code>bash</Code> tool, and for the same reason: host mode never gives an AI Employee a
        same-UID shell. On a <Code>disabled</Code>-mode install, write <Code>effect</Code> Checks
        instead. A Check that could not be run records <Strong>not passed</Strong>, with the reason;
        it never quietly counts as a pass.
      </Callout>

      <H2 id="effects">The Effects list</H2>
      <P>
        Every mutation inside a company already writes an <Strong>audit event</Strong> at the write
        seam, after the change succeeded. Those rows now carry the <Code>runId</Code> of the Run
        whose token authorized them, and the Run detail view renders them as a plain{""}
        <Strong>Effects</Strong> list beside the transcript: what changed, to what, in order.
      </P>
      <P>
        It is not a summary of the transcript and it is not derived from one. The transcript is the
        model&apos;s account of its work; the Effects list is the server&apos;s, written by the code
        that performed each change. It is the one record of a Run the model had no hand in — which
        is why a Run that ends with a confident summary of six emails sent, beside an empty Effects
        list, is now a visibly different object from a Run that sent six emails.
      </P>
      <P>The same ledger has three other readers:</P>
      <UL>
        <LI>
          <Strong>Effect Checks</Strong> assert over it.
        </LI>
        <LI>
          The <Strong>outcome checker</Strong> is shown it alongside the transcript, labelled as
          server-written, so it can weigh what happened against what was claimed.
        </LI>
        <LI>
          A <Strong>retrying Run</Strong> opens with what earlier attempts already did — see{""}
          <DocLink to="/docs/routines#retries">Retries</DocLink>.
        </LI>
        <LI>
          <Strong>AI Employees</Strong>, through the two tools below.
        </LI>
      </UL>
      <P>
        The list a model is shown is capped at <Strong>200</Strong> entries; a bulk import says
        &quot;and 9,800 more&quot; rather than filling a prompt. The Run page renders the full
        history.
      </P>

      <H2 id="tools">What an AI Employee can read</H2>
      <P>
        Until now there was no run-reading tool in Genosyn at all, which made a whole class of
        question unanswerable from inside the company: a manager asked why a colleague&apos;s work
        was not landing, or an employee briefed about one of its own Routines being stood down, had
        nothing to open. Two tools close that, and neither writes anything.
      </P>
      <KeyList
        rows={[
          {
            term: "list_runs",
            def: "Terminal Runs for one of your Routines — or your own recent Runs across all of them — with each Run's status, checks verdict, outcome verdict and token cost.",
          },
          {
            term: "get_run_report",
            def: "One Run's Check results, every remediation round included, plus its Effects. The first time an AI Employee can read what a Run actually did rather than what it said.",
          },
        ]}
      />
      <Callout kind="warn" title="No tool writes a Check or lifts a Standdown">
        <P>
          An employee reads its Routine&apos;s Checks in its Run brief and can read any Run&apos;s
          report, but nothing in the catalogue creates, edits or deletes a Check — a bar the graded
          party can author is not a bar. The same holds for{""}
          <DocLink to="/docs/standdowns">Standdowns</DocLink> in both directions.
        </P>
      </Callout>
      <H2 id="unverified">
        <Code>unverified</Code> is not <Code>unclear</Code>
      </H2>
      <P>
        The outcome check used to record two very different situations with one word.{""}
        <Code>unclear</Code> means the checker read the evidence and honestly could not tell.{""}
        <Code>unverified</Code> means <Strong>no judgement was ever produced</Strong> — the checker
        errored, timed out, or ended without submitting.
      </P>
      <P>
        The collision was load-bearing in the wrong direction. Every consumer downstream read
        &quot;we could not verify&quot; as &quot;nothing was wrong,&quot; so an outage in the
        checker earned an employee the same credit as a graded success. They are separate verdicts
        now, and <Code>unverified</Code> counts against{""}
        <DocLink to="/docs/autonomy">earned autonomy</DocLink> exactly like a bad Run.
      </P>
      <P>
        A Run whose grading never happened at all is also no longer invisible. Genosyn stamps when
        the check last reached a judgement of any kind, and a sweep re-grades completed Runs still
        missing one — a process that died inside the verdict window used to strand its Run with a
        null verdict forever, and a null verdict counted as clean. How stale a Run must be, and how
        many are re-graded per pass, are at <Strong>Admin → Runtime</Strong>.
      </P>

      <H2 id="remediation">Bounded remediation</H2>
      <P>
        When a required Check fails, the Run is not finished — but it does not get to try forever
        either. Genosyn briefs the employee with the failing Check&apos;s name and detail and lets
        it try again, for at most <Strong>two further rounds</Strong>, entirely inside the
        Routine&apos;s existing <Code>timeoutSec</Code>. There is no extra time budget and no third
        round.
      </P>
      <P>
        Every round&apos;s results are kept, so the strip on the Run is honest about a Run that only
        went green on the second try, and the number of rounds spent shows beside the verdict. If
        the Check still fails, the Run finalizes with <Code>checksVerdict: failed</Code> — a real
        outcome, notified like any other bad Run, not a retry loop nobody watched.
      </P>

      <H2 id="consequences">What a failed Check costs</H2>
      <UL>
        <LI>
          It <Strong>revokes every active Waiver</Strong> the employee holds, on the spot, exactly
          like a Run graded off goal. See <DocLink to="/docs/autonomy">Earned autonomy</DocLink>.
        </LI>
        <LI>
          It <Strong>writes a Lesson</Strong> into the Routine&apos;s future briefs, with the
          failing Check as the cause the retrospective starts from. See{""}
          <DocLink to="/docs/improvement">The improvement loop</DocLink>.
        </LI>
        <LI>
          It counts toward the Routine&apos;s consecutive-failure streak, which is what trips the
          circuit breaker into a <DocLink to="/docs/standdowns">Standdown</DocLink>.
        </LI>
      </UL>

      <Callout kind="info" title="A green Run should be hard to fake.">
        The graded party wrote the transcript, and every judgement built on it inherits that. Checks
        and the Effects list exist so that at least one thing the platform believes about a Run came
        from somewhere else.
      </Callout>
    </>
  );
}
