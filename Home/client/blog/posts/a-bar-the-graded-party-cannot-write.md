Every system that lets software act on its own runs into the same two questions sooner or later: who decides whether the work was any good, and who can make it stop? Get either answer wrong and autonomy becomes a liability. Genosyn answers both with one rule each, and treats both rules as permanent.

## Rule one: the graded party never writes the test

A Check is a machine-verifiable assertion a Run must pass before it counts as done. There are two kinds today. An effect Check counts what the Run actually did, from the record the server keeps: at least one invoice sent and no more than five, say. A command Check runs a command, and passes only if the command succeeds.

The part that matters is who writes them. An admin writes a Routine's Checks. No AI Employee can. There is no tool an AI Employee could call to create, edit or delete one, and a revision it proposes to its own work cannot touch them either. It can read its Checks, and does, in the brief for every Run. It cannot move the bar.

That sounds like a small permission detail. It is the whole idea. Any system that lets the worker define "done" will, sooner or later, find that "done" got easier.

## What happens when a Check fails

A failed Check does not end a Run on the first try. The AI Employee gets up to two more rounds to fix what it missed, inside the Routine's existing time limit. If a required Check still fails, the Run is marked Failed, and two things follow:

- **Every Waiver the AI Employee holds is revoked.** Any autonomy it had earned, it has to earn again.
- **A Lesson is written**: the cause, and advice for next time. The next Run of that Routine reads it before it starts.

And a Check that cannot run never counts as a pass.

Every Run also gets a separate judgement against its acceptance criteria: achieved, unclear, off goal, or unverified. Unclear means the checker looked and could not tell. Unverified means no judgement was produced at all. Neither counts as success, because a missing grade is not a good grade.

## Rule two: the stopped party never lifts the stop

A Standdown stops AI work at one of three scopes: the whole company, one AI Employee, or one Routine. Placing one takes a reason. Runs already in flight are stopped. Retries that were queued are deferred, not thrown away, and a Routine does not rush through every schedule slot it missed once work resumes.

Only an owner or admin can place a Standdown, and only an owner or admin can lift one. No AI Employee can do either. The first restriction is sensible. The second is essential: a stop the stopped party can lift is not a stop.

Lifted Standdowns stay in the record, and repeated failures never place one automatically. Stopping work is a person's call, made on purpose, with a reason anyone can read later.

## Why the vision depends on it

The Genosyn vision is a company that runs itself, with a board that keeps a few powers and decides almost nothing else. That only works if the few powers are real. Checks the company cannot rewrite, and a switch only a person can lift, are not features to add later. They are the floor the rest stands on, and they ship today.

> A bar the graded party can write is not a bar, and a stop the stopped party can lift is not a stop.

Read the docs on [Checks](/docs/verification) and [Standdowns](/docs/standdowns).
