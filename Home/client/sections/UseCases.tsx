import { ArrowDownRight, Check, ShieldCheck } from "lucide-react";
import { type ProductDef, PRODUCTS } from "@/products/data";
import { getUseCasesForProduct, PRODUCT_USE_CASES, SHOWCASE_USE_CASES } from "@/products/useCases";

type UseCasesProps = {
  product?: ProductDef;
  includeAll?: boolean;
};

export function UseCases({ product, includeAll = false }: UseCasesProps) {
  const useCases = product
    ? getUseCasesForProduct(product.slug)
    : includeAll
      ? PRODUCT_USE_CASES.slice(0, 6)
      : SHOWCASE_USE_CASES;

  return (
    <section className="overflow-hidden bg-zinc-950 text-white">
      <div className="mx-auto max-w-[88rem] px-5 py-20 sm:px-6 sm:py-24 lg:py-28">
        <div className="grid gap-8 lg:grid-cols-[0.78fr_1.22fr] lg:items-end">
          <div>
            <div className="inline-flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.2em] text-emerald-400">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              {product ? `${product.name} in practice` : "Built for actual work"}
            </div>
            <h2 className="mt-5 max-w-2xl text-balance text-4xl font-semibold leading-[1.02] tracking-[-0.045em] sm:text-5xl lg:text-[3.6rem]">
              {product ? (
                <>
                  See where {product.name.toLowerCase()}{" "}
                  <span className="text-zinc-500">earns its place.</span>
                </>
              ) : (
                <>
                  Start with a job.{" "}
                  <span className="text-zinc-500">Build the employee around it.</span>
                </>
              )}
            </h2>
          </div>
          <p className="max-w-2xl text-pretty text-base leading-7 text-zinc-400 lg:justify-self-end lg:text-lg">
            {product
              ? `These are concrete ways teams put ${product.name} to work with AI Employees and human review in the same system.`
              : "Give each AI Employee a clear role, the right company context, and explicit Grants. Genosyn gives them the shared workspace to observe, decide, act, and hand work back to people."}
          </p>
        </div>

        <div className="mt-12 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {useCases.map((useCase, index) => (
            <article
              key={useCase.role}
              className={`group relative overflow-hidden rounded-[1.5rem] border border-white/10 bg-zinc-900 p-6 sm:p-7 ${
                !product && index === 0 ? "md:col-span-2 xl:col-span-1" : ""
              }`}
            >
              <div
                aria-hidden
                className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/35 to-transparent opacity-70"
              />
              <div className="flex items-start gap-4">
                <span
                  className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-xs font-bold ring-1 ${useCase.accent}`}
                >
                  {useCase.initials}
                </span>
                <div className="min-w-0">
                  <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-zinc-500">
                    {useCase.team}
                  </div>
                  <h3 className="mt-1 text-lg font-semibold tracking-[-0.015em] text-white">
                    {useCase.role}
                  </h3>
                </div>
              </div>

              <p className="mt-5 min-h-[3.5rem] text-sm leading-6 text-zinc-400">
                {useCase.objective}
              </p>

              <ol className="mt-6 space-y-3 border-t border-white/10 pt-5">
                {useCase.steps.map((step, stepIndex) => (
                  <li key={step} className="flex items-start gap-3 text-[13px] leading-5">
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/5 text-[9px] font-bold text-zinc-400">
                      {stepIndex + 1}
                    </span>
                    <span className="text-zinc-300">{step}</span>
                  </li>
                ))}
              </ol>

              <div className="mt-6 flex items-start gap-2.5 rounded-xl border border-emerald-400/15 bg-emerald-400/[0.06] px-3.5 py-3">
                <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
                <span className="text-[11px] font-medium leading-5 text-emerald-100">
                  {useCase.outcome}
                </span>
              </div>

              <div className="mt-5 flex flex-wrap gap-1.5">
                {useCase.productSlugs.slice(0, 3).map((slug) => {
                  const useCaseProduct = PRODUCTS.find((candidate) => candidate.slug === slug);
                  return useCaseProduct ? (
                    <span
                      key={slug}
                      className="rounded-md border border-white/10 bg-white/[0.035] px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.12em] text-zinc-500"
                    >
                      {useCaseProduct.name}
                    </span>
                  ) : null;
                })}
              </div>
            </article>
          ))}
        </div>

        <div className="mt-10 flex flex-col gap-4 border-t border-white/10 pt-6 text-xs text-zinc-500 sm:flex-row sm:items-center sm:justify-between">
          <span className="inline-flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-emerald-400" />
            Sensitive actions can pause for a Member&apos;s approval.
          </span>
          <span className="inline-flex items-center gap-1.5 font-semibold text-zinc-300">
            Your company. Your models. Your infrastructure.
            <ArrowDownRight className="h-3.5 w-3.5 text-zinc-500" />
          </span>
        </div>
      </div>
    </section>
  );
}
