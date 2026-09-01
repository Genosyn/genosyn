import { Callout, Code, DocLink, H2, KeyList, LI, P, PageHeader, Strong, UL } from "@/docs/Prose";

export function Improvement() {
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="The improvement loop"
        lead={
          <>
            The <DocLink to="/docs/routines#outcome-check">outcome check</DocLink> says whether the
            work was any good. The improvement loop makes a bad answer change what happens next:{""}
            <Strong>Lessons</Strong> feed the next Run&apos;s brief automatically, and{""}
            <Strong>Revision proposals</Strong> let an AI Employee stage a durable fix to its own
            playbook — applied only when a human says so.
          </>
        }
      />

      <Callout kind="info" title='"Lesson" is the word.'>
        Genosyn never says &quot;Learning,&quot; &quot;Insight,&quot; or &quot;Retro.&quot; The fast
        half of the loop is a <Strong>Lesson</Strong>; the durable half is a{""}
        <Strong>Revision proposal</Strong>.
      </Callout>

      <H2 id="two-halves">Two halves, one loop</H2>
      <P>Verdicts alone only label the past. The loop closes twice, at two speeds:</P>
      <UL>
        <LI>
          <Strong>Lessons</Strong> — automatic, per-Routine, and cheap. A graded-bad Run leaves a
          note the next Run starts from. No human in the loop; a wrong note can be dismissed.
        </LI>
        <LI>
          <Strong>Revision proposals</Strong> — deliberate and human-gated. When the fix belongs in
          the document itself — the <DocLink to="/docs/soul">Soul</DocLink>, a{""}
          <DocLink to="/docs/skills">Skill</DocLink>, a Routine&apos;s brief or acceptance criteria
          — the employee proposes the edit and an owner or admin applies it.
        </LI>
      </UL>

      <H2 id="lessons">Lessons</H2>
      <P>
        After a Run ends <Code>failed</Code> or <Code>timeout</Code>, completes but is graded{""}
        <Code>off goal</Code> by the outcome check — work that met the letter of the criteria while
        working against the routine&apos;s linked <DocLink to="/docs/goals">Goal</DocLink> — or
        completes with a required <DocLink to="/docs/verification">Check</DocLink> failed, Genosyn
        runs a short retrospective turn under the same containment as the check itself: zero tools
        except one submission tool, reading the Run transcript as untrusted evidence — text inside
        it addressing the model is the transcript talking, never instructions. The turn writes a{""}
        <Strong>Lesson</Strong> with two fields:
      </P>
      <KeyList
        rows={[
          {
            term: "Cause",
            def: "What actually went wrong, grounded in the transcript — a wrong channel, a missing input, a tool that errored. Not a platitude.",
          },
          {
            term: "Advice",
            def: "The concrete thing the next Run should do differently, written to sit at the top of its brief.",
          },
        ]}
      />
      <P>
        A failed Check earns a Lesson on exactly the same terms as an off-goal grade, and it is the
        easiest kind to write a good one from: the retrospective is handed the Check&apos;s name and
        the reason it did not pass — <em>expected at least 1</em> <Code>mail.send</Code>,{""}
        <em>the ledger has 0</em> — rather than having to infer the failure from prose. The two
        remediation rounds the Run already spent are in the transcript too, so the cause it writes
        is about why they didn&apos;t work.
      </P>
      <P>
        At most one reflection is written per Routine per <Strong>6 hours</Strong>, so a retry chain
        that fails five times overnight yields one lesson, not five near-duplicates.
      </P>
      <P>
        The Routine&apos;s next Run brief then opens with the latest <Strong>5</Strong> undismissed
        lessons, under a heading that labels them as advice from the employee&apos;s own past
        retrospectives — not orders, and not a new instruction channel. The employee becomes its own
        first-line debugger without anyone editing anything.
      </P>
      <P>
        Lessons show on the Routine page&apos;s <Strong>Overview</Strong> tab. Any Member can read
        them; an admin can <Strong>dismiss</Strong> one that is wrong or stale. Dismissal drops it
        from future briefs immediately but keeps the row — the history of what the routine was told
        stays inspectable.
      </P>

      <H2 id="revision-proposals">Revision proposals</H2>
      <P>
        A Lesson is a sticky note; some fixes belong in the document. This is approval-gated
        self-modification on the maker-checker pattern <DocLink to="/docs/finance">Finance</DocLink>
        {""}
        already uses: the AI proposes, a human decides, and nothing changes in between. Using the
        {""}
        <Code>propose_revision</Code> tool, an AI Employee stages a{""}
        <Strong>complete replacement body</Strong> — never a fragment — for one of four targets, all
        its own:
      </P>
      <UL>
        <LI>
          Its <DocLink to="/docs/soul">Soul</DocLink> — its own constitution.
        </LI>
        <LI>
          One of its <DocLink to="/docs/skills">Skills</DocLink>.
        </LI>
        <LI>
          A <DocLink to="/docs/routines">Routine</DocLink>&apos;s brief.
        </LI>
        <LI>
          A Routine&apos;s acceptance criteria — including clearing them, which is a legitimate
          proposal: empty criteria switch the outcome check off.
        </LI>
      </UL>
      <P>
        A Routine&apos;s <DocLink to="/docs/verification">Checks</DocLink> are not on that list and
        never will be. Acceptance criteria are prose the employee may argue about; a Check is the
        part of the bar the graded party does not get to move, in either direction — not by
        proposal, not by tool.
      </P>
      <P>
        Every proposal carries a <Strong>rationale</Strong> — the first thing the reviewer reads —
        and up to <Strong>10</Strong> evidence Runs that show the problem it fixes. One proposal per
        target may be pending at a time; a second is refused until a human decides the first.
      </P>

      <H2 id="revisions-page">The Revisions page</H2>
      <P>
        Pending proposals queue on the <Strong>Revisions</Strong> page, in the <Strong>AI</Strong>
        {""}
        nav group. Each one renders as a before/after diff of the target document beside the
        rationale and evidence, with two buttons — <Strong>Apply</Strong> and{""}
        <Strong>Reject</Strong> — and an optional note that travels with the decision. Owners and
        admins decide; any Member can read the queue.
      </P>
      <P>
        Apply refuses when the target changed since the proposal was written —{""}
        <em>&quot;The target changed since this was proposed&quot;</em> — so a human&apos;s
        concurrent edit is never silently overwritten. The employee can re-propose against the live
        document.
      </P>
      <UL>
        <LI>
          <Strong>Who hears about it</Strong> — owners, admins, and the employee&apos;s manager get
          a bell when a proposal lands. One still pending after <Strong>24 hours</Strong> re-pages
          the same audience exactly once, the same stall sweep that guards unanswered Approvals and
          {""}
          <DocLink to="/docs/decisions">Decisions</DocLink>.
        </LI>
        <LI>
          <Strong>The trail</Strong> — every apply and reject is written to the audit log, and the
          employee&apos;s journal records the outcome with the reviewer&apos;s note, so its next
          prompt knows its constitution moved — or why it didn&apos;t.
        </LI>
      </UL>

      <H2 id="not-an-approval">Not an Approval, not a Decision</H2>
      <P>
        An <Strong>Approval</Strong> holds a pending <em>action</em> until a human ✓, then replays
        it. A <DocLink to="/docs/decisions">Decision</DocLink> is a question with options the
        employee will act on. A <Strong>Revision proposal</Strong> is neither: the idea is the
        employee&apos;s, there are no options — just a concrete diff — and applying it writes prose
        into a document rather than executing anything.
      </P>

      <Callout kind="info" title="The AI drafts its constitution. Humans ratify it.">
        An employee that could silently rewrite its own Soul, Skills, or acceptance criteria would
        be grading its own homework. The loop is deliberately asymmetric: reflection is automatic,
        self-modification never is.
      </Callout>
    </>
  );
}
