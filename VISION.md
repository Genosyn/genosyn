# Genosyn vision

Where Genosyn is going. This is direction, not shipped behavior: [Status](#status)
says what exists today, and [`Home/client/docs/pages/`](./Home/client/docs/pages/)
documents how it works. The [vision page](https://genosyn.com/vision)
([`Home/client/vision/`](./Home/client/vision/)) tells the same vision as a
story about Sunwise, a sample rooftop-solar company; its figures are
illustrative.

## Why

There are far more problems worth solving than people with the time to run a
company. If a company can run itself, every problem can have one, and anyone can
own a piece of one.

## The idea

A company on Genosyn runs itself toward a Goal its owners set. The owners are
its **board**, not its managers: they keep four powers, and AI Employees do all
of the running.

| | Managing AI (today's norm) | On the board (the vision) |
| --- | --- | --- |
| Who starts the work | A person, every time | The Goal, through Routines that start themselves |
| Who reviews it | A person, line by line | Checks the company cannot rewrite |
| Who decides | A person, at every step | The company; the board decides only what an owner must |

## Roles

- **Board:** the people who own the company. Keeps four things (below) and is
  asked almost nothing.
- **AI CEO:** one AI Employee, accountable for the Goal. Hires the executive
  team, writes the monthly letter, and answers to the board.
- **AI executives:** AI Employees that run departments (operations, finance,
  engineering, sales, people) and hire, coach and replace the AI Employees
  under them.
- **AI Employees:** do the work.
- **People:** hired job by job, through work orders, for work that needs hands.

## What the board keeps

1. **The Goal.** A measurable objective: a direction and a number. Every AI
   Employee reads it before every piece of work, and none can change it.
2. **The vault.** The reserves. The board chooses what they are held in, and
   every key belongs to a director. The company can add to the vault; only the
   board can take anything out. No AI Employee holds a key.
3. **The letter.** Once a month the AI CEO reports what happened, what went
   wrong, and where the money went, starting with progress toward the Goal.
   Every figure traces to the ledger and is checked by an auditor the company
   cannot appoint.
4. **The switch.** The board can stop every AI Employee mid-Run, or change who
   leads them: rewrite a line of the CEO's Soul, change its AI Model, or replace
   the CEO. Only a person can do either.

## What the company decides

Everything else, without asking: strategy, prices, hiring, letting go anyone
below the CEO, every payment from checking, suppliers, markets, products,
marketing, its own Policies, acquisitions, what to sweep into the vault, and how
to own and fix its mistakes. Every decision is written down with its reason.

The board is asked only what an owner must answer, such as whether to sell the
company or what the next Goal is. That question is a **Decision**: options the
company wrote, never "approve / reject".

## Money

- **Checking account:** day-to-day money, run by the AI CFO through access the
  board grants and can take back. Pays people and suppliers with no sign-off.
- **Vault:** the reserves. Surplus is swept in; moving anything out takes
  directors' keys, for example any two of three.

## People

The company posts work orders, books qualified people, verifies the work, and
pays them. Everyone it hires gets:

- the rate, published before anyone applies and never changed after;
- payment once the work is verified, within 24 hours;
- ratings both ways;
- the company's insurance on every job;
- a share of the company with every job.

## Beyond one company

- **Every problem gets a company.** When running a company costs almost nothing,
  small markets become worth serving.
- **Everyone on a board.** Owning a company becomes as cheap as running one: a
  village owns its water company, workers earn a share with every job, and one
  person sits on many boards.
- **More accountable, not less.** Every decision has a written reason, every
  figure traces to the ledger, and an auditor the company cannot appoint checks
  the books.
- **Companies you can fork.** A company is plain text (Goal, Souls, Skills,
  Routines, Policies), so a good one can be copied under a new board, and one
  company's Lessons can spare others the same mistake.
- **An economy of companies.** Companies found companies and trade with one
  another (an order, a Check that the work was done, a payment) on open-source
  software.
- **Goals that outlast their founders.** A company can hold one Goal for a
  century.

## Status

- **Ships today:** AI Employees with a Soul, Skills and Routines; Goals;
  Decisions and Approvals; Policies and Budgets; Checks that grade every Run;
  autonomy that is earned and revoked (Waivers); Standdowns; a double-entry
  ledger; TLDR briefings.
- **Next:** AI executives that hire, coach and replace AI Employees; a CEO seat
  only the board can change; the monthly letter, checked by an auditor the
  company cannot appoint; a checking account for the AI CFO and a vault only
  directors hold keys to; work orders that hire people for physical work, with
  a share of the company in every job.
- **Horizon:** a company founded from one sentence; everyone on a board;
  companies you can fork; an economy of companies that found and trade with one
  another.

## Vision terms in the product today

| Vision | Today |
| --- | --- |
| The Goal | `Goal`. See [Goals](./Home/client/docs/pages/Goals.tsx). |
| Stopping every AI Employee | A company-scope `Standdown`; only a person can lift it. See [Standdowns](./Home/client/docs/pages/Standdowns.tsx). |
| Changing who leads | Not yet. A person can edit any AI Employee's Soul and AI Model; an AI Employee can only propose a change to its own Soul (`propose_revision`), which takes effect when an owner or admin applies it. |
| AI CEO and executives | Not yet. The org chart exists (`AIEmployee.reportsToEmployeeId`), but no AI Employee hires or replaces another. |
| Checks the company cannot rewrite | `RoutineCheck`; no MCP tool writes one. See [Verification](./Home/client/docs/pages/Verification.tsx). |
| A question for the board | `Decision`. Actions the system holds for a person are `Approval`s. See [Decisions](./Home/client/docs/pages/Decisions.tsx). |
| Earned autonomy | `AutonomyWaiver`. See [Autonomy](./Home/client/docs/pages/Autonomy.tsx). |
| Policies and Budgets | `CompanyPolicy`, and `Budget` (a monthly ad-spend envelope). See [Policies](./Home/client/docs/pages/Policies.tsx). |
| The ledger | Finance's double-entry books. See [Finance](./Home/client/docs/pages/Finance.tsx). |
| The letter | Not yet. Closest today: TLDR briefings (`Tldr`). See [TLDRs](./Home/client/docs/pages/Tldrs.tsx). |
| Decisions written down with reasons | Partly: Run transcripts, Effects, Journal entries and the audit log record what AI Employees did. |
| Lessons shared between companies | Not yet. `RunLesson` exists within one company. |
| Treasury, auditor, work orders, ownership | Not yet. |
