# Genosyn — Home

The standalone marketing site for [Genosyn](https://github.com/Genosyn/genosyn).

React 18 + Vite + TailwindCSS, served in production by a tiny Express process.

The site follows the product application's visual contract: an Inter/system
type stack, a slate-50 canvas, white cards with slate borders, and indigo for
primary actions and focus. Semantic hues stay local to compact statuses and
department markers. Compatibility tokens live in `tailwind.config.ts`; shared
surfaces, headings, and controls live in `client/sections/Kit.tsx`.

The homepage opens with an animated sample company. Visitors can choose Support,
Finance, or Engineering and follow an AI Employee from an incoming request,
through readable work steps, to a finished result. Pause and manual step controls
let visitors explore at their own pace. These are illustrative examples, not
live company records.

Headings and product cards also animate into view, with small hover and
keyboard-focus responses on links and actions. Shared motion lives in
`client/components/Reveal.tsx` and `client/motion.css`. Content is visible in
prerendered HTML and when motion APIs are unavailable. Entrances run once and
stop when their content receives keyboard focus. The system's reduced-motion
setting, including changes while the page is open, removes animated transitions
and automatic demo playback; the examples remain available through manual
controls.

## Scripts

```bash
npm install        # install deps
npm run dev        # Vite dev server on http://localhost:8472
npm run build      # compile server.ts + build client into dist/
npm run lint       # eslint
npm run typecheck  # tsc --noEmit for client and server
npm start          # run dist/server.js (requires npm run build first)
```

## Build output

- `dist/server.js` — Express process that serves the built client
- `dist/client/` — Vite client bundle (HTML, JS, CSS, assets)

The Docker image (`Home/Dockerfile`) runs `node dist/server.js` on port `8472`.

## Structure

```
Home/
├── server.ts                  # Express: serves dist/client/ with SPA fallback
├── client/
│   ├── index.html
│   ├── main.tsx
│   ├── App.tsx                # routing for /, /roles, /products, /docs, …
│   ├── index.css              # Tailwind entrypoint
│   ├── motion.css             # shared action interactions and reduced-motion rules
│   ├── components/            # accessible, reusable motion primitives
│   ├── lib/                   # router, head manager, siteMeta (SEO registry)
│   ├── public/favicon.svg
│   ├── sections/              # Nav, Hero, Roles, Autonomy, Features, Footer
│   ├── roles/                 # role registry + /roles and /roles/<slug> pages
│   ├── products/              # product registry + /products pages
│   └── docs/                  # /docs shell, nav, and pages
├── tailwind.config.ts
├── postcss.config.cjs
├── vite.config.ts
├── tsconfig.json              # client
├── tsconfig.server.json       # server
├── .eslintrc.cjs
├── .prettierrc
└── package.json
```
