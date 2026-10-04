import { ArrowRight } from "lucide-react";
import { useReveal } from "@/components/Reveal";
import { postContent } from "@/blog/content";
import { POSTS, postDate, type Post } from "@/blog/posts";
import { Link } from "@/lib/router";
import { ClosingCta, Footer } from "@/sections/Footer";
import { Container, Em } from "@/sections/Kit";
import { Nav } from "@/sections/Nav";
import { PageHero } from "@/sections/PageHero";
import { IdeaArt } from "@/vision/IdeaArt";

/**
 * /blog: essays on where Genosyn is going. The newest post is drawn large,
 * with the vision-page drawing it borrows; earlier ones follow as a list.
 */
export function BlogIndex() {
  const [latest, ...earlier] = POSTS;
  return (
    <div className="min-h-screen overflow-x-clip bg-paper text-ink">
      <Nav />
      <main>
        <PageHero
          kicker="Blog"
          title={
            <>
              Notes on companies that <Em>run themselves.</Em>
            </>
          }
          lede="Essays from the people building Genosyn: who will own tomorrow's companies, who they will answer to, and what becomes possible when founding one takes a sentence."
        />
        <section className="pb-20 sm:pb-24 lg:pb-28">
          <Container>
            {latest && <Featured post={latest} />}
            {earlier.length > 0 && <Earlier posts={earlier} />}
          </Container>
        </section>
        <ClosingCta />
      </main>
      <Footer />
    </div>
  );
}

function minutesOf(post: Post): number {
  return postContent(post.slug)?.minutes ?? 1;
}

function Featured({ post }: { post: Post }) {
  const card = useReveal<HTMLSpanElement>(80);
  return (
    <Link
      href={`/blog/${post.slug}`}
      className="group grid overflow-hidden rounded-[1.75rem] border border-line bg-paper-raised shadow-soft transition-shadow duration-300 hover:shadow-lifted sm:rounded-[2.25rem] lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]"
    >
      <span ref={card} className="flex min-w-0 flex-col p-7 sm:p-10 lg:p-12">
        <span className="flex flex-wrap items-center gap-x-3 gap-y-2 font-mono text-[11px] uppercase tracking-[0.12em] text-ink-500">
          <span className="rounded-full bg-ink px-2.5 py-1 leading-none text-white">Latest</span>
          <time dateTime={post.date}>{postDate(post.date)}</time>
          <span aria-hidden>·</span>
          <span>{`${minutesOf(post)} min read`}</span>
        </span>
        <span className="mt-8 block text-balance font-display text-display-lg text-ink">{post.title}</span>
        <span className="mt-5 block max-w-[52ch] text-pretty text-[1.0625rem] leading-[1.65] text-ink-600">
          {post.description}
        </span>
        <span className="mt-auto inline-flex items-center gap-1.5 pt-10 text-[15px] font-medium text-ink underline decoration-ink/20 underline-offset-[6px] transition-colors group-hover:decoration-ink">
          Read the essay
          <ArrowRight aria-hidden className="nudge h-4 w-4 opacity-70" />
        </span>
      </span>
      {post.art && (
        <span className="night-sky on-night relative block min-h-[17rem] text-white lg:min-h-full">
          <IdeaArt art={post.art} legend={post.legend ?? ""} frame="absolute inset-0" />
        </span>
      )}
    </Link>
  );
}

function Earlier({ posts }: { posts: Post[] }) {
  const list = useReveal<HTMLOListElement>(0, 70);
  return (
    <div className="mt-20">
      <p className="kicker inline-flex items-center gap-3 text-ink-500">
        <span aria-hidden className="h-px w-6 bg-ink" />
        Earlier
      </p>
      <ol ref={list} className="mt-6 divide-y divide-line border-y border-line">
        {posts.map((post) => (
          <li key={post.slug}>
            <Link
              href={`/blog/${post.slug}`}
              className="group grid gap-x-10 gap-y-2 py-7 sm:grid-cols-[11rem_minmax(0,1fr)_auto] sm:items-baseline"
            >
              <time dateTime={post.date} className="font-mono text-[11.5px] uppercase tracking-[0.1em] text-ink-500">
                {postDate(post.date)}
              </time>
              <span className="min-w-0">
                <span className="block font-display text-[1.45rem] leading-tight tracking-[-0.025em] text-ink underline decoration-transparent underline-offset-[6px] transition-colors group-hover:decoration-ink/30">
                  {post.title}
                </span>
                <span className="mt-2 block max-w-[64ch] text-[15px] leading-6 text-ink-600">{post.description}</span>
              </span>
              <span className="font-mono text-[11.5px] text-ink-400">{`${minutesOf(post)} min`}</span>
            </Link>
          </li>
        ))}
      </ol>
    </div>
  );
}
