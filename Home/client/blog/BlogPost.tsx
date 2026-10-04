import { useEffect, useRef, useState } from "react";
import type { MouseEvent, RefObject } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { postContent } from "@/blog/content";
import { postDate, type Post } from "@/blog/posts";
import { LogoMark } from "@/components/Logo";
import { isInternalRoute, Link, navigate } from "@/lib/router";
import { ClosingCta, Footer } from "@/sections/Footer";
import { Container, NightPanel } from "@/sections/Kit";
import { Nav } from "@/sections/Nav";
import { IdeaArt } from "@/vision/IdeaArt";
import "./blog.css";

/**
 * One post: a header, the drawing it borrows from the vision page when it has
 * one, its Markdown rendered to HTML, and a way on to the vision itself.
 */
export function BlogPost({ post }: { post: Post }) {
  const article = useRef<HTMLElement>(null);
  const content = postContent(post.slug);
  const minutes = content?.minutes ?? 1;

  return (
    <div className="min-h-screen overflow-x-clip bg-paper text-ink">
      <ReadingProgress article={article} />
      <Nav />
      <main>
        <article ref={article}>
          <header className="pb-12 pt-12 sm:pb-16 sm:pt-16 lg:pt-20">
            <Container narrow>
              <Link
                href="/blog"
                className="group inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-500 transition-colors hover:text-ink"
              >
                <ArrowLeft aria-hidden className="h-3.5 w-3.5 transition-transform duration-200 group-hover:-translate-x-0.5" />
                Blog
              </Link>
              <h1 className="mt-8 text-balance font-display text-display-xl text-ink">{post.title}</h1>
              <p className="mt-7 max-w-[56ch] text-pretty text-[1.1875rem] leading-[1.6] text-ink-600 sm:text-[1.3125rem]">
                {post.description}
              </p>
              <div className="mt-10 flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-line pt-6">
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-ink text-white">
                  <LogoMark className="h-[18px] w-[18px]" />
                </span>
                <span className="text-[14.5px] font-medium text-ink">{post.author}</span>
                <span className="flex items-center gap-2.5 font-mono text-[11px] uppercase tracking-[0.12em] text-ink-500 sm:ml-auto">
                  <time dateTime={post.date}>{postDate(post.date)}</time>
                  <span aria-hidden>·</span>
                  <span>{`${minutes} min read`}</span>
                </span>
              </div>
            </Container>
          </header>

          {post.art && (
            <NightPanel dawn={0.55}>
              <div className="mx-auto max-w-site">
                <IdeaArt art={post.art} legend={post.legend ?? ""} frame="relative h-64 sm:h-80 lg:h-96" />
              </div>
            </NightPanel>
          )}

          <Container narrow className="py-14 sm:py-20">
            {/* Rendered from the post's own Markdown, with raw HTML escaped: see markdown.ts. */}
            <div
              className="blog-prose mx-auto max-w-[40rem]"
              onClick={followInternalLinks}
              dangerouslySetInnerHTML={{ __html: content?.html ?? "" }}
            />
          </Container>

          <footer className="pb-20 sm:pb-24">
            <Container narrow>
              <div className="mx-auto max-w-[40rem]">
                <ReadNext />
                <p className="mt-8 text-center">
                  <Link
                    href="/blog"
                    className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-500 transition-colors hover:text-ink"
                  >
                    Every post
                  </Link>
                </p>
              </div>
            </Container>
          </footer>
        </article>
        <ClosingCta />
      </main>
      <Footer />
    </div>
  );
}

/** Where every post leads: the vision it comes from. */
function ReadNext() {
  return (
    <Link
      href="/vision"
      className="group block rounded-[1.75rem] border border-line bg-paper-raised p-7 shadow-soft transition-shadow duration-300 hover:shadow-lifted sm:p-9"
    >
      <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-500">Read next · The vision</span>
      <span className="mt-4 block text-balance font-display text-[1.65rem] leading-[1.1] tracking-[-0.03em] text-ink sm:text-[2rem]">
        Start a company with one sentence. <span className="text-ink-400">Let it work for a century.</span>
      </span>
      <span className="mt-6 inline-flex items-center gap-1.5 text-[15px] font-medium text-ink underline decoration-ink/20 underline-offset-[6px] transition-colors group-hover:decoration-ink">
        Read the vision
        <ArrowRight aria-hidden className="nudge h-4 w-4 opacity-70" />
      </span>
    </Link>
  );
}

/** A hairline across the top of the window that fills as the post is read. */
function ReadingProgress({ article }: { article: RefObject<HTMLElement> }) {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const update = () => {
      const node = article.current;
      if (!node) return;
      const box = node.getBoundingClientRect();
      const travel = Math.max(box.height - window.innerHeight, 1);
      setProgress(Math.min(Math.max(-box.top / travel, 0), 1));
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [article]);

  return (
    <div aria-hidden className="pointer-events-none fixed inset-x-0 top-0 z-[60] h-[3px]">
      <div className="h-full origin-left bg-ink" style={{ transform: `scaleX(${progress})` }} />
    </div>
  );
}

/**
 * Links inside a post are plain HTML from its Markdown, so they cannot be the
 * router's <Link>. One listener gives the same-site ones the same in-app
 * navigation, and leaves new-tab, modified and outside links to the browser.
 */
function followInternalLinks(event: MouseEvent<HTMLDivElement>) {
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const anchor = (event.target as HTMLElement).closest("a");
  const href = anchor?.getAttribute("href");
  if (!anchor || !href || anchor.target === "_blank" || !isInternalRoute(href)) return;
  event.preventDefault();
  navigate(href);
}
