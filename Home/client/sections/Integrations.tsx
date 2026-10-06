import { Container } from "@/sections/Kit";

/**
 * Integrations that ship in the App today (server/integrations/providers) —
 * named in text, not drawn as borrowed logos, and never presented as
 * customers.
 */
const INTEGRATIONS = [
  "Stripe",
  "Gmail",
  "Slack",
  "GitHub",
  "Linear",
  "Notion",
  "Airtable",
  "Google Ads",
  "Meta Ads",
  "Microsoft Ads",
  "Reddit Ads",
  "LinkedIn",
  "Microsoft Teams",
  "WhatsApp",
  "Telegram",
  "Brex",
  "Postgres",
  "MySQL",
  "ClickHouse",
  "Forgejo",
  "Google Analytics",
];

const MODELS = ["Claude", "GPT", "Ollama", "vLLM", "llama.cpp", "LM Studio"];

export function Integrations() {
  return (
    <section aria-label="Models and integrations" className="py-14 sm:py-16">
      <Container>
        <div className="grid items-center gap-8 lg:grid-cols-[minmax(0,19rem)_minmax(0,1fr)] lg:gap-14">
          <div>
            <p className="text-[15px] leading-6 text-ink-600">
              Runs on the model you choose —{" "}
              <span className="text-ink">{MODELS.join(", ")}</span> — and works inside the tools
              you already use.
            </p>
          </div>
          <div className="fade-x group relative overflow-hidden">
            <ul className="flex w-max animate-marquee items-center group-hover:[animation-play-state:paused] motion-reduce:w-auto motion-reduce:flex-wrap motion-reduce:gap-y-3">
              {[...INTEGRATIONS, ...INTEGRATIONS].map((name, index) => (
                <li
                  key={`${name}-${index}`}
                  aria-hidden={index >= INTEGRATIONS.length}
                  className="flex items-center whitespace-nowrap px-6 text-[1.35rem] font-semibold leading-none tracking-[-0.03em] text-ink-300 motion-reduce:[&:nth-child(n+22)]:hidden"
                >
                  {name}
                  <span aria-hidden className="ml-12 h-1 w-1 rounded-full bg-ink-200" />
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Container>
    </section>
  );
}
