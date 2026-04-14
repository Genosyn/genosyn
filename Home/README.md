# Genosyn — Home

The standalone marketing site for [Genosyn](https://github.com/Genosyn/genosyn).

React 18 + Vite + TailwindCSS, served in production by a tiny Express process.

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
│   ├── App.tsx
│   ├── index.css              # Tailwind entrypoint
│   ├── lib/constants.ts
│   ├── public/favicon.svg
│   └── sections/              # Nav, Hero, Features, HowItWorks, Quote, Footer
├── tailwind.config.ts
├── postcss.config.cjs
├── vite.config.ts
├── tsconfig.json              # client
├── tsconfig.server.json       # server
├── .eslintrc.cjs
├── .prettierrc
└── package.json
```
