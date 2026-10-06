import { readingMinutes, renderMarkdown } from "@/blog/markdown";

/**
 * Every post's Markdown, inlined by Vite at build time, keyed by file name.
 * Only the pages import this; siteMeta.ts and the tests read posts.ts, which
 * needs no bundler.
 */
const SOURCES = import.meta.glob("./posts/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

export type PostContent = {
  /** The rendered body, safe to set as HTML: see markdown.ts. */
  html: string;
  minutes: number;
};

const rendered = new Map<string, PostContent>();

export function postContent(slug: string): PostContent | undefined {
  const cached = rendered.get(slug);
  if (cached) return cached;
  const source = SOURCES[`./posts/${slug}.md`];
  if (source === undefined) return undefined;
  const content = { html: renderMarkdown(source), minutes: readingMinutes(source) };
  rendered.set(slug, content);
  return content;
}
