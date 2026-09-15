import type { Config } from "tailwindcss";

/**
 * The marketing site shares the product's visual contract: slate surfaces,
 * indigo actions, Inter typography, modest radii, and soft elevation.
 *
 * The named colours and geometry below are compatibility aliases used across
 * the existing marketing, product, role, and documentation pages. Keep those
 * names until callers have migrated; their values deliberately resolve to the
 * same Tailwind palette the App uses.
 */
export default {
  content: ["./client/index.html", "./client/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Untouched docs/template call sites use zinc; keep them on the same
        // neutral ramp instead of leaving a second visual skin in the bundle.
        zinc: {
          50: "#f8fafc",
          100: "#f1f5f9",
          200: "#e2e8f0",
          300: "#cbd5e1",
          400: "#94a3b8",
          500: "#64748b",
          600: "#475569",
          700: "#334155",
          800: "#1e293b",
          900: "#0f172a",
          950: "#020617",
        },

        // Legacy neutral aliases, now mapped to the App's slate ramp.
        ink: "#0f172a", // slate-900
        ink2: "#334155", // slate-700
        muted: "#64748b", // slate-500
        rule: "#e2e8f0", // slate-200
        hairline: "#f1f5f9", // slate-100
        seam: "#e2e8f0", // slate-200
        dim: "#94a3b8", // slate-400
        ground: "#f8fafc", // slate-50
        surface: "#ffffff",

        // Semantic hues stay local to small markers, chips, and statuses.
        dept: {
          finance: "#059669", // emerald-600
          repositories: "#7c3aed", // violet-600
          marketing: "#c026d3", // fuchsia-600
          workspace: "#4f46e5", // indigo-600
          email: "#0284c7", // sky-600
          revenue: "#ea580c", // orange-600
          operations: "#d97706", // amber-600
          people: "#e11d48", // rose-600
          legal: "#64748b", // slate-500; retained for the autonomy preview
        },
        tint: {
          finance: "#ecfdf5", // emerald-50
          repositories: "#f5f3ff", // violet-50
          marketing: "#fdf4ff", // fuchsia-50
          workspace: "#eef2ff", // indigo-50
          email: "#f0f9ff", // sky-50
          revenue: "#fff7ed", // orange-50
          operations: "#fffbeb", // amber-50
          people: "#fff1f2", // rose-50
          legal: "#f8fafc", // slate-50
        },
      },
      fontFamily: {
        display: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Monaco", "Consolas", "monospace"],
      },
      letterSpacing: {
        label: "0.08em",
        field: "0.06em",
      },
      // Compatibility names only; standard Tailwind radii remain untouched.
      borderRadius: {
        pane: "0.75rem",
        control: "0.5rem",
        chip: "0.375rem",
      },
      // Compatibility names only; standard Tailwind shadows remain untouched.
      boxShadow: {
        card: "0 1px 2px 0 rgb(15 23 42 / 0.05)",
        lift: "0 4px 8px -2px rgb(15 23 42 / 0.08)",
        raise: "0 10px 20px -8px rgb(15 23 42 / 0.16)",
        float: "0 20px 40px -16px rgb(15 23 42 / 0.22)",
        panel: "0 1px 2px 0 rgb(15 23 42 / 0.05)",
      },
      keyframes: {
        strip: {
          from: { transform: "scaleX(0)" },
          to: { transform: "scaleX(1)" },
        },
        arrive: {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        wipe: {
          from: { transform: "scaleY(0)" },
          to: { transform: "scaleY(1)" },
        },
      },
      animation: {
        strip: "strip 180ms cubic-bezier(0.16, 1, 0.3, 1) both",
        arrive: "arrive 160ms ease-out both",
        wipe: "wipe 160ms ease-out both",
      },
    },
  },
  plugins: [],
} satisfies Config;
