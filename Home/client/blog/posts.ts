import type { BigIdea } from "@/vision/data";

/**
 * The blog's registry: every post's metadata, newest first. Each post's body
 * is Markdown, at client/blog/posts/<slug>.md, rendered by markdown.ts. This
 * module stays plain data, so siteMeta.ts (and with it the sitemap, llms.txt
 * and the tests) can read it without loading a page or a Markdown file.
 *
 * To publish a post: write client/blog/posts/<slug>.md, then add its entry
 * here, at the top.
 */

export type Post = {
  slug: string;
  title: string;
  /** One or two sentences: the index card, the post's dek, its meta description and llms.txt. */
  description: string;
  /** YYYY-MM-DD. */
  date: string;
  /** Who signs it: the team, unless a person does. */
  author: string;
  /** A drawing from the vision page to head the post with, when one fits. */
  art?: BigIdea["art"];
  /** The drawing's caption. */
  legend?: string;
};

export const POSTS: Post[] = [
  {
    slug: "how-tomorrows-companies-will-be-owned",
    title: "How tomorrow's companies will be owned",
    description:
      "For as long as there have been companies, owning one has meant running it, or paying someone to. When a company can run itself, ownership can finally be shared with the people who do its work and the places it serves.",
    date: "2026-10-04",
    author: "The Genosyn team",
    art: "owners",
    legend: "Every seat, an owner",
  },
];

export function findPost(slug: string): Post | undefined {
  return POSTS.find((post) => post.slug === slug);
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
