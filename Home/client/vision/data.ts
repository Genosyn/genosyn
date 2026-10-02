import type { Dept } from "@/sections/Kit";

/**
 * Furrow, the sample company the vision page follows from its first sentence
 * to its twentieth year.
 *
 * All of it is illustrative: a picture of where Genosyn is going, not a record
 * of something that happened, and every surface that draws it says so. The
 * numbers are still kept honest with one another, because a reader who checks
 * the arithmetic of a vision and finds it does not add up stops believing the
 * rest of it:
 *
 *   - Revenue compounds at the Goal's 40% a year from the first letter that
 *     has a year to measure against (No. 12, $412,000 a month), which is what
 *     puts No. 120 at $8.8M and No. 240 at $253M.
 *   - "People fed" assumes about $3 of produce per person per week.
 *   - The treasury card, the ledger and the work orders are all a day in
 *     year three, so they match Letter No. 36.
 *   - The Decision in No. 36 (spin the greenhouse software out) is the one the
 *     board took, which is why No. 120 reports on the company it became.
 *
 * Vocabulary follows AGENTS.md §3. In particular a board Decision is a choice
 * between options the executive team wrote, never "approve / reject" — the
 * catalogue test enforces it here exactly as it does for the roles.
 */

export const COMPANY = "Furrow";

/** The one sentence the board writes. Everything else on the page follows from it. */
export const GOAL = "Autonomous food production, with revenue growing 40% a year.";

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
    remit: "Runs the greenhouses, the harvest calendar, and the people who work them.",
    team: 4,
  },
  {
    person: "Vera",
    initials: "VE",
    title: "AI CFO",
    dept: "finance",
    remit: "Holds the treasury, pays every person and supplier, and closes the books every night.",
    team: 2,
  },
  {
    person: "Theo",
    initials: "TH",
    title: "AI CTO",
    dept: "repositories",
    remit: "Writes the software that runs the climate, the water, and the sensors that prove work was done.",
    team: 3,
  },
  {
    person: "Juno",
    initials: "JU",
    title: "AI CRO",
    dept: "revenue",
    remit: "Sells every tonne: to grocers, to restaurant groups, and as a weekly box to anyone nearby.",
    team: 3,
  },
  {
    person: "Ines",
    initials: "IN",
    title: "AI Chief People Officer",
    dept: "people",
    remit: "Finds, books and pays the people who do the physical work, and makes sure they want to come back.",
    team: 2,
  },
];

/** The people Furrow hired in its first thirty days, for the work that needs hands. */
export const FIRST_HIRES = ["6 growers", "1 irrigation technician", "2 drivers"];

export type Milestone = { day: number; title: string; body: string };

export const FIRST_MONTH: Milestone[] = [
  {
    day: 0,
    title: "The board signs the charter",
    body: "Three directors, one Goal, and 2.00 BTC to start.",
  },
  {
    day: 0,
    title: "Ada is hired as AI CEO",
    body: "Its Soul opens with the Goal. Five executives are hired before the hour is out.",
  },
  {
    day: 4,
    title: "Greenhouse 1 is leased",
    body: "1.2 hectares in the Salinas Valley, signed by Vera inside the board's Policies.",
  },
  {
    day: 9,
    title: "The first people are hired",
    body: "Six growers and an irrigation technician, each paid on the day of every shift.",
  },
  {
    day: 23,
    title: "The first harvest is sold",
    body: "3.1 tonnes of lettuce to four grocers, delivered before six in the morning.",
  },
  {
    day: 30,
    title: "Letter No. 1 reaches the board",
    body: "Twenty minutes to read. Nothing in it needed a vote.",
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
    revenue: 11_200,
    growth: null,
    reserves: "1.94 BTC",
    peoplePaid: 9,
    decidedWithoutYou: 214,
    body: [
      "Furrow exists. In thirty days we leased a greenhouse in the Salinas Valley, hired six growers and an irrigation technician, and sold our first 3.1 tonnes of lettuce to four grocers. Every person was paid on the day of their shift.",
      "The plan was wrong in one place. Our grocers want deliveries before six in the morning, and we had planned for nine. Otto rebuilt the delivery schedule within a week, and no order was lost.",
      "We spent 0.06 BTC of the 2.00 the board deposited. Nothing this month needed your vote.",
    ],
  },
  {
    number: 12,
    period: "Year 1",
    revenue: 412_000,
    growth: null,
    reserves: "9.60 BTC",
    peoplePaid: 138,
    decidedWithoutYou: 1_904,
    body: [
      "One year in. We grow under nine hectares of glass across three sites, sell to 41 grocers and 12 restaurant groups, and closed the year at $412,000 of revenue a month. From here on, the Goal has a year to measure against.",
      "Our first real test was August. A heat wave cost a week of tomatoes in Greenhouse 2, because the cooling Policy was written for an average summer rather than the worst one. Vera paid every grower for every cancelled shift. Theo now runs the cooling from the forecast instead of the thermometer, and it has held through two heat waves since.",
      "The executive team made 1,904 decisions this month without you. One needs the board.",
    ],
    decision: {
      question: "Buy the Yuma site, or keep leasing it?",
      context:
        "The owner will sell the six-hectare site we lease. Owning it lowers our costs from year three, and ties up two-fifths of our reserves today.",
      options: [
        { label: "Buy it", detail: "4.1 BTC from reserves. Owned outright, with no debt." },
        { label: "Keep leasing", detail: "Revisit in two years, with a longer record behind us." },
        { label: "Pass", detail: "Spend the year growing the Salinas sites instead." },
      ],
    },
  },
  {
    number: 36,
    period: "Year 3",
    revenue: 831_000,
    growth: 0.41,
    reserves: "41.3 BTC",
    peoplePaid: 410,
    decidedWithoutYou: 6_480,
    body: [
      "Year three closed at 41% growth against a Goal of 40%. We now grow in four regions on two continents, and sell to 140 grocers, 30 restaurant groups, and 2,600 households who take a weekly box.",
      "Our largest mistake came in March. A summer pricing Policy that Juno wrote stayed in force through the winter, and we sold three weeks of tomatoes below cost. It cost 2.1 BTC. Pricing Policies now expire by default, and any price change over 10% goes to Vera first.",
      "Theo's greenhouse software now runs better than anything we could buy, and two growers have asked to license it. That is the Decision below.",
    ],
    decision: {
      question: "Should Furrow sell its greenhouse software to other growers?",
      context:
        "It is why our yields beat the regional average by a third. Selling it helps other growers, and gives up some of that edge.",
      options: [
        {
          label: "Spin it out",
          detail: "Found it as its own autonomous company, with its own Goal and its own board.",
        },
        { label: "Keep it", detail: "It stays Furrow's advantage, and nobody else's." },
        {
          label: "License it narrowly",
          detail: "Only to growers in regions Furrow will never serve.",
        },
      ],
    },
  },
  {
    number: 120,
    period: "Year 10",
    revenue: 8_760_000,
    growth: 0.43,
    reserves: "610 BTC",
    peoplePaid: 3_100,
    decidedWithoutYou: 41_200,
    body: [
      "Ten years. Furrow grows food on 140 sites in 19 countries and feeds about 670,000 people every week. Revenue grew 43% this year, the ninth year in a row at or above the Goal.",
      "In year four the board chose to spin out our greenhouse software. It is now its own company, with its own Goal and its own board (you sit on it too), and it runs the climate in 2,300 greenhouses that are not ours.",
      "Our hardest year was year seven, when a drought closed two regions for a season. We paid every person through it, broke no promise to a customer, and were back above the Goal the year after.",
    ],
    decision: {
      question: "A national grocer has offered to buy Furrow. How should we answer?",
      context:
        "The offer values Furrow at fourteen times this year's revenue. Whether owners should sell is not a question the executive team should answer, which is exactly why it is here.",
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
    revenue: 253_000_000,
    growth: 0.41,
    reserves: "7,400 BTC",
    peoplePaid: 52_000,
    decidedWithoutYou: 310_000,
    body: [
      "Twenty years. Furrow grows food on 900 sites in 46 countries and feeds about 19 million people every week. Revenue grew 41% this year.",
      "Along the way we founded eleven companies: greenhouse software, cold chain, seed, soil testing and more. Each has its own Goal and its own board, and four of them are now larger than Furrow was at ten.",
      "The Goal you wrote on the first day is still the first thing every AI Employee here reads before it does anything. No one has changed it, and no one here can. Only you can.",
    ],
    decision: {
      question: "We met the Goal again. Should it change?",
      context:
        "Twenty years at 40% has made Furrow larger than any plan we wrote. A Goal is the board's to write; these are the three we would consider.",
      options: [
        { label: "Keep it", detail: "40% a year, for another twenty." },
        { label: "Raise it", detail: "50% a year, accepting more risk to reach it." },
        {
          label: "Rewrite it",
          detail: "End hunger in every region Furrow serves within ten years.",
        },
      ],
    },
  },
];

/* -------------------------------------------------------------------------
   The treasury — a day in year three
------------------------------------------------------------------------- */

export const TREASURY = {
  reserves: "41.27",
  operating: "$1.84M",
  coveredMonths: 31,
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
  "No payment over $50,000 without a director's key.",
  "Pay every person within 24 hours of verified work.",
  "Never borrow against the reserves.",
];

export type LedgerEntry = {
  time: string;
  kind: "Paid" | "Received" | "Moved";
  party: string;
  memo: string;
  amount: string;
};

export const LEDGER: LedgerEntry[] = [
  { time: "09:14", kind: "Paid", party: "M. Santos", memo: "Grower · 38 h", amount: "$1,520" },
  { time: "09:02", kind: "Received", party: "Greenline Grocers", memo: "Invoice 0412", amount: "$18,400" },
  { time: "08:47", kind: "Paid", party: "Valley Water Co-op", memo: "Water, September", amount: "$2,310" },
  { time: "08:31", kind: "Moved", party: "Reserve Policy", memo: "To the vault", amount: "0.40 BTC" },
  { time: "08:12", kind: "Paid", party: "J. Okafor", memo: "Irrigation technician · 6 h", amount: "$480" },
  { time: "07:55", kind: "Received", party: "Harbor Kitchen Group", memo: "Invoice 0409", amount: "$7,960" },
  { time: "07:30", kind: "Paid", party: "R. Lindqvist", memo: "Driver · 5 h", amount: "$225" },
  { time: "07:02", kind: "Paid", party: "Westside Seed Co.", memo: "Seed, 40 kg", amount: "$3,120" },
  { time: "06:48", kind: "Paid", party: "A. Haddad", memo: "Agronomist · 4 h", amount: "$360" },
  { time: "06:30", kind: "Received", party: "Weekly boxes", memo: "Tuesday deliveries", amount: "$9,860" },
  { time: "06:05", kind: "Paid", party: "Coastline Packaging", memo: "Compostable trays", amount: "$1,840" },
  { time: "05:40", kind: "Paid", party: "K. Mensah", memo: "Electrician · 3 h", amount: "$270" },
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
    title: "Survey the soil on the Yuma plot",
    who: "1 agronomist",
    when: "Next week",
    pay: "$900",
    status: "open",
    note: "Posted 2 h ago · 4 applicants",
    postedBy: "Otto · AI COO",
  },
  {
    id: "0420",
    title: "Monthly food-safety audit",
    who: "1 certified auditor",
    when: "Oct 28",
    pay: "$1,200",
    status: "open",
    note: "Posted today · rate published",
    postedBy: "Otto · AI COO",
  },
  {
    id: "0415",
    title: "Harvest Greenhouse 2",
    who: "14 growers",
    when: "Thu, 06:00 to 12:00",
    pay: "$40 an hour",
    status: "booked",
    note: "14 of 14 booked",
    postedBy: "Otto · AI COO",
  },
  {
    id: "0417",
    title: "Deliver 2.1 tonnes to Bay Area grocers",
    who: "3 drivers, refrigerated vans",
    when: "Fri, 04:00",
    pay: "$680",
    status: "booked",
    note: "3 of 3 booked",
    postedBy: "Juno · AI CRO",
  },
  {
    id: "0412",
    title: "Replace the irrigation pump in Greenhouse 3",
    who: "1 licensed irrigation technician",
    when: "Today, 13:00",
    pay: "$480",
    status: "paid",
    note: "Check passed: flow back to 14 L/min · paid 15:42",
    postedBy: "Otto · AI COO",
  },
];

export const WORK_STATS = [
  { value: "410", label: "people paid last month" },
  { value: "11,600", label: "hours of work bought" },
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
    { area: "Energy", goal: "Solar on every roof in the city." },
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
