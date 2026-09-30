import { Check } from "lucide-react";
import { useReveal } from "@/components/Reveal";
import { SIGN_UP_URL } from "@/lib/constants";
import { Button, Container, Em, Section, SectionHead, TextLink } from "@/sections/Kit";

const ENTERPRISE_HREF = "mailto:enterprise@genosyn.com?subject=Genosyn%20Enterprise";

type Teaser = {
  where: string;
  name: string;
  price: string;
  unit: string;
  points: string[];
  cta: { label: string; href: string };
  featured?: boolean;
};

const PLANS: Teaser[] = [
  {
    where: "Your hardware",
    name: "Community",
    price: "$0",
    unit: "forever, Apache 2.0",
    points: ["Unlimited AI Employees", "Unlimited Routines", "No licence key, no telemetry"],
    cta: { label: "Install it", href: "/docs/install" },
  },
  {
    where: "Genosyn Cloud",
    name: "Free, then Growth",
    price: "$19",
    unit: "per AI Employee / month",
    points: ["Start free with one AI Employee", "We run upgrades, backups and hosting", "Human Members are always free"],
    cta: { label: "Start free", href: SIGN_UP_URL },
    featured: true,
  },
  {
    where: "Cloud or your hardware",
    name: "Scale & Enterprise",
    price: "$49",
    unit: "per AI Employee / month",
    points: [
      "Single sign-on and the audit log",
      "Or an Enterprise licence on your own hardware",
      "Priority support from the people who wrote it",
    ],
    cta: { label: "Talk to us", href: ENTERPRISE_HREF },
  },
];

export function PricingTeaser() {
  const cards = useReveal<HTMLUListElement>(0, 80);
  return (
    <Section id="pricing" space="md" rule>
      <Container>
        <SectionHead
          kicker="Pricing"
          title={
            <>
              Free to run yourself. <Em>Simple when we run it.</Em>
            </>
          }
          lede="You pay for AI Employees you hire, not for the people who work beside them. Every plan uses model keys you bring, so token spend is between you and your provider."
        />

        <ul ref={cards} className="mt-14 grid gap-4 lg:grid-cols-3">
          {PLANS.map((plan) => (
            <li
              key={plan.name}
              className={`flex flex-col rounded-3xl border p-7 ${
                plan.featured ? "border-ink bg-ink text-white shadow-lifted" : "border-line bg-paper-raised text-ink"
              }`}
            >
              <p className={`font-mono text-[11px] uppercase tracking-[0.12em] ${plan.featured ? "text-white/50" : "text-ink-400"}`}>
                {plan.where}
              </p>
              <p className="mt-3 text-[17px] font-medium">{plan.name}</p>
              <p className="mt-6 flex items-baseline gap-2.5">
                <span className="font-display text-[3.4rem] leading-none tracking-[-0.04em]">{plan.price}</span>
                <span className={`text-[13.5px] ${plan.featured ? "text-white/60" : "text-ink-500"}`}>{plan.unit}</span>
              </p>
              <ul className={`mt-7 space-y-2.5 border-t pt-6 ${plan.featured ? "border-white/15" : "border-line"}`}>
                {plan.points.map((point) => (
                  <li key={point} className={`flex items-start gap-2.5 text-[14px] leading-5 ${plan.featured ? "text-white/85" : "text-ink-600"}`}>
                    <Check aria-hidden className={`mt-0.5 h-4 w-4 shrink-0 ${plan.featured ? "text-white" : "text-ink"}`} strokeWidth={1.8} />
                    {point}
                  </li>
                ))}
              </ul>
              <div className="mt-auto pt-8">
                <Button href={plan.cta.href} variant={plan.featured ? "paper" : "outline"} arrow className="w-full">
                  {plan.cta.label}
                </Button>
              </div>
            </li>
          ))}
        </ul>

        <div className="mt-10 flex justify-center">
          <TextLink href="/pricing">Compare every plan</TextLink>
        </div>
      </Container>
    </Section>
  );
}
