# Genosyn — Home

The standalone marketing site for [Genosyn](https://github.com/Genosyn/genosyn).

React 18 + Vite + TailwindCSS, served in production by a tiny Express process.

The site is black and white. A neutral paper ground, near-black ink, and black
"night" panels carry the structure; there is no accent hue and no italic.
Headings and text are set in Mona Sans, and anything the software emitted —
clocks, cron lines, commands — in Geist Mono. Emphasis is weight, a lighter
grey for the second half of a few headlines, and inversion: the one thing on a
surface that needs a person is drawn solid (a Decision), and an Approval is
outlined. Department hues appear only as small dots beside a label. Tokens live in `tailwind.config.ts`; shared surfaces, headings, buttons
and tags live in `client/sections/Kit.tsx`.

The vision page (`client/vision/`) is the one route about direction rather
than shipped behavior. It follows Sunwise, a sample rooftop-solar company, from the one
sentence its board writes to its twentieth year, and ends by marking plainly
which parts ship today. Its numbers are kept consistent with one another (see
`client/vision/data.ts`), and the catalogue test checks the arithmetic.

The landing page tells one sample night at a company on Genosyn. The hero plays
the night forward from 04:05 to 09:30 on a console — Runs arriving, the horizon
brightening — and then shows the morning: eighteen Runs finished, three things
waiting for a person. The same data (`client/lib/night.ts`) draws the 09:31
dashboard further down, so the two views cannot disagree. Product mock-ups picture the App and are illustrative, not
live records.

Motion is brief and optional. Entrances run once through
`client/components/Reveal.tsx`; hover and press feedback lives in
`client/motion.css`. Everything is present in the prerendered HTML, and the
reduced-motion setting skips the hero straight to the morning, stops the
marquee, and removes transitions.

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
│   ├── App.tsx                # routing for /, /vision, /roles, /products, /docs, …
│   ├── index.css              # Tailwind entrypoint
│   ├── motion.css             # hover, press and entrance motion, reduced-motion rules
│   ├── components/            # Logo, Marks, and the Reveal entrance primitive
│   ├── lib/                   # router, head manager, siteMeta (SEO), night.ts, icons
│   ├── public/favicon.svg
│   ├── sections/              # Kit, Nav, Hero and the landing bands, Footer
│   ├── vision/                # /vision: where Genosyn is going, told through one sample company
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
