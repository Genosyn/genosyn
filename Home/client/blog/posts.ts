import type { ArtKind } from "@/vision/draw";

/**
 * The blog's registry: every post's metadata, newest first. Each post's body
 * is Markdown, at client/blog/posts/<slug>.md, rendered by markdown.ts. This
 * module stays plain data, so siteMeta.ts (and with it the sitemap, llms.txt
 * and the tests) can read it without loading a page or a Markdown file.
 *
 * To publish a post: write client/blog/posts/<slug>.md, then add its entry
 * here, at the top.
 */

/** The shelves the index groups posts on, in the order it shows them. */
export const TOPICS = [
  { id: "ideas", label: "The big ideas", blurb: "What changes when a company can run itself." },
  { id: "trust", label: "Trust", blurb: "How a company nobody runs stays accountable to the people who own it." },
  { id: "people", label: "People and money", blurb: "Who a company hires, how it pays them, and how it keeps its money." },
  { id: "practice", label: "In practice", blurb: "The vision one Goal and one day at a time." },
  { id: "road", label: "Road reports", blurb: "What ships today, and what we are building next." },
] as const;

export type TopicId = (typeof TOPICS)[number]["id"];

export type Post = {
  slug: string;
  title: string;
  /** One or two sentences: the index card, the post's dek, its meta description and llms.txt. */
  description: string;
  /** YYYY-MM-DD. */
  date: string;
  /** Who signs it: the team, unless a person does. */
  author: string;
  topic: TopicId;
  /** The drawing that heads the post, from the vision page's set. */
  art: ArtKind;
  /** The drawing's caption, in the post's own terms. */
  legend: string;
};

const TEAM = "The Genosyn team";

export const POSTS: Post[] = [
  {
    slug: "you-are-the-board-not-the-manager",
    title: "You're the board, not the manager",
    description:
      "Most AI still needs a person beside it, and that person becomes the bottleneck. The way out is not better supervision. It is a different job: the board's.",
    date: "2026-10-04",
    author: TEAM,
    topic: "ideas",
    art: "reasons",
    legend: "Every decision, with its reason",
  },
  {
    slug: "how-tomorrows-companies-will-be-owned",
    title: "How tomorrow's companies will be owned",
    description:
      "For as long as there have been companies, owning one has meant running it, or paying someone to. When a company can run itself, ownership can finally be shared with the people who do its work and the places it serves.",
    date: "2026-10-04",
    author: TEAM,
    topic: "ideas",
    art: "owners",
    legend: "Every seat, an owner",
  },
  {
    slug: "every-problem-gets-a-company",
    title: "Every problem gets a company",
    description:
      "Most problems go unsolved not because nobody knows how, but because nobody has the years to run the company that would solve them. That is the part that changes.",
    date: "2026-10-04",
    author: TEAM,
    topic: "ideas",
    art: "problems",
    legend: "Every square, a problem with a company",
  },
  {
    slug: "goals-that-outlast-their-founders",
    title: "Goals that outlast their founders",
    description:
      "Some problems take longer than a career. Here is what it takes for a company to hold one Goal for a century, and how that Goal should change when it must.",
    date: "2026-10-04",
    author: TEAM,
    topic: "ideas",
    art: "century",
    legend: "One Goal, 1,200 letters",
  },
  {
    slug: "companies-you-can-fork",
    title: "Companies you can fork",
    description:
      "Much of what makes a company what it is can live in plain text. That means a good company in one place can be copied to the next, under a board of its own.",
    date: "2026-10-04",
    author: TEAM,
    topic: "ideas",
    art: "forks",
    legend: "One company, copied under new boards",
  },
  {
    slug: "a-bar-the-graded-party-cannot-write",
    title: "A bar the graded party can't write",
    description:
      "Two rules make autonomous work trustworthy: the one being graded never writes the test, and the one being stopped never lifts the stop. Both ship today.",
    date: "2026-10-04",
    author: TEAM,
    topic: "trust",
    art: "checks",
    legend: "Done only when the Check passes",
  },
  {
    slug: "earned-autonomy",
    title: "Earned autonomy",
    description:
      "No AI Employee starts out trusted to act alone. In Genosyn it earns that one kind of action at a time, on a record a person can check, and loses it on a single failure.",
    date: "2026-10-04",
    author: TEAM,
    topic: "trust",
    art: "problems",
    legend: "Autonomy, earned one gate at a time",
  },
  {
    slug: "mistakes-owned",
    title: "Mistakes, owned",
    description:
      "Every company makes mistakes. A company that runs itself can be better at owning them than one run by people: on the record, early, and written down so the next Run does not repeat them.",
    date: "2026-10-04",
    author: TEAM,
    topic: "trust",
    art: "reasons",
    legend: "Every decision, with its reason",
  },
  {
    slug: "the-letter",
    title: "The letter",
    description:
      "Once a month, a company that runs itself writes to its owners: what happened, what went wrong, where the money went. Here is what that letter owes them.",
    date: "2026-10-04",
    author: TEAM,
    topic: "trust",
    art: "century",
    legend: "One letter a month, for a century",
  },
  {
    slug: "when-the-employer-is-software",
    title: "When the employer is software",
    description:
      "An autonomous company still has a physical world to run, so it hires people. Here is what those people should be able to count on.",
    date: "2026-10-04",
    author: TEAM,
    topic: "people",
    art: "owners",
    legend: "A share of every job",
  },
  {
    slug: "two-kinds-of-money",
    title: "Two kinds of money",
    description:
      "A company that runs itself needs money it can spend without asking, and money it can never spend alone. The vision splits them the way it splits control.",
    date: "2026-10-04",
    author: TEAM,
    topic: "people",
    art: "economy",
    legend: "Paid the moment a Check passes",
  },
  {
    slug: "how-to-write-a-goal",
    title: "How to write a Goal",
    description:
      "The board writes one sentence and the company writes everything else, so that sentence has to be good: a direction, a number, and the line it must not cross.",
    date: "2026-10-04",
    author: TEAM,
    topic: "practice",
    art: "problems",
    legend: "One sentence for each problem",
  },
  {
    slug: "a-day-inside-a-company-nobody-runs",
    title: "A day inside a company nobody runs",
    description:
      "What does a company that runs itself actually do all day? One illustrative day at Sunwise, the sample company from the vision page, in its third year.",
    date: "2026-10-04",
    author: TEAM,
    topic: "practice",
    art: "economy",
    legend: "A day of work, paid as it is verified",
  },
  {
    slug: "road-report-october-2026",
    title: "Road report: October 2026",
    description:
      "Where the vision stands: what ships today, what we are building next, and what is still on the horizon. The first of a quarterly report.",
    date: "2026-10-04",
    author: TEAM,
    topic: "road",
    art: "forks",
    legend: "Ships today, next, and the horizon",
  },
];

export function findPost(slug: string): Post | undefined {
  return POSTS.find((post) => post.slug === slug);
}

/** The post to read after this one: the next in the list, wrapping round. */
export function nextPost(post: Post): Post | undefined {
  if (POSTS.length < 2) return undefined;
  const index = POSTS.findIndex((candidate) => candidate.slug === post.slug);
  return POSTS[(index + 1) % POSTS.length];
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "2026-10-04" → "October 4, 2026", the same on the server and in every browser and time zone. */
export function postDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return `${MONTHS[month - 1]} ${day}, ${year}`;
}
