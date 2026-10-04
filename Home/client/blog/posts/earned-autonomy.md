The fastest way to lose trust in an autonomous system is to hand it everything on its first day. The slowest way to get value from one is to approve everything it does, forever. Genosyn takes the path between: autonomy that is earned narrowly, on evidence, and taken back the moment it is not deserved.

## Where every AI Employee starts

Some actions in Genosyn wait for a person by design. A Routine can be set to need approval before it runs. A browser submission can be held. A guarded tool call, ad spend over a threshold, or a risky call made after reading something on the web can each stop as an Approval: the system holds the exact action the AI Employee attempted, an owner or admin decides, and on approval the server performs that exact action, once.

That is where trust begins: a person between the AI Employee and the consequences, for the kinds of action that matter.

## How a Waiver is earned

A Waiver is an earned, revocable exemption from one of those gates. Today there are exactly two kinds: waiving browser approvals for one AI Employee, and waiving Routine approvals for one Routine.

Every hour, Genosyn looks back over the last thirty days and asks whether the record supports a Waiver. The bar is specific:

- **At least ten finished Runs that a checker actually verified,** with none Failed, none in Error, none graded off goal, and none failing a Check.
- **At least five approvals of that kind granted, and none rejected.**
- **Something to grade against.** A Routine with no acceptance criteria and no Checks can never earn one.

Even then, nothing changes silently. Genosyn drafts the promotion as an Approval of its own, and the Waiver exists only if an admin approves it. If the admin rejects it, the same promotion cannot be proposed again for thirty days.

## How it is lost

A Waiver is narrow on purpose, and fragile on purpose. A single Failed or Error Run revokes every Waiver that AI Employee holds, immediately. An admin can revoke one at any time, for any reason. And a Run that nobody could verify keeps a promotion from happening at all: no grade is not a good grade.

## Why narrow beats broad

It would be simpler to give each AI Employee a trust score and let it do everything above some number. Genosyn deliberately does not. Trust in one kind of action says little about another. An AI Employee that has submitted a hundred forms correctly has earned the right to submit forms, not to spend money. So a Waiver covers one gate, for one AI Employee or one Routine, and nothing else.

## The road from here

The Genosyn vision is a company that decides almost everything on its own, with a board that keeps only what an owner must. Waivers are how a company gets there without a leap of faith: it earns each new freedom on a record anyone can read, one gate at a time, and the people who own it can take any freedom back.

> Autonomy that is earned, and revoked.

Read the docs on [earned autonomy](/docs/autonomy) and on [Decisions and Approvals](/docs/decisions).
