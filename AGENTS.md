# Relay Chat Dock — agent notes

Local OBS companion. Twitch + Kick + YouTube chat in one dock, plus Activity, Alerts, a companion window, and a readonly LAN watch page.

Canonical types live in `server/types.ts`. The Vite app imports that file too. A top-level `shared/` folder would sit outside the server `rootDir` (`server/`) and break the `dist-server/` layout Electron loads.

## Layout

- `server/server.ts` — process entry: Express, listen, companion window, wires adapters
- `server/http-routes.ts` — `/api/*`, `/events`, `/oauth/*`
- `server/twitch-live.ts` — EventSub + IRC + Helix send/moderation
- `server/youtube-live.ts` — official Data API, quota bookkeeping, InnerTube ingest glue
- `server/kick-live.ts` — Kick public API send/moderation + chat start
- `server/oauth.ts` — authorize URL, code exchange, refresh
- `server/logic.ts` — barrel of pure helpers (no I/O). Implementations in `server/logic/`
- `server/logic/chat-merge.ts` — `mergeIncomingChat`, copies, own-message matching
- `server/kick-chat.ts`, `youtube-chat.ts`, `streamelements.ts` — platform readers
- `src/chat/` — chat dock (`/`)
- `src/activity/` — activity dock (`/activity`)
- `src/alerts/` — OBS alert source (`/alerts`)
- `src/ConsoleApp.tsx` — companion window (`/console`)
- `src/WatchApp.tsx` — readonly LAN (`/watch`)
- `electron/` — window shell; loads `/console` after `relayReady`

## Invariants

- Unified send: POST `/api/messages` creates one row with a local UUID and `platforms[]`. Platform echoes fold into that row via `mergeIncomingChat`; they do not append a second line.
- Kick incoming: realtime WebSocket (Pusher is retired). Send still uses Kick public `/chat`.
- Packaged data/logs: `%LOCALAPPDATA%\Relay Chat Dock` via `operatorFilesDir`. Alert media is `data/alerts/<uuid>` (GET `/alerts/assets/:id`).
- Client secrets stay in `production.env`. Never `VITE_*`.
- Merge to `main` publishes a release. Open a PR; do not merge unless asked.
- Do not bump `package.json` version unless the user is shipping a release.

## Commands

- `npm test` — all `tests/*.test.ts` via `scripts/run-tests.mjs`
- `npm run test:chat` — chat merge, Kick, Twitch IRC, moderation
- `npm run test:youtube` — YouTube quota, privacy, InnerTube, ingest
- `npm run dev` + `npm run dev:backend` — UI + API
- `npm run package:win` — Windows dir build

After a behavior change, run the matching test file before `npm test`.

## Do not read

`node_modules/`, `deploy/`, `deploy-electron/`, `dist/`, `dist-server/`, `dist-package/`, `release-staging/`
