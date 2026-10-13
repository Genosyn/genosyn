import type { ReactNode } from "react";
import { postDate } from "@/blog/posts";
import { INLINE_LINK } from "@/docs/Prose";
import { LEGAL_CONTACT, LEGAL_UPDATED } from "@/legal/data";
import { Footer } from "@/sections/Footer";
import { Container } from "@/sections/Kit";
import { Nav } from "@/sections/Nav";

/**
 * The reading surface for /privacy and /terms: the docs' type, in the
 * marketing site's frame, with the date the text last changed.
 */
export function LegalPage({
  title,
  lead,
  children,
}: {
  title: string;
  lead: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen overflow-x-clip bg-paper text-ink">
      <Nav />
      <main>
        <article className="pb-24 pt-12 sm:pb-32 sm:pt-16 lg:pt-20">
          <Container narrow>
            <header className="border-b border-line pb-10">
              <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-500">
                {"Last updated "}
                <time dateTime={LEGAL_UPDATED}>{postDate(LEGAL_UPDATED)}</time>
              </p>
              <h1 className="mt-6 text-balance font-display text-[clamp(2.4rem,5vw,3.5rem)] leading-[1.02] tracking-[-0.03em] text-ink">
                {title}
              </h1>
              <p className="mt-6 max-w-[60ch] text-[1.125rem] leading-[1.7] text-ink-600">{lead}</p>
            </header>
            <div className="max-w-[44rem]">{children}</div>
          </Container>
        </article>
      </main>
      <Footer />
    </div>
  );
}

/** A mail link, to the legal contact unless another address is named. */
export function MailLink({ address = LEGAL_CONTACT }: { address?: string }) {
  return (
    <a href={`mailto:${address}`} className={INLINE_LINK}>
      {address}
    </a>
  );
}
