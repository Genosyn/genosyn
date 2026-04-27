import type { Config } from "tailwindcss";

export default {
  content: ["./client/index.html", "./client/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
        serif: [
          "'Instrument Serif'",
          "ui-serif",
          "Georgia",
          "Cambria",
          "'Times New Roman'",
          "serif",
        ],
        mono: [
          "'JetBrains Mono'",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "monospace",
        ],
      },
      colors: {
        ink: {
          DEFAULT: "#0e0d0c",
          soft: "#3a3733",
          mute: "#7a766f",
        },
        bone: {
          DEFAULT: "#f4efe6",
          page: "#f7f3ec",
          card: "#fbf8f1",
        },
        accent: {
          DEFAULT: "#cc3a14",
          ink: "#a82e0c",
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
