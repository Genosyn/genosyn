import type { Config } from "tailwindcss";

import app from "./tailwind.config";

/**
 * The Chat widget's own Tailwind build: the App's theme, scanned over the widget's
 * bundle alone, so a visitor on someone else's site downloads only what it uses.
 */
export default {
  ...app,
  content: ["./client/chat-widget.html", "./client/chat-widget/**/*.{ts,tsx}"],
} satisfies Config;
