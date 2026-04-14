export function Quote() {
  return (
    <section className="mx-auto max-w-4xl px-6 py-24 sm:py-32">
      <figure className="text-center">
        <blockquote className="text-3xl font-medium leading-tight tracking-tight text-slate-900 sm:text-4xl">
          &ldquo;Markdown as source of truth.&rdquo;
        </blockquote>
        <figcaption className="mt-6 text-sm text-slate-500">
          Soul, skills, routines — readable, diffable, committable files on disk. The database is
          the index, not the truth.
        </figcaption>
      </figure>
    </section>
  );
}
