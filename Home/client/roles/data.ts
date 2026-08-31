/**
 * Role registry — the single source of truth for the marketing role pages,
 * the landing page's day-in-the-life section, their SEO metadata, sitemap
 * entries, and the llms.txt files.
 *
 * Deliberately pure data (no JSX, no React imports): vite.config.ts imports
 * this module at build time to prerender routes. Icons are referenced by key
 * and resolved in roleIcons.ts.
 *
 * ## Why this exists
 *
 * "Autonomous company" is an abstraction, and abstractions do not sell. What
 * a reader actually wants to know is what happens on a Tuesday: at 09:00, at
 * 11:00, at 16:40 — and what is sitting in their inbox by the time they get
 * up. Every role here is written as a real working day, hour by hour, because
 * a schedule is the only honest way to show what "it runs without you" means.
 *
 * Copy rules: only shipped capabilities are claimed, and every hour of every
 * day maps to a product that exists (see products/data.ts). Vocabulary
 * follows AGENTS.md §3 — Routine, Run, Soul, Skill, AI Employee, Member,
 * Integration, Connection, Grant, Decision, Sequence, Contact, Deal.
 */

/** One hour of a role's working day. */
export type RoleMoment = {
  /** Wall-clock label, e.g. "09:00". */
  time: string;
  /** Hours past midnight. Drives position on the 24-hour strip. */
  at: number;
  title: string;
  body: string;
  /** The product this hour of work happens in. */
  where: string;
  /**
   * `decision` marks the one or two moments a day the employee stops and asks
   * a human. They are the point of the schedule, not an exception to it — a
   * day with no marked moments would be a claim nobody believes.
   */
  kind?: "work" | "decision";
};

export type RoleOutput = {
  value: string;
  label: string;
};

export type RoleCapability = {
  icon: string;
  title: string;
  body: string;
};

export type RoleFaq = {
  q: string;
  a: string;
};

export type RoleDef = {
  slug: string;
  /** Full product name, e.g. "AI SDR". */
  name: string;
  /** Short label for tabs and chips, e.g. "SDR". */
  short: string;
  /**
   * The job as it appears mid-sentence, with its article — "an SDR", "a
   * bookkeeper". Written out rather than derived, because lowercasing `short`
   * turns SDR into sdr and picking a/an from the first letter gets "a hour"
   * wrong the first time somebody adds a role beginning with a vowel sound.
   */
  noun: string;
  /** The example employee's name, so the day reads like a colleague's. */
  person: string;
  /** What a human would call this job. */
  discipline: string;
  icon: string;
  /** Tinted icon-tile classes — this role's one hue, used sparingly. */
  accent: string;
  /** The plain dot version of the same hue, for timelines. */
  dot: string;
  /** Two-tone H1: `headline` in zinc-950, `headlineMuted` in zinc-400. */
  headline: string;
  headlineMuted: string;
  /** One-liner for cards and tab strips. */
  summary: string;
  /** <title> tag, aim for ≤ 60 chars. */
  seoTitle: string;
  /** Meta description, aim for ~155 chars. */
  description: string;
  /** Hero paragraph on the role page. */
  intro: string;
  /** The honest version of what a human stops doing. */
  reclaims: string;
  day: RoleMoment[];
  outputs: RoleOutput[];
  /** What it brought back to a human, verbatim. */
  decisions: string[];
  /** Skills this role ships with, as a human would name them. */
  skills: string[];
  /** Routines and their schedule in plain English. */
  routines: { name: string; when: string }[];
  /** The Connections and resources it needs granted. */
  grants: string[];
  /** Product slugs it works inside. */
  products: string[];
  capabilities: RoleCapability[];
  faqs: RoleFaq[];
  keywords: string[];
};

export const ROLES: RoleDef[] = [
  // ───────────────────────────────── SDR ─────────────────────────────────
  {
    slug: "sdr",
    name: "AI SDR",
    short: "SDR",
    noun: "an SDR",
    person: "Robin",
    discipline: "Sales development",
    icon: "target",
    accent: "bg-sky-50 text-sky-700 ring-sky-200",
    dot: "bg-sky-500",
    headline: "Books meetings",
    headlineMuted: "while the pipeline builds itself.",
    summary:
      "Researches accounts, writes the outbound, reads every reply, and books the meeting — on a schedule, without a list-building afternoon.",
    seoTitle: "AI SDR — outbound that runs itself · Genosyn",
    description:
      "An AI SDR that researches accounts, writes and sends outbound Sequences, reads every reply, and books meetings — running on cron, working your Revenue records, escalating only real judgement calls.",
    intro:
      "Outbound fails on consistency, not on ideas. An AI SDR works the same list every single morning: it reads last night's product Signals, researches the accounts that moved, writes the opener for each one, sends the day's Sequence step, and handles the replies before you have finished your coffee. Every Contact, Deal, and touch lands in Revenue, so a human AE opens a pipeline that is already warm.",
    reclaims:
      "The two hours a day an AE loses to list building, enrichment, and copy-pasting the same email into a new tab.",
    day: [
      {
        time: "06:40",
        at: 6.67,
        title: "Reads what happened while everyone slept",
        body: "Pulls the overnight Signals — trials started, seats added, docs read three times — and scores each account against the ideal-customer profile written into its Soul. 31 accounts moved; 9 are worth a human's time.",
        where: "Revenue · Signals",
      },
      {
        time: "07:55",
        at: 7.92,
        title: "Builds the day's list, and kills the duplicates",
        body: "Enriches 74 new Contacts, merges the 6 that already existed under a different address, and drops the 12 sitting inside an open Deal. Nobody gets prospected by a company they are already buying from.",
        where: "Revenue · Contacts",
      },
      {
        time: "09:00",
        at: 9,
        title: "Sends the first touch",
        body: "58 first-step emails go out, each one written against what that account actually did — not a merge tag with a first name in it. Sending is throttled and every address is checked against the suppression list first.",
        where: "Revenue · Sequences",
      },
      {
        time: "10:20",
        at: 10.33,
        title: "Works the replies, not the inbox",
        body: "Reads all 14 responses. Books 3 meetings straight into the AE's calendar, answers 5 questions from the docs, routes 2 support issues to the right queue, and honours 1 unsubscribe immediately and permanently.",
        where: "Email",
      },
      {
        time: "11:00",
        at: 11,
        title: "Second angle on last week's silence",
        body: "Re-approaches the accounts that opened but never replied — different angle, shorter, one specific question. Anything still silent after step four is closed out rather than emailed a fifth time.",
        where: "Revenue · Sequences",
      },
      {
        time: "13:30",
        at: 13.5,
        title: "Asks before it crosses a line",
        body: "One target account is already flagged in the Customers record as an escalation with Legal. Instead of guessing, it writes a Decision with both options and the context, and moves on to the rest of the list.",
        where: "Decisions",
        kind: "decision",
      },
      {
        time: "15:10",
        at: 15.17,
        title: "Researches tomorrow",
        body: "Reads funding news, job posts, and stack changes for the next 40 accounts, then drafts the opener for each and files the evidence on the Contact so the AE can see why it said what it said.",
        where: "Revenue · Contacts",
      },
      {
        time: "17:45",
        at: 17.75,
        title: "Reports like a person would",
        body: "Posts the day to the sales channel: what was sent, what came back, which 3 meetings are on the calendar, and the two accounts it thinks are dead and why.",
        where: "Workspace",
      },
    ],
    outputs: [
      { value: "3", label: "Meetings on the calendar" },
      { value: "118", label: "Emails sent, none duplicated" },
      { value: "1", label: "Decision that needed you" },
    ],
    decisions: [
      "Northstar is in Legal's escalation list — do I still run outbound into it?",
      "Two AEs both own contacts at Vertex. Which one gets the meeting?",
    ],
    skills: [
      "score-inbound-signal",
      "research-account",
      "write-first-touch",
      "handle-reply",
      "book-meeting",
    ],
    routines: [
      { name: "Overnight signal sweep", when: "Every weekday, 06:40" },
      { name: "Daily sequence step", when: "Every weekday, 09:00" },
      { name: "Reply triage", when: "Every 30 minutes, 08:00–19:00" },
      { name: "End-of-day sales note", when: "Every weekday, 17:45" },
    ],
    grants: [
      "Gmail Connection for the outbound mailbox",
      "Revenue — Contacts, Deals, Sequences, Signals",
      "The positioning notebook in Notes",
      "The competitive teardown in Resources",
    ],
    products: ["revenue", "email", "workspace", "customers"],
    capabilities: [
      {
        icon: "search",
        title: "Research that leaves evidence",
        body: "Every claim in an opener traces back to something it read — a job post, a changelog, a Signal in your own product. The sources sit on the Contact timeline, so an AE can see the reasoning before the call.",
      },
      {
        icon: "mailPlus",
        title: "Sequences with a stop condition",
        body: "Multi-step outbound with per-step delays, reply detection, and a hard stop. A Contact who replies leaves the Sequence; a Contact who never engages is closed out instead of touched a fifth time.",
      },
      {
        icon: "shieldAlert",
        title: "Suppression it cannot override",
        body: "Unsubscribes, bounces, and blocked domains are checked before every send, and the employee has no tool that removes an address from the list. That is a deliberate gap, not an oversight.",
      },
      {
        icon: "handshake",
        title: "Hands off cleanly",
        body: "A booked meeting arrives with the thread, the research, and the reason it converted — assigned to the right human on the right Deal, not dropped in a channel for someone to notice.",
      },
    ],
    faqs: [
      {
        q: "Will it send email from my domain without me seeing it?",
        a: "Only if you grant it send access. Email access levels are read, draft, and send — start it on draft, read a week of its outbound, and promote it when you trust the writing. Everything it sends is on the thread and the Contact timeline either way.",
      },
      {
        q: "How is this different from a sequencer with AI copy?",
        a: "A sequencer waits for someone to load a list into it. This researches the list, writes the copy, sends the step, reads the reply, and books the meeting on its own schedule — and when it hits something genuinely ambiguous it writes a Decision instead of guessing.",
      },
      {
        q: "What stops it from emailing the same person twice?",
        a: "Contacts are deduplicated on the way in, and an address inside an open Deal or on the suppression list is excluded before a Sequence is built. Both checks run server-side, not as an instruction in a prompt.",
      },
    ],
    keywords: [
      "AI SDR",
      "AI sales development representative",
      "automated outbound",
      "AI prospecting",
      "AI cold email",
      "autonomous sales development",
    ],
  },

  // ───────────────────────── Executive assistant ─────────────────────────
  {
    slug: "executive-assistant",
    name: "AI Executive Assistant",
    short: "Executive assistant",
    noun: "an executive assistant",
    person: "Avery",
    discipline: "Operations",
    icon: "calendarCheck",
    accent: "bg-violet-50 text-violet-700 ring-violet-200",
    dot: "bg-violet-500",
    headline: "Hands you a day",
    headlineMuted: "that has already been sorted out.",
    summary:
      "Guards the calendar, triages the inbox, turns meetings into owned Todos, and briefs you before every conversation you walk into.",
    seoTitle: "AI Executive Assistant — your day, pre-sorted · Genosyn",
    description:
      "An AI executive assistant that guards your calendar, triages your inbox, turns meetings into assigned Todos, and briefs you before every conversation — running on its own schedule, escalating by exception.",
    intro:
      "The job of an executive assistant is to make sure nothing lands on you that did not need to. This one starts before you do: it reads the calendar for collisions, writes the briefing you will read at breakfast, clears the routine two-thirds of your inbox, and turns yesterday's meetings into Todos with names against them. What reaches you is the short list only you can settle.",
    reclaims:
      "The first ninety minutes of every morning, and the low-grade dread of a calendar nobody is watching.",
    day: [
      {
        time: "06:30",
        at: 6.5,
        title: "Fixes the calendar before you see it",
        body: "Finds tomorrow's double-booking, the meeting with no agenda, and the call that leaves eight minutes to cross town. Reschedules what it can inside the rules you set, and stacks the rest.",
        where: "Workspace",
      },
      {
        time: "07:45",
        at: 7.75,
        title: "Writes the briefing",
        body: "Your TLDR, in reading order: what shipped overnight, what the numbers did, what is waiting on you, and the answers to the standing questions you asked once and never have to ask again.",
        where: "Workspace · TLDR",
      },
      {
        time: "09:00",
        at: 9,
        title: "Clears the inbox you would have opened",
        body: "Answers the 61% that is genuinely routine, drafts the 27% that needs your voice and leaves it for one click, and flags the 12% that is actually a decision. Nothing is deleted, everything is on the thread.",
        where: "Email",
      },
      {
        time: "10:30",
        at: 10.5,
        title: "Turns talk into owned work",
        body: "Yesterday's meeting notes become Todos with an owner and a date, filed in the right Project. Last week's that nobody moved get a polite nudge to the person who took them.",
        where: "Tasks",
      },
      {
        time: "11:00",
        at: 11,
        title: "Protects the block you keep losing",
        body: "Books the two things you said 'sometime this week' about — around the deep-work block, not through it. A meeting request that would break it gets offered three alternatives instead.",
        where: "Workspace",
      },
      {
        time: "14:15",
        at: 14.25,
        title: "Asks the one question it cannot answer",
        body: "Two commitments now collide and neither is obviously smaller. It writes a Decision with both options, what each costs, and its own recommendation — then waits, without blocking anything else.",
        where: "Decisions",
        kind: "decision",
      },
      {
        time: "16:20",
        at: 16.33,
        title: "Prepares tomorrow's conversations",
        body: "One short brief per meeting: who is in the room, what you agreed last time, the number you will be asked for, and the open thread you forgot about.",
        where: "Notes",
      },
      {
        time: "20:00",
        at: 20,
        title: "Closes the loop on the small stuff",
        body: "Files the receipts, submits the expenses, sends the two follow-ups you promised in the room, and queues tomorrow's briefing.",
        where: "Finance",
      },
    ],
    outputs: [
      { value: "88%", label: "Of the inbox handled without you" },
      { value: "17", label: "Todos created with an owner" },
      { value: "1", label: "Decision that needed you" },
    ],
    decisions: [
      "Sarah wants your Thursday 15:00. It collides with board prep — which one moves?",
      "The investor update is due Friday. Draft it from the quarter's numbers, or wait for your outline?",
    ],
    skills: [
      "triage-inbox",
      "prepare-tldr",
      "defend-calendar",
      "meeting-to-todos",
      "prepare-meeting-brief",
    ],
    routines: [
      { name: "Calendar sweep", when: "Every day, 06:30" },
      { name: "Morning TLDR", when: "Every day, 07:45" },
      { name: "Inbox triage", when: "Hourly, 08:00–19:00" },
      { name: "Tomorrow's briefs", when: "Every weekday, 16:20" },
    ],
    grants: [
      "Gmail Connection for your mailbox",
      "Google Calendar Connection",
      "The Projects it may create Todos in",
      "The company handbook in Notes",
    ],
    products: ["workspace", "email", "tasks", "notes", "finance"],
    capabilities: [
      {
        icon: "inbox",
        title: "Triage that leaves a trail",
        body: "Every message it handled shows what it did and why on the thread itself. Nothing is archived silently, and a reply you did not like is one sentence away from being corrected in its Soul.",
      },
      {
        icon: "calendarClock",
        title: "A calendar with rules",
        body: "Write the rules in plain language — no meetings before 09:30, Thursday afternoons are for writing, travel needs 45 minutes — and it books, moves, and defends against them without asking every time.",
      },
      {
        icon: "listChecks",
        title: "Meetings that produce work",
        body: "Notes become Todos with owners and dates in the Project they belong to, and the ones nobody moved get chased. The follow-up problem is a scheduling problem, and it is on a schedule now.",
      },
      {
        icon: "bookOpenCheck",
        title: "Standing questions",
        body: "Ask 'how much cash is left' or 'what slipped this week' once, at TLDR settings, and every briefing answers it — with a one-click suggested action attached when there is something to do about it.",
      },
    ],
    faqs: [
      {
        q: "Can it reply to people as me?",
        a: "It replies from the mailbox you grant it, at the access level you set: read, draft, or send. Most people start it on draft for a fortnight, read what it would have said, and promote it once the voice is right.",
      },
      {
        q: "What happens when it gets something wrong?",
        a: "You edit its Soul — one markdown document — the way you would correct a new assistant. The change applies from the next Run, and you can read the Run that got it wrong line by line to see what it was working from.",
      },
      {
        q: "Does it need access to everything?",
        a: "No. Access is granted per resource: this mailbox, this calendar, these Projects, this notebook. An assistant with no Finance Grant cannot see your ledger, and there is no way for it to grant itself one.",
      },
    ],
    keywords: [
      "AI executive assistant",
      "AI chief of staff",
      "AI inbox triage",
      "AI calendar management",
      "autonomous executive assistant",
    ],
  },

  // ──────────────────────────────── Marketer ────────────────────────────────
  {
    slug: "marketer",
    name: "AI Marketer",
    short: "Marketer",
    noun: "a marketer",
    person: "Alex",
    discipline: "Marketing",
    icon: "megaphone",
    accent: "bg-pink-50 text-pink-700 ring-pink-200",
    dot: "bg-pink-500",
    headline: "Ships the campaign",
    headlineMuted: "and reads the numbers it made.",
    summary:
      "Writes and ships the week's content, runs the paid experiments inside a Budget, and reallocates spend on evidence rather than on a Monday meeting.",
    seoTitle: "AI Marketer — content and paid, run daily · Genosyn",
    description:
      "An AI marketer that writes and ships content, runs paid experiments inside a hard Budget, reallocates spend on real numbers, and stops for a human before it raises the cap.",
    intro:
      "Most marketing dies of latency: the experiment that took a fortnight to launch, the losing ad that ran all weekend, the case study that never got written. An AI marketer closes that gap by working every day — reading yesterday's numbers before the office opens, shipping the variant by lunch, and reporting what it cost and what it moved. Real spend stays behind a Budget and a human checkmark.",
    reclaims:
      "The week between having the idea and seeing the number, and the Monday meeting held to find out what happened.",
    day: [
      {
        time: "05:50",
        at: 5.83,
        title: "Reads yesterday before anyone can spin it",
        body: "Pulls cost, clicks, and conversions across Google, Meta, Microsoft, and Reddit into one view, and marks the two ad sets that have spent past their target with nothing to show.",
        where: "Paid Marketing",
      },
      {
        time: "07:30",
        at: 7.5,
        title: "Stops the bleeding, inside the Budget",
        body: "Pauses the two losers outright — a decrease never waits for anybody — and queues the matching increase on the creative that is working for a human to tick in the Approvals inbox.",
        where: "Paid Marketing · Budgets",
      },
      {
        time: "08:30",
        at: 8.5,
        title: "Ships the day's words",
        body: "Writes and schedules the posts from this week's actual narrative — the release that went out, the customer who said the good line — not from a content calendar written in January.",
        where: "Notes",
      },
      {
        time: "10:00",
        at: 10,
        title: "Ships the page, not a ticket about the page",
        body: "Builds the landing-page variant against the headline that is losing, opens the pull request in the site Repository, and links the experiment that will judge it.",
        where: "Repositories",
      },
      {
        time: "11:00",
        at: 11,
        title: "Turns a call into a case study",
        body: "Takes Tuesday's customer conversation from Resources, drafts the study around the number the customer actually cited, and sends the quote back for approval before anything is published.",
        where: "Resources",
      },
      {
        time: "13:20",
        at: 13.33,
        title: "Asks to spend more",
        body: "Cost per lead holds only if the launch campaign goes from $4,000 to $6,500. It writes the case, attaches the evidence, and stops. Every spend increase queues an Approval a Member ticks — by default, no matter how small.",
        where: "Approvals",
        kind: "decision",
      },
      {
        time: "15:45",
        at: 15.75,
        title: "Rescues the pages that slipped",
        body: "Finds the ten organic pages that lost position this month, rewrites what is stale, fixes what broke, and resubmits — then records what it changed so next month's report can attribute it.",
        where: "Explore",
      },
      {
        time: "18:20",
        at: 18.33,
        title: "Writes the weekly, daily",
        body: "Posts what moved, what it cost, what it learned, and what it will try tomorrow. The Friday digest assembles itself out of these instead of being written on Friday.",
        where: "Workspace",
      },
    ],
    outputs: [
      { value: "$1,180", label: "Spend pulled off losing creative" },
      { value: "4", label: "Assets shipped, not drafted" },
      { value: "1", label: "Approval that needed you" },
    ],
    decisions: [
      "Launch spend needs to go from $4,000 to $6,500 to hold cost per lead. The increase is queued for you.",
      "The case study quotes a customer by name. Send it for their sign-off, or anonymise?",
    ],
    skills: [
      "review-yesterdays-spend",
      "write-launch-post",
      "build-landing-variant",
      "draft-case-study",
      "refresh-organic-page",
    ],
    routines: [
      { name: "Overnight performance read", when: "Every day, 05:50" },
      { name: "Creative rotation", when: "Every weekday, 07:30" },
      { name: "Content ship", when: "Every weekday, 08:30" },
      { name: "Weekly digest", when: "Fridays, 17:00" },
    ],
    grants: [
      "Google Ads, Meta, Microsoft, and Reddit Connections",
      "The site Repository",
      "The brand and positioning notebook in Notes",
      "Customer calls and transcripts in Resources",
    ],
    products: ["marketing", "notes", "repositories", "explore", "resources", "workspace"],
    capabilities: [
      {
        icon: "megaphone",
        title: "Paid, with hard guardrails",
        body: "Campaign strategy, creative review, and experiments run autonomously. Money does not: pauses and decreases go through, and every spend increase above the Connection\u2019s threshold — zero by default, so all of them — queues an Approval a human ticks.",
      },
      {
        icon: "split",
        title: "Experiments that finish",
        body: "A variant is shipped, measured, and called. Losing creative is paused the morning after it loses, not at the next weekly, because the review is a Routine rather than a meeting.",
      },
      {
        icon: "fileText",
        title: "Writing with sources",
        body: "Drop the call recordings, the PDFs, and the competitor teardowns into Resources once. Everything it writes cites them, and you can follow a claim in a blog post back to the sentence it came from.",
      },
      {
        icon: "barChart3",
        title: "Attribution it did not invent",
        body: "Charts over the databases you already connect, saved and pinned, so the weekly number is the same number your analyst would pull — not a figure the model remembered.",
      },
    ],
    faqs: [
      {
        q: "Will it spend money without asking?",
        a: "No. Turning spend down or off is ungated, because that direction cannot cost you anything. Every increase is checked against the approval threshold on the ad Connection, and that threshold is zero unless an owner deliberately raises it — so out of the box, every single increase waits in the Approvals inbox.",
      },
      {
        q: "Does it publish straight to the website?",
        a: "It opens a pull request in the site Repository. Whether that merges automatically or waits for a review is a setting on the Repository, and most teams leave it waiting for the first month.",
      },
      {
        q: "How does it avoid writing generic content?",
        a: "It writes from Resources and Notes — your calls, your positioning, your changelog — and its Soul carries the voice rules. Content with nothing specific to say is a symptom of nothing specific being granted.",
      },
    ],
    keywords: [
      "AI marketer",
      "AI marketing manager",
      "autonomous paid marketing",
      "AI content marketing",
      "AI campaign optimization",
    ],
  },

  // ───────────────────────────────── Support ─────────────────────────────────
  {
    slug: "support",
    name: "AI Support Rep",
    short: "Support",
    noun: "a support rep",
    person: "Pax",
    discipline: "Customer support",
    icon: "lifeBuoy",
    accent: "bg-cyan-50 text-cyan-700 ring-cyan-200",
    dot: "bg-cyan-500",
    headline: "Answers in minutes",
    headlineMuted: "in a timezone nobody covers.",
    summary:
      "Answers from your documented truth around the clock, files real bug reports, and turns the questions it keeps getting into docs that stop them.",
    seoTitle: "AI Support Rep — 24-hour first response · Genosyn",
    description:
      "An AI support rep that answers from your own documentation around the clock, files reproducible bugs into Tasks, and turns repeat questions into docs — escalating anything it cannot prove.",
    intro:
      "Support is a coverage problem before it is a quality problem. An AI support rep answers at 03:00 in a timezone you do not staff, from the answers you have actually written down — and when it does not know, it says so and escalates rather than inventing something plausible. The compounding part is what it does afterwards: the third time a question appears, it writes the doc that ends it.",
    reclaims:
      "The overnight backlog, and the Monday morning spent discovering what broke on Saturday.",
    day: [
      {
        time: "02:40",
        at: 2.67,
        title: "Answers while the office is dark",
        body: "Four tickets arrive from Europe and Asia. Three are answered in under six minutes from the documented answer, with the exact link. The fourth has no documented answer, so it says so and escalates.",
        where: "Email",
      },
      {
        time: "07:10",
        at: 7.17,
        title: "Re-opens what regressed",
        body: "Finds the two threads a customer replied to after they were closed, links three duplicates onto the original, and puts the one that got worse overnight at the top of the human queue.",
        where: "Email",
      },
      {
        time: "09:30",
        at: 9.5,
        title: "Writes the doc that ends the question",
        body: "The same import error has come up eleven times this month. It opens a documentation pull request with the fix, the cause, and the error string people actually paste into search.",
        where: "Repositories",
      },
      {
        time: "11:15",
        at: 11.25,
        title: "Files a bug an engineer can act on",
        body: "Reproduces the checkout failure, captures the steps and the exact log line, and files it in Tasks against the right Project — not a screenshot in a channel with 'is anyone seeing this?'.",
        where: "Tasks",
      },
      {
        time: "12:40",
        at: 12.67,
        title: "Stops at the money",
        body: "A refund request goes past what the written refund policy covers. It assembles the account history, the contract, and its recommendation into a Decision, and does not touch the money.",
        where: "Decisions",
        kind: "decision",
      },
      {
        time: "14:00",
        at: 14,
        title: "Keeps yesterday's promises",
        body: "Goes back through every thread where someone said 'I'll get back to you' and either gets back to them or explains why it is still open. Nothing ages silently.",
        where: "Email",
      },
      {
        time: "16:40",
        at: 16.67,
        title: "Tells product what it is hearing",
        body: "Groups the week's tickets by theme with counts and quotes, and posts it where the people who can fix it will read it.",
        where: "Workspace",
      },
      {
        time: "21:30",
        at: 21.5,
        title: "Hands over the night",
        body: "Writes the shift note: what is open, what is waiting on a customer, and the one thread that will need a human first thing.",
        where: "Notes",
      },
    ],
    outputs: [
      { value: "6 min", label: "Median first response, overnight" },
      { value: "11", label: "Repeat questions turned into one doc" },
      { value: "1", label: "Decision that needed you" },
    ],
    decisions: [
      "This refund is bigger than the policy covers. Full, partial, or hold the line?",
      "A customer is asking for a contractual commitment we have not made before.",
    ],
    skills: [
      "answer-from-docs",
      "reproduce-and-file-bug",
      "link-duplicate-threads",
      "write-doc-from-repeat-question",
      "weekly-theme-report",
    ],
    routines: [
      { name: "Ticket sweep", when: "Every 15 minutes, around the clock" },
      { name: "Promise chase", when: "Every day, 14:00" },
      { name: "Theme report", when: "Fridays, 16:40" },
      { name: "Shift handover", when: "Every day, 21:30" },
    ],
    grants: [
      "Gmail Connection for the support mailbox",
      "The documentation Repository",
      "The Projects it may file bugs into",
      "Product docs and runbooks in Resources",
    ],
    products: ["email", "tasks", "repositories", "resources", "workspace", "notes"],
    capabilities: [
      {
        icon: "bookOpenCheck",
        title: "Answers from your truth, not its memory",
        body: "Replies are grounded in the docs, runbooks, and past threads you granted it, with the link attached. A question with no documented answer gets escalated, which is the correct answer to give.",
      },
      {
        icon: "shieldAlert",
        title: "A Decision is a first-class outcome",
        body: "Not knowing is a result, not a failure. Anything it cannot ground in your documentation, anything the refund policy does not cover, and anything a customer is angry about becomes a written question for a human, with the history attached.",
      },
      {
        icon: "listChecks",
        title: "Bugs engineers accept",
        body: "A filed issue carries a reproduction, the environment, and the exact log line, in the Project that owns it — the difference between a ticket that gets fixed and one that gets asked for more detail.",
      },
      {
        icon: "history",
        title: "Every thread is one timeline",
        body: "Duplicates are linked, re-opens are visible, and the whole history sits on the Contact — so the human who picks it up is not reading the story for the first time.",
      },
    ],
    faqs: [
      {
        q: "How do I stop it inventing an answer?",
        a: "It answers from granted Resources and past threads and cites what it used. Its Soul carries the rule that an ungrounded answer must be escalated instead — and you can read any Run to see exactly which sources it had.",
      },
      {
        q: "Can it issue refunds?",
        a: "It prepares them and it records them; a person moves the money. Genosyn deliberately ships no tool that lets an AI Employee disburse a refund, so the worst case is a well-argued Decision sitting in your queue.",
      },
      {
        q: "Does it work my existing inbox?",
        a: "Yes — Email is a real mail client over your Gmail mailbox with two-way sync, so your team and the AI Employee work the same threads rather than a shadow queue.",
      },
    ],
    keywords: [
      "AI support agent",
      "AI customer support",
      "24/7 AI support",
      "AI ticket triage",
      "autonomous customer service",
    ],
  },

  // ──────────────────────────────── Bookkeeper ────────────────────────────────
  {
    slug: "bookkeeper",
    name: "AI Bookkeeper",
    short: "Bookkeeper",
    noun: "a bookkeeper",
    person: "Mira",
    discipline: "Finance",
    icon: "landmark",
    accent: "bg-teal-50 text-teal-700 ring-teal-200",
    dot: "bg-teal-500",
    headline: "Closes the month",
    headlineMuted: "a little bit every single day.",
    summary:
      "Reconciles payments, chases invoices, categorises spend, and keeps the ledger close-ready — flagging what it cannot prove instead of guessing.",
    seoTitle: "AI Bookkeeper — books that stay closed · Genosyn",
    description:
      "An AI bookkeeper that reconciles payments daily, chases overdue invoices on schedule, categorises spend against your chart of accounts, and refuses to guess at anything it cannot prove.",
    intro:
      "Bookkeeping goes wrong in the gap between the transaction and the person who understands it. Doing it daily closes the gap: payments are matched while the context is fresh, invoices are chased on the day they age, and the month-end pack assembles itself instead of consuming a week. The one rule written into its Soul is that it never invents a number — anything it cannot prove is queued for a human, with the evidence attached.",
    reclaims:
      "The last week of every month, and the quiet uncertainty of not knowing whether the books are current.",
    day: [
      {
        time: "07:00",
        at: 7,
        title: "Reconciles yesterday",
        body: "Matches 42 payments to invoices on amount, reference, and date. Three do not match cleanly — a partial payment, a currency difference, and a customer who paid two invoices at once — so those are queued, not forced.",
        where: "Finance",
      },
      {
        time: "08:40",
        at: 8.67,
        title: "Chases, politely and on time",
        body: "Sends the day's dunning: gentle at 7 days, firmer at 30, and the pre-escalation note at 60 — each from the account's own history, and each pausing the moment someone replies.",
        where: "Finance · Invoices",
      },
      {
        time: "10:15",
        at: 10.25,
        title: "Categorises against your chart, not a generic one",
        body: "Codes yesterday's spend to the accounts you actually use, and flags the two subscriptions nobody has logged into for sixty days with what they cost a year.",
        where: "Finance · Ledger",
      },
      {
        time: "11:00",
        at: 11,
        title: "Refuses to guess",
        body: "A cross-border refund could book to either entity, and the answer changes the VAT treatment. It writes a Decision with both readings and the amount at stake, and moves on.",
        where: "Decisions",
        kind: "decision",
      },
      {
        time: "13:30",
        at: 13.5,
        title: "Updates the numbers people actually ask for",
        body: "Runway, burn, and expected cash-in, recomputed from the ledger rather than from a spreadsheet somebody last touched in March.",
        where: "Explore",
      },
      {
        time: "15:00",
        at: 15,
        title: "Reads the contracts, so the invoices are right",
        body: "Checks this week's renewals against the uploaded contracts — the escalator clause, the seat count, the currency — and raises the invoices that are due.",
        where: "Customers",
      },
      {
        time: "17:00",
        at: 17,
        title: "Files the close as it goes",
        body: "Adds today's reconciliations, accruals, and unresolved items to the month-end pack. On the last day of the month there is nothing left to assemble.",
        where: "Finance · Reports",
      },
      {
        time: "19:30",
        at: 19.5,
        title: "Reports the exceptions, not the total",
        body: "Posts what did not reconcile and why, what is now overdue past 60 days, and what it needs an answer on before the close.",
        where: "Workspace",
      },
    ],
    outputs: [
      { value: "42", label: "Payments reconciled" },
      { value: "3", label: "Exceptions queued, not guessed" },
      { value: "1", label: "Decision that needed you" },
    ],
    decisions: [
      "Which entity books this cross-border refund? It changes the VAT treatment.",
      "Vertex is 68 days overdue and asking for terms. Extend, or hold?",
    ],
    skills: [
      "reconcile-payments",
      "chase-overdue-invoice",
      "categorise-spend",
      "check-renewal-against-contract",
      "assemble-close-pack",
    ],
    routines: [
      { name: "Daily reconciliation", when: "Every day, 07:00" },
      { name: "Dunning run", when: "Every weekday, 08:40" },
      { name: "Cash position", when: "Every day, 13:30" },
      { name: "Close pack update", when: "Every weekday, 17:00" },
    ],
    grants: [
      "Stripe and bank Connections",
      "Finance — invoices, bills, and the general ledger",
      "Customers, for contracts and account history",
      "The accounting policy notebook in Notes",
    ],
    products: ["finance", "customers", "explore", "workspace"],
    capabilities: [
      {
        icon: "receipt",
        title: "Reconciliation with an exception queue",
        body: "Clean matches are posted; partials, currency differences, and one payment covering several invoices are queued with the candidates and the amounts. Guessing here is how books go wrong quietly.",
      },
      {
        icon: "repeat",
        title: "Dunning that behaves like a person",
        body: "A schedule that escalates in tone, drafts from that account's own history, and stops dead the moment a human replies. Nobody gets a firmer notice after they have already promised to pay.",
      },
      {
        icon: "landmark",
        title: "A real double-entry ledger",
        body: "Estimates, invoices, recurring billing, bills, vendors, reports, reconciliation, and period close ship natively — so the AI Employee is working your books, not a copy of them in a spreadsheet.",
      },
      {
        icon: "shieldCheck",
        title: "Payments stay behind a human",
        body: "Money leaving the company over your threshold is an approval a Member ticks, and the server replays the exact action. The employee prepares it, evidences it, and waits.",
      },
    ],
    faqs: [
      {
        q: "Can it pay bills?",
        a: "It prepares them. A payment over the threshold you set is an approval a human ticks, and the redacted payload is only replayed server-side after that — the employee has no standing power to move money.",
      },
      {
        q: "What if it categorises something wrong?",
        a: "Every posting is auditable and reversible, and the correction goes into its Soul or the relevant Skill so the class of mistake stops. The exception queue exists so that the ambiguous cases never get categorised in the first place.",
      },
      {
        q: "Does it replace my accountant?",
        a: "No — it keeps the books current so your accountant is reviewing a clean, closed month instead of reconstructing one. The judgement calls still arrive as Decisions for a human.",
      },
    ],
    keywords: [
      "AI bookkeeper",
      "AI accountant",
      "automated reconciliation",
      "AI invoice chasing",
      "autonomous finance operations",
    ],
  },

  // ───────────────────────────────── Engineer ─────────────────────────────────
  {
    slug: "engineer",
    name: "AI Engineer",
    short: "Engineer",
    noun: "an engineer",
    person: "Sam",
    discipline: "Engineering",
    icon: "gitBranch",
    accent: "bg-indigo-50 text-indigo-700 ring-indigo-200",
    dot: "bg-indigo-500",
    headline: "Opens the pull request",
    headlineMuted: "before the standup that would have assigned it.",
    summary:
      "Picks up the error spike at 02:00, writes the fix with a test, clears the dependency backlog, and does the maintenance nobody volunteers for.",
    seoTitle: "AI Engineer — the maintenance nobody schedules · Genosyn",
    description:
      "An AI engineer that reproduces overnight failures, opens fix pull requests with tests, clears dependency and CVE backlogs, and keeps documentation honest — inside a sandbox, behind review.",
    intro:
      "Most engineering backlogs are not hard, they are unglamorous: the flaky test, the dependency six majors behind, the doc that stopped being true two releases ago. An AI engineer does that work continuously inside a bubblewrap-isolated sandbox, opens a pull request like anyone else, and waits for review. Nothing merges because a model was confident about it.",
    reclaims:
      "The maintenance backlog, and the two hours after every incident spent writing up what happened.",
    day: [
      {
        time: "02:10",
        at: 2.17,
        title: "Picks up the spike nobody is awake for",
        body: "The error rate on checkout triples. It reproduces the failure in a sandboxed worktree, isolates the null case, and opens a pull request with the fix and a regression test attached.",
        where: "Repositories",
      },
      {
        time: "08:00",
        at: 8,
        title: "Reviews against your standards, not generic ones",
        body: "Reads the open pull requests against the engineering standards written into its Soul, and leaves comments on the two that break them — with the rule quoted, so the comment is arguable.",
        where: "Repositories",
      },
      {
        time: "10:00",
        at: 10,
        title: "Clears the dependency backlog",
        body: "Fourteen packages behind, two with advisories. It upgrades them one pull request per package, runs the suite on each, and reports the one that needs a real code change rather than bundling it in.",
        where: "Repositories",
      },
      {
        time: "11:00",
        at: 11,
        title: "Writes the migration nobody wants",
        body: "Generates the schema migration from the entity change, runs it forward and back on a scratch database, and includes the rollback in the same pull request.",
        where: "Repositories",
      },
      {
        time: "13:15",
        at: 13.25,
        title: "Stops at the blast radius",
        body: "The fix touches the payment path. Its Soul says that is a human's signature, so it assembles the diff, the test evidence, and the rollback plan into a Decision and stops.",
        where: "Decisions",
        kind: "decision",
      },
      {
        time: "15:30",
        at: 15.5,
        title: "Fixes the docs the change invalidated",
        body: "Finds the pages that describe the old behaviour and updates them in the same release — the discipline every team has in its contributing guide and nobody has time for.",
        where: "Repositories",
      },
      {
        time: "17:40",
        at: 17.67,
        title: "Kills the flakes",
        body: "Identifies the three tests that failed intermittently this week, finds the shared state behind two of them, and quarantines the third with an issue rather than deleting it.",
        where: "Tasks",
      },
      {
        time: "23:00",
        at: 23,
        title: "Writes up the day for the humans",
        body: "One note: what shipped, what is in review, what it could not fix and why. Written when it happened, not reconstructed on Friday.",
        where: "Workspace",
      },
    ],
    outputs: [
      { value: "6", label: "Pull requests opened with tests" },
      { value: "14", label: "Dependencies brought current" },
      { value: "1", label: "Decision that needed you" },
    ],
    decisions: [
      "This patch touches the checkout path. Sign off before it merges?",
      "Upgrading this package needs an API change in three call sites. Do it now, or file it?",
    ],
    skills: [
      "reproduce-failure",
      "open-fix-pull-request",
      "upgrade-dependency",
      "review-against-standards",
      "quarantine-flaky-test",
    ],
    routines: [
      { name: "Error-rate watch", when: "Every 10 minutes, around the clock" },
      { name: "Review sweep", when: "Every weekday, 08:00" },
      { name: "Dependency and advisory sweep", when: "Mondays, 10:00" },
      { name: "Flaky-test hunt", when: "Every weekday, 17:40" },
    ],
    grants: [
      "The Repositories it may work in",
      "The Projects it may file issues into",
      "The engineering standards notebook in Notes",
      "Read access to the error and metrics database in Explore",
    ],
    products: ["repositories", "tasks", "explore", "workspace"],
    capabilities: [
      {
        icon: "lock",
        title: "Isolated by default",
        body: "Code execution runs behind bubblewrap's Linux namespaces, rooted at the work session's own worktree. Your checkout, sibling sessions, and git itself stay outside it, and a host that cannot isolate a shell gets no shell at all.",
      },
      {
        icon: "gitFork",
        title: "It works the way your team works",
        body: "A branch, a pull request, a test, a review. There is no special merge path for the AI Employee, which is the point — the review you already trust is the one that catches it.",
      },
      {
        icon: "terminal",
        title: "Commands you chose",
        body: "What it may run is a decision on the Repository row — a command mode and an allow-list — not a prompt instruction. Most sessions never need execution at all.",
      },
      {
        icon: "fileText",
        title: "Documents are repositories too",
        body: "A Repository is any version-controlled workspace: a service's source, a quarter's strategy, a set of operating policies. The same review flow applies to the ones with no code in them.",
      },
    ],
    faqs: [
      {
        q: "Can it merge its own pull requests?",
        a: "Whether a pull request can merge without a human is a setting on the Repository, and the default is no. The safest posture — and the common one for the first few months — is that it opens, a person merges.",
      },
      {
        q: "Where does the code actually run?",
        a: "In a bubblewrap sandbox with private PID and /tmp namespaces, rooted at the work session's worktree. Where namespaces are unavailable, execution is disabled rather than falling back to your host.",
      },
      {
        q: "Does it get my repository credentials?",
        a: "No. Tokens and SSH keys are decrypted only for short-lived, server-owned clone and fetch operations. They are never written into a working tree or handed to model tooling.",
      },
    ],
    keywords: [
      "AI engineer",
      "AI software engineer",
      "autonomous code maintenance",
      "AI pull request",
      "AI dependency upgrades",
    ],
  },

  // ───────────────────────────────── Recruiter ─────────────────────────────────
  {
    slug: "recruiter",
    name: "AI Recruiter",
    short: "Recruiter",
    noun: "a recruiter",
    person: "Noor",
    discipline: "People",
    icon: "userCheck",
    accent: "bg-amber-50 text-amber-700 ring-amber-200",
    dot: "bg-amber-500",
    headline: "Keeps every candidate",
    headlineMuted: "warm, scheduled, and told the truth.",
    summary:
      "Screens against the scorecard you wrote, schedules without the email ping-pong, and never leaves a candidate waiting in silence.",
    seoTitle: "AI Recruiter — a pipeline nobody goes cold in · Genosyn",
    description:
      "An AI recruiter that screens against your written scorecard, schedules interviews without the back-and-forth, chases feedback from panels, and replies to every candidate on time.",
    intro:
      "Hiring is lost to latency more than to judgement: the good candidate who waited nine days for a reply, the panel feedback that never came, the rejection nobody sent. An AI recruiter fixes the parts that are pure diligence — screening against the scorecard you wrote down, scheduling, chasing, replying — and hands humans the judgement calls with everything already assembled.",
    reclaims:
      "The scheduling ping-pong, the feedback chasing, and the guilt of a candidate who never heard back.",
    day: [
      {
        time: "07:20",
        at: 7.33,
        title: "Screens against the scorecard, not a vibe",
        body: "Reads the eleven overnight applications against the criteria written down for this role, scores each against the same rubric, and records the reasoning so a decision can be argued with.",
        where: "Bases",
      },
      {
        time: "09:00",
        at: 9,
        title: "Replies to everyone, including the no",
        body: "Sends the invitations and the declines the same morning. A rejection at 09:00 on day one is a better candidate experience than an offer nine days late.",
        where: "Email",
      },
      {
        time: "10:40",
        at: 10.67,
        title: "Ends the scheduling ping-pong",
        body: "Finds the slot that works for a three-person panel and a candidate in another timezone, books it, and sends each interviewer the brief and the questions they own.",
        where: "Workspace",
      },
      {
        time: "12:30",
        at: 12.5,
        title: "Chases the feedback nobody submits",
        body: "Nudges the two interviewers who have not written up yesterday's loop, with the scorecard attached and the deadline visible. The candidate is not told 'we are still deciding' for a week.",
        where: "Tasks",
      },
      {
        time: "14:45",
        at: 14.75,
        title: "Keeps the passive pipeline warm",
        body: "Follows up with the four strong candidates from previous rounds who were not right then, with a reason to talk now rather than a template.",
        where: "Email",
      },
      {
        time: "16:00",
        at: 16,
        title: "Leaves the judgement to a person",
        body: "Two finalists, different strengths, one role. It writes the comparison against the scorecard, states what it cannot judge, and puts the Decision in front of the hiring manager.",
        where: "Decisions",
        kind: "decision",
      },
      {
        time: "17:30",
        at: 17.5,
        title: "Keeps the pipeline honest",
        body: "Updates every candidate's stage, flags the three who have been in the same stage for over a week, and reports where the funnel is actually losing people.",
        where: "Bases",
      },
      {
        time: "19:00",
        at: 19,
        title: "Reports the week the way a person would",
        body: "Applications in, screens done, loops run, offers out, and the one bottleneck that is slowing all of it down.",
        where: "Workspace",
      },
    ],
    outputs: [
      { value: "0", label: "Candidates left without a reply" },
      { value: "6", label: "Interviews scheduled, no back-and-forth" },
      { value: "1", label: "Decision that needed you" },
    ],
    decisions: [
      "Two finalists, different strengths, one role. Here is the comparison — which offer do we make?",
      "This candidate is asking above the band. Stretch, or hold the range?",
    ],
    skills: [
      "screen-against-scorecard",
      "schedule-interview-loop",
      "chase-panel-feedback",
      "write-candidate-reply",
      "warm-passive-candidate",
    ],
    routines: [
      { name: "Application screen", when: "Every weekday, 07:20" },
      { name: "Candidate replies", when: "Every weekday, 09:00" },
      { name: "Feedback chase", when: "Every weekday, 12:30" },
      { name: "Candidate stage health", when: "Every weekday, 17:30" },
    ],
    grants: [
      "Gmail Connection for the hiring mailbox",
      "Google Calendar Connection",
      "The candidate Base and its scorecards",
      "The role briefs and interview guides in Notes",
    ],
    products: ["bases", "email", "tasks", "workspace", "notes"],
    capabilities: [
      {
        icon: "table2",
        title: "A pipeline that is a real table",
        body: "Candidates, stages, scorecards, and attachments live in a Base with typed fields and saved views — worked by the AI Employee and by your hiring managers in the same place, not exported between two tools.",
      },
      {
        icon: "userCheck",
        title: "Screening you can audit",
        body: "Every score cites the criterion it was given and the evidence it read. A rejection you disagree with can be opened, read, and reversed — which is the only version of automated screening worth having.",
      },
      {
        icon: "calendarClock",
        title: "Scheduling across a panel",
        body: "Finds the slot for four calendars and a timezone, books it, and sends each interviewer what they are responsible for. The candidate gets one email instead of six.",
      },
      {
        icon: "history",
        title: "Nobody goes cold",
        body: "A Routine watches for candidates stuck in a stage and for interviewers who owe feedback. Silence becomes a thing the system notices rather than a thing you feel bad about later.",
      },
    ],
    faqs: [
      {
        q: "Is it making hiring decisions?",
        a: "No. It screens against criteria a human wrote down and shows its reasoning; the shortlist, the loop, and the offer are Decisions a person answers. Anything close to the line is escalated by design, not by luck.",
      },
      {
        q: "How does it avoid biased screening?",
        a: "It scores against your written scorecard and records the evidence for each criterion, so screens are reviewable and reversible rather than opaque. It is a diligence tool — the judgement stays with your hiring managers.",
      },
      {
        q: "Do I need an applicant tracking system too?",
        a: "For small teams, a Base with stages and scorecards is usually enough. If you already run an ATS, the AI Employee can work your mailbox and calendar alongside it.",
      },
    ],
    keywords: [
      "AI recruiter",
      "AI recruiting coordinator",
      "AI candidate screening",
      "AI interview scheduling",
      "autonomous hiring operations",
    ],
  },

  // ───────────────────────────────── Analyst ─────────────────────────────────
  {
    slug: "analyst",
    name: "AI Analyst",
    short: "Analyst",
    noun: "an analyst",
    person: "Nova",
    discipline: "Analytics",
    icon: "barChart3",
    accent: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    dot: "bg-emerald-500",
    headline: "Answers the question",
    headlineMuted: "before the meeting about it.",
    summary:
      "Watches the numbers every morning, explains the ones that moved, and turns 'can someone pull this?' into an answer with the query attached.",
    seoTitle: "AI Analyst — the number, and where it came from · Genosyn",
    description:
      "An AI analyst that watches your metrics daily, explains what moved and why, and answers ad-hoc questions with the SQL attached — over the databases you already connect.",
    intro:
      "The expensive part of analytics is not the query, it is the queue: the question asked on Monday and answered on Thursday, by which point the meeting has already made a decision without it. An AI analyst runs the numbers every morning over the databases you already connect, explains the ones that moved, and answers the ad-hoc question with the SQL attached so anyone can check it.",
    reclaims:
      "The ad-hoc request queue, and the weekly ritual of assembling numbers that a dashboard already knows.",
    day: [
      {
        time: "06:00",
        at: 6,
        title: "Runs the morning numbers",
        body: "Refreshes the Charts that matter, compares each against its trailing range, and marks the four that moved beyond what noise explains.",
        where: "Explore",
      },
      {
        time: "07:30",
        at: 7.5,
        title: "Explains the move, not just the delta",
        body: "Signups are up 22%. It segments by source, finds the referral spike behind it, checks whether the cohort converts like the others, and says so plainly — including that it is too early to tell.",
        where: "Explore",
      },
      {
        time: "09:15",
        at: 9.25,
        title: "Answers the question asked in chat",
        body: "Someone asks how many accounts on the old plan have more than five seats. It answers in four minutes with the number, the SQL, and the caveat about the two accounts mid-migration.",
        where: "Workspace",
      },
      {
        time: "11:00",
        at: 11,
        title: "Checks the data before trusting it",
        body: "Runs the quality checks — nulls where there should be none, duplicate rows, a table that stopped updating at 02:00 — and reports the broken load instead of charting the broken number.",
        where: "Explore",
      },
      {
        time: "13:40",
        at: 13.67,
        title: "Says what the data cannot say",
        body: "Two explanations fit the churn spike equally well and the data cannot separate them. It writes a Decision naming both, what it would cost to find out, and its recommendation.",
        where: "Decisions",
        kind: "decision",
      },
      {
        time: "15:20",
        at: 15.33,
        title: "Makes the dashboard people actually open",
        body: "Retires the three Charts nobody has viewed in a quarter and pins the two the leadership meeting keeps asking for by hand.",
        where: "Explore",
      },
      {
        time: "17:00",
        at: 17,
        title: "Files the reasoning, not just the chart",
        body: "Writes up what moved, what it checked, what it ruled out, and what it is still unsure about — so next month's version starts from this instead of from scratch.",
        where: "Notes",
      },
      {
        time: "18:30",
        at: 18.5,
        title: "Sends the number that changes behaviour",
        body: "One short post: the metric that moved, the reason, and the thing someone should do about it tomorrow.",
        where: "Workspace",
      },
    ],
    outputs: [
      { value: "4 min", label: "Median time to an ad-hoc answer" },
      { value: "1", label: "Broken pipeline caught before the report" },
      { value: "1", label: "Decision that needed you" },
    ],
    decisions: [
      "Two explanations fit the churn spike and the data cannot separate them. Which do we act on?",
      "The revenue definition in Finance and the one in Explore disagree by 3%. Which is canonical?",
    ],
    skills: [
      "run-morning-metrics",
      "explain-a-move",
      "answer-ad-hoc-question",
      "run-data-quality-checks",
      "curate-dashboard",
    ],
    routines: [
      { name: "Morning metrics", when: "Every day, 06:00" },
      { name: "Anomaly explanation", when: "Every day, 07:30" },
      { name: "Data quality sweep", when: "Every day, 11:00" },
      { name: "Weekly write-up", when: "Fridays, 17:00" },
    ],
    grants: [
      "Read-only Connections to Postgres, MySQL, or ClickHouse",
      "The Charts and Dashboards in Explore",
      "The metric definitions notebook in Notes",
      "The Pipelines that move data between your systems",
    ],
    products: ["explore", "pipelines", "notes", "workspace"],
    capabilities: [
      {
        icon: "database",
        title: "Your databases, read-only",
        body: "SQL over the Postgres, MySQL, or ClickHouse you already connect, saved as Charts and pinned to Dashboards. No copy of your warehouse, and no write access it does not need.",
      },
      {
        icon: "search",
        title: "Every answer ships its query",
        body: "The number comes with the SQL that produced it and the caveats that apply. An answer nobody can check is a rumour, however fast it arrived.",
      },
      {
        icon: "shieldAlert",
        title: "It checks the data first",
        body: "Nulls, duplicates, and a table that stopped loading overnight get reported instead of charted. The most expensive analytics failure is a confident number built on a broken load.",
      },
      {
        icon: "pieChart",
        title: "Definitions live in one place",
        body: "What counts as revenue, as active, as churned, is written down in Notes and cited by every answer — so two people asking the same question get the same number.",
      },
    ],
    faqs: [
      {
        q: "Does it need write access to my database?",
        a: "No. A read-only Connection is enough, and it is what we recommend. Grants are per resource, so an analyst with no Finance Grant cannot read your ledger either.",
      },
      {
        q: "How do I know the number is right?",
        a: "Every answer carries the query. Charts are saved objects a human can open, edit, and re-run, so checking its work costs one click rather than a rebuild.",
      },
      {
        q: "Can it build the dashboards too?",
        a: "Yes — Charts are saved SQL and Dashboards are pinned collections of them, both of which it can create and curate. Retiring the ones nobody opens is part of its weekly Routine.",
      },
    ],
    keywords: [
      "AI data analyst",
      "AI business analyst",
      "AI SQL analyst",
      "automated reporting",
      "autonomous analytics",
    ],
  },
];

export const ROLE_DISCIPLINES: string[] = [
  "Sales development",
  "Operations",
  "Marketing",
  "Customer support",
  "Finance",
  "Engineering",
  "People",
  "Analytics",
];

export function findRole(slug: string): RoleDef | undefined {
  return ROLES.find((role) => role.slug === slug);
}
