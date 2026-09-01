import { Callout, Code, DocLink, H2, KeyList, LI, P, PageHeader, Strong, UL } from "@/docs/Prose";

export function Standdowns() {
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Standdowns"
        lead={
          <>
            Every other guardrail in Genosyn is per-action and decided before the fact: an Approval
            holds one call, a Budget refuses one payment, a Policy blocks one recipient. A{" "}
            <Strong>Standdown</Strong> is the other instrument — a revocable stop on all AI work at
            company, employee, or Routine scope, placed by a human or tripped by the
            consecutive-failure breaker.
          </>
        }
      />

      <Callout kind="info" title='"Standdown" is the word.'>
        Genosyn never says &quot;pause,&quot; &quot;hold,&quot; &quot;suspend,&quot; or
        &quot;freeze&quot; for this — <Strong>hold</Strong> already means a tainted-turn call
        waiting on an Approval. A Standdown is the exact inverse of a{" "}
        <DocLink to="/docs/autonomy">Waiver</DocLink>: a Waiver is earned, narrow, and widens what
        an employee may do without a human; a Standdown is imposed, broad, and stops it.
      </Callout>

      <H2 id="why">Why the switch had to exist</H2>
      <P>
        Before this row, the honest answers to &quot;stop, now, everything&quot; were toggling{" "}
        <Code>enabled</Code> on Routines one at a time — which stops no Wakeup, no Trigger, no mail
        automation, no sequence tick, and nobody who is chatting with the employee right now — or
        deleting the employee. Neither is a stop. A control that a colleague can accidentally route
        around by opening a chat window is not one either, which is why the two wider scopes cover
        interactive chat and the narrow one does not.
      </P>

      <H2 id="scopes">The three scopes, exactly</H2>
      <P>
        Wider scopes subsume narrower ones. What each covers is worth reading precisely, because the
        difference between them is the difference between an incident contained and an incident that
        kept going somewhere you weren&apos;t looking.
      </P>
      <KeyList
        rows={[
          {
            term: "Company",
            def: (
              <>
                <Strong>Everything.</Strong> Every Routine, every automatic retry, every{" "}
                <DocLink to="/docs/reactivity">Wakeup</DocLink> and{" "}
                <DocLink to="/docs/reactivity">Trigger</DocLink>, and interactive chat with every AI
                Employee in the company. Humans keep using the app in full; the roster stops
                working.
              </>
            ),
          },
          {
            term: "Employee",
            def: (
              <>
                <Strong>One employee, chat included.</Strong> That employee&apos;s Routines,
                retries, Wakeups, Triggers, and any conversation someone opens with it. Its
                colleagues carry on untouched.
              </>
            ),
          },
          {
            term: "Routine",
            def: (
              <>
                <Strong>One Routine&apos;s scheduled and triggered Runs</Strong> — including its
                queued retries and a manual &quot;Run now&quot;. It does <Strong>not</Strong> stop
                chat with the employee that owns it: this is the surgical scope, for one broken
                piece of work, not for an employee you have stopped trusting.
              </>
            ),
          },
        ]}
      />

      <H2 id="in-flight">What happens to work already moving</H2>
      <UL>
        <LI>
          <Strong>In-flight Runs are aborted.</Strong> A covered Run stops where it is and finalizes{" "}
          <Code>interrupted</Code> — the status that already means &quot;nobody can say what
          happened after this line&quot;. It is not marked <Code>failed</Code>, because nothing
          failed; the work was stopped.
        </LI>
        <LI>
          <Strong>Queued retries are deferred, not cancelled.</Strong> A Run with a retry pending
          keeps its due time. The dispatcher declines to start it while the Standdown is active, and
          it fires after the lift. Standing a Routine down does not silently throw away the recovery
          attempt you may still want.
        </LI>
        <LI>
          <Strong>Skipped scheduled slots still advance the schedule.</Strong> A slot that arrives
          during a Standdown is declined and the next occurrence is computed as usual, so lifting a
          month-old Standdown produces no catch-up storm — the same ceiling{" "}
          <DocLink to="/docs/routines#missed-slots">downtime recovery</DocLink> keeps, for the same
          reason.
        </LI>
        <LI>
          <Strong>Everyone covered is told.</Strong> The reason lands on a banner, in the bell for
          owners and admins, and in the Journal of every covered employee — so the employee&apos;s
          own next prompt knows why the last few hours are missing.
        </LI>
      </UL>

      <H2 id="breaker">The circuit breaker</H2>
      <P>
        A Routine can also stand itself down without anyone pressing anything. Genosyn counts{" "}
        <Strong>consecutive bad Runs</Strong> on each Routine — any terminal Run that is not{" "}
        <Code>completed</Code>, plus a completed Run whose required{" "}
        <DocLink to="/docs/verification">Checks</DocLink> failed or whose outcome graded{" "}
        <Code>off goal</Code>. The first Run that is clean on every axis resets the counter to zero.
      </P>
      <P>
        On crossing the threshold, the runner places a Standdown on that Routine, recorded with
        source <Code>breaker</Code> rather than a person. The threshold is at{" "}
        <Strong>Admin → Runtime</Strong>, under <Strong>Containment</Strong>, and defaults to{" "}
        <Strong>5</Strong>. Setting it to <Code>0</Code> disables the breaker entirely and restores
        the old behaviour: a permanently broken Routine firing every slot forever, burning model
        spend nobody is reading.
      </P>
      <Callout kind="info" title="A breaker Standdown is an ordinary Standdown.">
        It shows in the same list, needs the same admin to lift it, and carries the same reason line
        — the streak that tripped it. The source is recorded because it is worth knowing, not
        because lifting one is a different act.
      </Callout>

      <H2 id="who">Admin-only, in both directions</H2>
      <P>
        Placing a Standdown and lifting one are both owner/admin. Placing requires a{" "}
        <Strong>reason</Strong>: a stop nobody explained is a stop nobody can safely lift. Lifting
        takes an optional note, and the row stays as history — lifted Standdowns enforce nothing and
        are never deleted, so &quot;when did we stop the roster, and why&quot; stays answerable
        afterwards.
      </P>
      <Callout kind="warn" title="There is no MCP tool for this — deliberately.">
        No AI Employee can place a Standdown, and far more importantly, none can lift one. A stop
        the roster could lift is not a stop. This is the one control in Genosyn with no AI-facing
        surface in either direction.
      </Callout>

      <H2 id="not-enabled">
        It is not the <Code>enabled</Code> switch
      </H2>
      <P>
        <Code>Routine.enabled</Code> remains exactly what it was: the ordinary, per-Routine on/off
        for work you are done with, editing, or seasonally retiring. It is untouched by Standdowns
        and unchanged by lifting one. A Routine disabled before a Standdown is still disabled after
        it.
      </P>
      <P>
        Use the switch for housekeeping. Use a Standdown for an incident — it is the emergency
        instrument, it records who and why, it covers the surfaces the switch cannot reach, and it
        is designed to be lifted rather than to be lived with.
      </P>

      <Callout kind="info" title="Stopping should be as easy as starting.">
        Genosyn spends a lot of design on letting an AI Employee do more without asking — Waivers,
        Triggers, Wakeups, Initiatives. All of that is only defensible if the other direction is one
        button, available to a human at three scopes, that the roster cannot reach.
      </Callout>
    </>
  );
}
