# Duo Tracker San Diego

Live iPhone Duo in-store pickup availability for Apple Stores around San Diego (Fashion Valley, UTC, Carlsbad, Escondido, Otay Ranch, plus Temecula and south Orange County inside a 75 mile radius). Checks every 5 seconds, logs every drop, and alerts you when a model you want shows up.

## 1. Part numbers

All eight US iPhone Duo configurations are already filled in `lib/config.ts`. Delete any you don't want to watch. If a buy link doesn't open the right page, set `buyUrl` on that model to the exact URL you want.

## 2. Deploy to Vercel

1. Push this folder to a new GitHub repo.
2. In Vercel, choose Add New, Project, import the repo, and deploy. No environment variables are needed.

To run locally: `npm install`, then `npm run dev`, then open http://localhost:3000.

## How it works

- `app/api/availability/route.ts` asks Apple's public pickup endpoint about each ZIP in `ZIPS`, merges the stores, drops anything outside `RADIUS_MILES`, and caches the answer for 4 seconds so several open phones share one request.
- The page polls that route every 5 seconds (every 15 when the tab is in the background) and watches for a store flipping from sold out to available.
- Drops and your alert picks are saved in the browser on that device.

## Things to know

- Apple can throttle or block requests from cloud servers. If the status pill says "Apple not responding" for long stretches, lower the polling rate in `POLL_MS` or remove a ZIP.
- Alerts fire while the page is open. On iPhone, add the site to your Home Screen (Share, Add to Home Screen), open it from there, and tap "Turn on alerts". For alerts with the app fully closed you would need a background worker plus Web Push, which this version does not include.
- Want a different radius or more coverage? Change `ZIPS`, `RADIUS_MILES`, and `RINGS` in `lib/config.ts`.

Not affiliated with Apple. Always confirm availability at checkout.
