import type { Dept } from "@/sections/Kit";

/**
 * Sunwise, the sample company the vision page follows from its first sentence
 * to its twentieth year: an autonomous rooftop-solar company whose board asked
 * for a million roofs.
 *
 * All of it is illustrative: a picture of where Genosyn is going, not a record
 * of something that happened, and every surface that draws it says so. The
 * numbers are still kept honest with one another, because a reader who checks
 * the arithmetic of a vision and finds it does not add up stops believing the
 * rest of it:
 *
 *   - A roof is an 8 kW system that sells for about $16,000 (about $26,000
 *     once batteries are standard), and a roof Sunwise owns sells about $110
 *     of power a month. 150 roofs a month is No. 12's $2.4M; 300 is No. 36's
 *     $4.8M.
 *   - From No. 12, revenue compounds near the Goal's 40% a year, with one
 *     deliberate miss in year five while owned roofs took hold. That puts
 *     No. 120 at $46M and No. 240 at $1.2B, and the millionth roof in year
 *     seventeen.
 *   - Bitcoin amounts never sit beside dollar amounts they could be divided
 *     by, so nothing on the page implies a price for it.
 *   - The treasury card, the ledger and the work orders are all a day in year
 *     three, so they match Letter No. 36.
 *   - The Decision in No. 36 (start owning roofs) is the one the board took,
 *     which is why No. 120 reports on what it cost and what it earned.
 *
 * Vocabulary follows AGENTS.md §3. In particular a board Decision is a choice
 * between options the executive team wrote, never "approve / reject" — the
 * catalogue test enforces it here exactly as it does for the roles.
 */

export const COMPANY = "Sunwise";

/** What the company does, as its letterhead says it. */
export const TAGLINE = "Rooftop solar";

/** The one sentence the board writes. Everything else on the page follows from it. */
export const GOAL = "Put solar on a million roofs, with revenue growing 40% a year.";

export type Director = {
  name: string;
  initials: string;
  /** The seat the reader is invited to take. */
  you?: boolean;
};

export const BOARD: Director[] = [
  { name: "You", initials: "You", you: true },
  { name: "Dana", initials: "DA" },
  { name: "Kenji", initials: "KE" },
];

export type Executive = {
  person: string;
  initials: string;
  title: string;
  /** The CEO has none: it answers for every department at once. */
  dept?: Dept;
  remit: string;
  /** AI Employees reporting to this executive by day 30. */
  team: number;
};

export const CEO: Executive = {
  person: "Ada",
  initials: "AD",
  title: "AI CEO",
  remit: "Accountable for the Goal. Hires the executive team, writes the letter to the board, and answers to it.",
  team: 0,
};

/** The first lines of Ada's Soul — the only part of the company the board wrote by hand besides the Goal. */
export const CEO_SOUL = [
  "Reach the Goal without betting the company.",
  "Tell the board the bad news first.",
  "Pay every person on the day they were promised.",
];

export const EXECUTIVES: Executive[] = [
  {
    person: "Otto",
    initials: "OT",
    title: "AI COO",
    dept: "operations",
    remit: "Runs the installs: surveys, permits, crews, and the trucks that carry the panels.",
    team: 4,
  },
  {
    person: "Vera",
    initials: "VE",
    title: "AI CFO",
    dept: "finance",
    remit: "Holds the treasury, buys the panels, pays every person, and closes the books every night.",
    team: 2,
  },
  {
    person: "Theo",
    initials: "TH",
    title: "AI CTO",
    dept: "repositories",
    remit: "Writes the software that designs each roof, watches every panel, and proves the work was done.",
    team: 3,
  },
  {
    person: "Juno",
    initials: "JU",
    title: "AI CRO",
    dept: "revenue",
    remit: "Finds the homes with the best roofs, quotes them honestly, and signs them.",
    team: 3,
  },
  {
    person: "Ines",
    initials: "IN",
    title: "AI Chief People Officer",
    dept: "people",
    remit: "Finds, books and pays the installers, electricians and roofers, and makes sure they want to come back.",
    team: 2,
  },
];

/** The people Sunwise hired in its first thirty days, for the work that needs hands. */
export const FIRST_HIRES = ["6 installers", "1 electrician", "1 roofer", "1 site surveyor"];

export type Milestone = { day: number; title: string; body: string };

export const FIRST_MONTH: Milestone[] = [
  {
    day: 0,
    title: "The board signs the charter",
    body: "Three directors, one Goal, and 3.00 BTC to start.",
  },
  {
    day: 0,
    title: "Ada is hired as AI CEO",
    body: "Its Soul opens with the Goal. Five executives are hired before the hour is out.",
  },
  {
    day: 2,
    title: "The first homes are found",
    body: "Juno maps every roof in Tucson from the air and sends honest quotes to the best 400.",
  },
  {
    day: 6,
    title: "The first people are hired",
    body: "Six installers, an electrician, a roofer and a surveyor, each paid on the day of every job.",
  },
  {
    day: 19,
    title: "The first roof goes live",
    body: "8 kW on a ranch house in Tucson, inspected and switched on before noon.",
  },
  {
    day: 30,
    title: "Letter No. 1 reaches the board",
    body: "Twelve roofs live. Twenty minutes to read, and nothing in it needed a vote.",
  },
];

/* -------------------------------------------------------------------------
   The letters
------------------------------------------------------------------------- */

export type BoardOption = { label: string; detail: string };

export type BoardDecision = {
  question: string;
  context: string;
  options: BoardOption[];
};

export type Letter = {
  /** Letters are numbered by month, so No. 120 is the end of year ten. */
  number: number;
  period: string;
  /** Revenue in the month the letter closes, in US dollars. */
  revenue: number;
  /** Growth on the same month a year earlier. Null until there is a year to compare. */
  growth: number | null;
  reserves: string;
  peoplePaid: number;
  /** Decisions the executive team made that month without the board. */
  decidedWithoutYou: number;
  body: string[];
  decision?: BoardDecision;
};

export const LETTERS: Letter[] = [
  {
    number: 1,
    period: "Month 1",
    revenue: 192_000,
    growth: null,
    reserves: "2.60 BTC",
    peoplePaid: 9,
    decidedWithoutYou: 214,
    body: [
      "Sunwise exists. In thirty days we found 400 good roofs in Tucson, hired six installers, an electrician, a roofer and a surveyor, and switched on our first twelve homes. Every person was paid on the day of their job.",
      "The plan was wrong in one place. We expected permits to take a week, and the county took nearly three. Otto now files for a permit the day a homeowner signs, not the day a crew is free, and the queue has cleared.",
      "We spent 0.40 BTC of the 3.00 the board deposited, most of it on panels for next month. Nothing this month needed your vote.",
    ],
  },
  {
    number: 12,
    period: "Year 1",
    revenue: 2_400_000,
    growth: null,
    reserves: "11.4 BTC",
    peoplePaid: 96,
    decidedWithoutYou: 1_904,
    body: [
      "One year in. Sunwise has put solar on 1,100 roofs in Tucson and Phoenix, installs 150 a month, and closed the year at $2.4 million of revenue a month. From here on, the Goal has a year to measure against.",
      "Our first real test was July. A batch of inverters from one supplier began failing in the heat. Theo's monitoring caught the first within the hour, Vera paid for every replacement before a homeowner had to ask, and every affected roof was producing again within two days. We now buy from two suppliers.",
      "The executive team made 1,904 decisions this month without you. One needs the board.",
    ],
    decision: {
      question: "Buy a regional installer, or keep building our own crews?",
      context:
        "A Phoenix installer with 40 crews is closing. Buying it doubles our capacity overnight, and spends half of our reserves.",
      options: [
        { label: "Buy it", detail: "5.6 BTC from reserves. Forty crews on day one." },
        {
          label: "Keep building our own",
          detail: "Slower and cheaper, with every crew trained to our standards.",
        },
        { label: "Partner instead", detail: "Book its crews through work orders, and own nothing." },
      ],
    },
  },
  {
    number: 36,
    period: "Year 3",
    revenue: 4_800_000,
    growth: 0.41,
    reserves: "44.0 BTC",
    peoplePaid: 210,
    decidedWithoutYou: 6_480,
    body: [
      "Year three closed at 41% growth against a Goal of 40%. We install in three states, put up 300 roofs a month, and 6,200 homes now make their own power.",
      "Our largest mistake came in March. Juno's quotes assumed a utility rate that changed in January, and for six weeks we promised 140 homeowners savings they will not see. We told every one of them, paid each the difference for a year, and every quote now re-checks the rate before it is sent. It cost 1.2 BTC.",
      "The question for the next decade is whether to keep selling roofs or to start keeping them. That is the Decision below.",
    ],
    decision: {
      question: "Keep selling roofs, or start owning them?",
      context:
        "If Sunwise owns the roofs it installs and sells their power for less than the grid, one sale becomes twenty-five years of revenue. It would also slow growth for two years, and may cost us the Goal while it does.",
      options: [
        { label: "Start owning them", detail: "One in ten new roofs at first, paid for from reserves." },
        { label: "Keep selling them", detail: "Stay fast, simple, and on the Goal." },
        {
          label: "Partner with a fund",
          detail: "A fund owns the roofs, and we install and run them for a fee.",
        },
      ],
    },
  },
  {
    number: 120,
    period: "Year 10",
    revenue: 46_000_000,
    growth: 0.42,
    reserves: "860 BTC",
    peoplePaid: 2_300,
    decidedWithoutYou: 41_200,
    body: [
      "Ten years. Sunwise has put solar on 110,000 roofs in nine countries, and owns 48,000 of them, selling their power for less than the grid. Revenue grew 42% this year. We have met the Goal in eight of the last nine years.",
      "The year we missed it was year five, by choice. In year four the board chose to start owning roofs, and revenue grew 31% while that choice took hold. Owned roofs now earn $5.3 million a month that no sale could.",
      "In year six we spun our battery business out as its own company, with its own Goal and its own board (you sit on it too). It now stores power in 90,000 homes, two-thirds of them not ours.",
    ],
    decision: {
      question: "A national utility has offered to buy Sunwise. How should we answer?",
      context:
        "The offer values Sunwise at eleven times this year's revenue. Whether owners should sell is not a question the executive team should answer, which is exactly why it is here.",
      options: [
        { label: "Decline", detail: "Keep compounding toward the Goal." },
        { label: "Open talks", detail: "Ada negotiates, and the terms come back to the board." },
        {
          label: "Sell a minority stake",
          detail: "Take some money off the table, and keep every board seat.",
        },
      ],
    },
  },
  {
    number: 240,
    period: "Year 20",
    revenue: 1_200_000_000,
    growth: 0.41,
    reserves: "12,400 BTC",
    peoplePaid: 52_000,
    decidedWithoutYou: 310_000,
    body: [
      "Twenty years. Sunwise passed a million roofs in year seventeen, and has now put solar on 3.2 million homes in 31 countries. Revenue grew 41% this year.",
      "Along the way we founded nine companies: batteries, grid software, panel recycling, financing and more. Each has its own Goal and its own board, and three of them are now larger than Sunwise was at ten.",
      "The Goal you wrote on the first day is met. It is still the first thing every AI Employee here reads before it does anything, and no one here can change it. Only you can.",
    ],
    decision: {
      question: "We met the Goal. What should the next one be?",
      context:
        "A million roofs took seventeen years. A Goal is the board's to write; these are the three we would consider.",
      options: [
        { label: "Keep going", detail: "A million more roofs, still growing 40% a year." },
        { label: "Raise it", detail: "Ten million roofs by year thirty." },
        {
          label: "Rewrite it",
          detail: "Every town Sunwise serves runs on clean power by year thirty.",
        },
      ],
    },
  },
];

/* -------------------------------------------------------------------------
   The treasury — a day in year three
------------------------------------------------------------------------- */

export const TREASURY = {
  reserves: "44.02",
  operating: "$6.1M",
  addedThisMonth: "1.8 BTC",
};

export type KeyHolder = { name: string; role: string; ai: boolean };

/** Two keys of three move the reserves: the AI CFO's and one director's. */
export const VAULT_KEYS: KeyHolder[] = [
  { name: "Vera", role: "AI CFO", ai: true },
  { name: "You", role: "Director", ai: false },
  { name: "Dana", role: "Director", ai: false },
];

/** Policies the board wrote. They bind every AI Employee at once. */
export const TREASURY_POLICIES = [
  "Keep at least 60% of reserves in bitcoin.",
  "No payment over $250,000 without a director's key.",
  "Pay every person within 24 hours of verified work.",
  "Never sell a roof that costs its owner more than the grid.",
];

export type LedgerEntry = {
  time: string;
  kind: "Paid" | "Received" | "Moved";
  party: string;
  memo: string;
  amount: string;
};

export const LEDGER: LedgerEntry[] = [
  { time: "09:14", kind: "Paid", party: "M. Santos", memo: "Installer · 9 h", amount: "$405" },
  { time: "09:02", kind: "Received", party: "Roof 6,214", memo: "Mesa · paid in full", amount: "$15,800" },
  { time: "08:47", kind: "Paid", party: "Desert Panel Supply", memo: "340 panels", amount: "$61,200" },
  { time: "08:31", kind: "Moved", party: "Reserve Policy", memo: "To the vault", amount: "0.40 BTC" },
  { time: "08:12", kind: "Paid", party: "J. Okafor", memo: "Electrician · 6 h", amount: "$480" },
  { time: "07:55", kind: "Received", party: "Roof 6,209", memo: "Tucson · paid in full", amount: "$17,200" },
  { time: "07:30", kind: "Paid", party: "R. Lindqvist", memo: "Roofer · 5 h", amount: "$300" },
  { time: "07:02", kind: "Paid", party: "County permits", memo: "14 roofs", amount: "$4,200" },
  { time: "06:48", kind: "Paid", party: "A. Haddad", memo: "Site surveyor · 4 h", amount: "$240" },
  { time: "06:30", kind: "Received", party: "Roof 6,201", memo: "Phoenix · paid in full", amount: "$16,400" },
  { time: "06:05", kind: "Paid", party: "Sonoran Inverter Co.", memo: "30 inverters", amount: "$36,000" },
  { time: "05:40", kind: "Paid", party: "K. Mensah", memo: "Inspector · 3 h", amount: "$270" },
];

/* -------------------------------------------------------------------------
   People — work orders on the same day in year three
------------------------------------------------------------------------- */

export type WorkStatus = "open" | "booked" | "paid";

export type WorkOrder = {
  id: string;
  title: string;
  who: string;
  when: string;
  pay: string;
  status: WorkStatus;
  /** What the order says now: applicants, bookings, or the Check that released payment. */
  note: string;
  postedBy: string;
};

export const WORK_ORDERS: WorkOrder[] = [
  {
    id: "0418",
    title: "Survey six roofs in Flagstaff",
    who: "1 site surveyor with a drone licence",
    when: "Next week",
    pay: "$720",
    status: "open",
    note: "Posted 2 h ago · 5 applicants",
    postedBy: "Otto · AI COO",
  },
  {
    id: "0420",
    title: "Quality-check 14 finished roofs",
    who: "1 certified solar inspector",
    when: "Oct 28",
    pay: "$1,400",
    status: "open",
    note: "Posted today · rate published",
    postedBy: "Otto · AI COO",
  },
  {
    id: "0415",
    title: "Install roof 6,231 in Mesa",
    who: "3 installers and an electrician",
    when: "Thu, 07:00",
    pay: "$1,560",
    status: "booked",
    note: "4 of 4 booked",
    postedBy: "Otto · AI COO",
  },
  {
    id: "0417",
    title: "Deliver 340 panels to the Phoenix yard",
    who: "2 drivers with flatbeds",
    when: "Fri, 05:00",
    pay: "$520",
    status: "booked",
    note: "2 of 2 booked",
    postedBy: "Vera · AI CFO",
  },
  {
    id: "0412",
    title: "Replace a failed inverter on roof 4,118",
    who: "1 licensed electrician",
    when: "Today, 13:00",
    pay: "$480",
    status: "paid",
    note: "Check passed: roof back to 7.9 kW · paid 15:42",
    postedBy: "Theo · AI CTO",
  },
];

export const WORK_STATS = [
  { value: "210", label: "people paid last month" },
  { value: "14,800", label: "hours of work bought" },
  { value: "3 h 12 m", label: "from verified work to payment, on average" },
];

/** What every person the company hires can count on. */
export const COMMITMENTS = [
  {
    title: "The rate comes first",
    body: "Every work order publishes its pay before anyone applies, and it never changes after.",
  },
  {
    title: "Paid within a day",
    body: "Payment releases when the work is verified, usually within hours, never later than 24.",
  },
  {
    title: "Rated both ways",
    body: "People rate the company exactly as the company rates them, and both sides see it.",
  },
  {
    title: "A line to the board",
    body: "Anyone the company hires can write to the board directly, and the board reads it.",
  },
];

/* -------------------------------------------------------------------------
   Governance
------------------------------------------------------------------------- */

export type Power = {
  name: string;
  body: string;
  /** Shipped today, with the page that documents it — or still on the road. */
  docsPath: string | null;
  icon: "goal" | "policy" | "decision" | "soul" | "keys" | "standdown";
};

export const POWERS: Power[] = [
  {
    name: "Set the Goal",
    body: "Only the board writes it. Every AI Employee reads it before every piece of work, and none of them can change it.",
    docsPath: "/docs/goals",
    icon: "goal",
  },
  {
    name: "Write the Policies",
    body: "Rules that bind every employee at once: what may be spent, what must be asked, what is never done. Enforced by the platform, not just remembered.",
    docsPath: "/docs/policies",
    icon: "policy",
  },
  {
    name: "Answer the Decisions",
    body: "When a choice is beyond the executive team's authority, it stops, writes out the options, and waits for the board.",
    docsPath: "/docs/decisions",
    icon: "decision",
  },
  {
    name: "Appoint the CEO",
    body: "The board writes the CEO's Soul, chooses the AI Model it runs on, and can replace it outright.",
    docsPath: "/docs/soul",
    icon: "soul",
  },
  {
    name: "Hold the keys",
    body: "Reserves sit in a vault that takes two keys of three. The AI CFO holds one; directors hold the rest.",
    docsPath: null,
    icon: "keys",
  },
  {
    name: "Stand it down",
    body: "One switch stops every AI Employee in the company, mid-Run. Only a person can lift it.",
    docsPath: "/docs/standdowns",
    icon: "standdown",
  },
];

/* -------------------------------------------------------------------------
   Think bigger
------------------------------------------------------------------------- */

export const BIG_IDEAS = [
  {
    title: "Every problem gets a company.",
    body: "Most problems go unsolved not because nobody knows how, but because nobody has the years to run the company that would solve them. A village water system. A disease with nine hundred patients. A bus line for a town of nine thousand. When running a company costs almost nothing, small markets become worth serving.",
  },
  {
    title: "Goals that outlast their founders.",
    body: "An autonomous company can hold one Goal for a century, to restore a forest or retire a disease, and still be working on it, unchanged, when its founders' grandchildren read the letters.",
  },
  {
    title: "One person, many boards.",
    body: "Today a founder runs one company and burns out on it. Tomorrow one person can sit on ten boards: a few minutes a month for each, and a voice exactly where it counts.",
  },
];

export type FutureCompany = { area: string; goal: string };

/** Companies waiting for a board. Three rows, so the wall can drift in alternate directions. */
export const FUTURE_COMPANIES: FutureCompany[][] = [
  [
    { area: "Water", goal: "Clean water for every village in the district, with every pump working." },
    { area: "Health", goal: "Insulin at cost, in forty countries." },
    { area: "Food", goal: "A bakery in every town that lost its last one." },
    { area: "Infrastructure", goal: "Inspect every bridge in the county, every year, forever." },
    { area: "Climate", goal: "Restore 100,000 hectares of forest by 2050." },
    { area: "Energy", goal: "Recycle every solar panel installed before 2025." },
  ],
  [
    { area: "Medicine", goal: "Run trials for diseases with fewer than a thousand patients." },
    { area: "Housing", goal: "Build 1,000 homes a year, and sell them at cost." },
    { area: "Transit", goal: "Night buses for towns too small for a transit agency." },
    { area: "Knowledge", goal: "Translate every public-domain book into a hundred languages." },
    { area: "Water", goal: "Desalinate 50 million litres a day for the coast." },
    { area: "Repair", goal: "Fix a million appliances a year that would have been thrown away." },
  ],
  [
    { area: "Oceans", goal: "Measure the reef every week, and keep it alive." },
    { area: "Health", goal: "A doctor's appointment within a day, for everyone in the valley." },
    { area: "Food", goal: "Grow 1,000 tonnes of protein a year without farmland." },
    { area: "Wildfire", goal: "Clear the dry brush above every hillside town, every spring." },
    { area: "Rivers", goal: "Clean the river, and publish its water quality every morning." },
    { area: "Nature", goal: "Count every species in the national park, every season." },
  ],
];

/* -------------------------------------------------------------------------
   The road
------------------------------------------------------------------------- */

export type RoadItem = { label: string; href?: string };

export const ROAD: { stage: string; note: string; items: RoadItem[] }[] = [
  {
    stage: "Ships today",
    note: "Open source, in the current release.",
    items: [
      { label: "AI Employees with a Soul, Skills and Routines", href: "/docs/employees" },
      { label: "Goals every AI Employee reads", href: "/docs/goals" },
      { label: "Decisions and Approvals", href: "/docs/decisions" },
      { label: "Policies and Budgets", href: "/docs/policies" },
      { label: "Checks that grade every Run", href: "/docs/verification" },
      { label: "Autonomy that is earned, and revoked", href: "/docs/autonomy" },
      { label: "Standdowns", href: "/docs/standdowns" },
      { label: "A double-entry ledger", href: "/docs/finance" },
      { label: "TLDR briefings on the whole company", href: "/docs/tldrs" },
    ],
  },
  {
    stage: "Next",
    note: "What we are building toward now.",
    items: [
      { label: "AI executives that hire, coach and replace AI Employees" },
      { label: "The monthly letter to the board" },
      { label: "Operating accounts and a bitcoin treasury" },
      { label: "Work orders that hire people for physical work" },
    ],
  },
  {
    stage: "The horizon",
    note: "Where the road goes.",
    items: [
      { label: "A company founded from one sentence" },
      { label: "One person on many boards" },
      { label: "Companies that found companies" },
    ],
  },
];
