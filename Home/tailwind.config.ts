import type { Config } from "tailwindcss";

/**
 * The marketing site's visual language: black and white. A neutral paper,
 * near-black ink, and black night panels, set in Mona Sans (headings and
 * text) and Geist Mono (anything the software emitted — clocks, cron lines,
 * Run ids).
 *
 * There is no accent hue and no italic. Emphasis is weight, a lighter grey
 * for the second half of a few headlines, and inversion: the one thing on a
 * surface that needs a person is drawn solid — black on paper, white on the
 * night. A Decision is a solid pill; an Approval is an outlined one.
 *
 * Product mock-ups (previews.tsx, ProductPrototype.tsx, CompanyPreview.tsx)
 * picture the App, so they keep Tailwind's own slate and indigo, exactly as
 * the App does. Nothing here remaps a built-in palette.
 */
export default {
  content: ["./client/index.html", "./client/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        paper: {
          DEFAULT: "#F5F5F2",
          raised: "#FFFFFF",
          sunken: "#EDEDE9",
          deep: "#E3E3DE",
        },
        ink: {
          DEFAULT: "#0E0E0D",
          50: "#F3F3F1",
          100: "#E6E6E3",
          200: "#D1D1CD",
          300: "#B3B3AE",
          400: "#8E8E89",
          500: "#6B6B66",
          600: "#51514D",
          700: "#393936",
          800: "#232321",
          900: "#0E0E0D",
        },
        line: {
          DEFAULT: "#E2E2DD",
          strong: "#CDCDC7",
        },
        night: {
          DEFAULT: "#0A0A0A",
          raised: "#131313",
          high: "#1C1C1C",
          line: "#272727",
          muted: "#A3A3A0",
          faint: "#6B6B68",
        },
        moss: {
          50: "#EEF6F0",
          400: "#5DB585",
          500: "#3C8F63",
          600: "#2F7450",
        },
        // One hue per department, for dots and small markers only — never a
        // surface, and never a warm orange: a hue means "this department",
        // not "look here".
        dept: {
          finance: "#3C8F63",
          repositories: "#7358D0",
          marketing: "#C04A8F",
          workspace: "#4467D6",
          email: "#2388B6",
          revenue: "#1E9486",
          operations: "#6B7580",
          people: "#D24D5E",
        },
      },
      fontFamily: {
        display: [
          "Mona Sans",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        sans: [
          "Mona Sans",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        mono: ["Geist Mono", "ui-monospace", "SFMono-Regular", "Menlo", "Monaco", "monospace"],
      },
      fontSize: {
        // Display sizes are fluid: a phone gets a headline that fits two or
        // three lines, a wide screen gets one that fills the measure.
        "display-2xl": ["clamp(2.8rem, 6.4vw, 5.5rem)", { lineHeight: "0.98", letterSpacing: "-0.045em" }],
        "display-xl": ["clamp(2.4rem, 5vw, 4.25rem)", { lineHeight: "1", letterSpacing: "-0.042em" }],
        "display-lg": ["clamp(2rem, 3.7vw, 3.15rem)", { lineHeight: "1.04", letterSpacing: "-0.038em" }],
        "display-md": ["clamp(1.65rem, 2.6vw, 2.25rem)", { lineHeight: "1.1", letterSpacing: "-0.03em" }],
        "display-sm": ["clamp(1.3rem, 1.8vw, 1.6rem)", { lineHeight: "1.18", letterSpacing: "-0.02em" }],
      },
      letterSpacing: {
        kicker: "0.14em",
      },
      borderRadius: {
        "4xl": "2rem",
        "5xl": "2.5rem",
      },
      boxShadow: {
        hairline: "0 0 0 1px rgb(14 14 13 / 0.08)",
        soft: "0 1px 2px rgb(14 14 13 / 0.04), 0 4px 12px -2px rgb(14 14 13 / 0.06)",
        lifted:
          "0 1px 2px rgb(14 14 13 / 0.05), 0 12px 32px -12px rgb(14 14 13 / 0.18), 0 32px 64px -32px rgb(14 14 13 / 0.2)",
        float:
          "0 2px 4px rgb(0 0 0 / 0.25), 0 24px 48px -16px rgb(0 0 0 / 0.6), inset 0 1px 0 rgb(255 255 255 / 0.06)",
        glow: "0 0 0 1px rgb(255 255 255 / 0.35), 0 0 18px rgb(255 255 255 / 0.35)",
      },
      maxWidth: {
        site: "78rem",
      },
      keyframes: {
        marquee: {
          from: { transform: "translateX(0)" },
          to: { transform: "translateX(-50%)" },
        },
        "rise-in": {
          from: { opacity: "0", transform: "translateY(10px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        pulse: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.35" },
        },
        blink: {
          "0%, 49%": { opacity: "1" },
          "50%, 100%": { opacity: "0" },
        },
      },
      animation: {
        marquee: "marquee 48s linear infinite",
        "rise-in": "rise-in 520ms cubic-bezier(0.22, 1, 0.36, 1) both",
        "fade-in": "fade-in 400ms ease-out both",
        "soft-pulse": "pulse 2.4s ease-in-out infinite",
        blink: "blink 1.1s steps(1) infinite",
      },
    },
  },
  plugins: [],
} satisfies Config;
