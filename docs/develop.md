# Develop

[README](../README.md) · [Install](install.md) · [Setup](setup.md) · [Docks](docks.md) · [Activity](activity.md) · [Alerts](alerts.md)

Operator setup is in the docs linked above. The coding map is [AGENTS.md](../AGENTS.md). A short process sketch is [architecture.md](architecture.md).

## Run with Node

```powershell
npm install
npm run build
npm start
```

The backend serves the docks at `http://localhost:4173` and `http://localhost:4173/activity`. Keep `npm start` running while OBS is open. For frontend development, use `npm run dev` and run `npm run dev:backend` in a second terminal.

Development runs keep `production.env` and `data\` under the project directory unless `RELAY_DATA_DIR` is set.

## Package the Windows app

Prefer the [prebuilt Windows installer](https://github.com/Milzstream/OBS-Multi-Chat/releases/latest) unless you are changing the code. Double-click `easy.bat`, or from a terminal:

```powershell
npm run package:win
npm run installer:win
```

`easy.bat` and `package:win` fill `deploy\` with the Electron app and `deploy\relay-chat-dock.exe`. Closing that window stops the relay and the OBS docks. It does not need Edge or Chrome installed. `installer:win` needs [Inno Setup 6](https://jrsoftware.org/isinfo.php) and writes `obs-multi-chat-v*-windows-x64-setup.exe`. For a portable run, keep `production.env` and `.env.example` beside the executable, then run:

```powershell
.\relay-chat-dock.exe
```

The same package command also creates a ready-to-copy `deploy` folder containing the latest executable and frontend `dist` files. Existing values in `deploy/production.env` (including StreamElements JWTs) are preserved; the packager only adds missing keys. Copy that entire folder to the installation computer and run `deploy\relay-chat-dock.exe`.

On launch the exe appends any keys that are in `.env.example` but missing from `production.env`, including commented optional lines such as `# RELAY_ACTIVITY_MAX=5000`. Filled values and keys you already commented stay as they are. Installer updates replace `.env.example` next to the exe; `production.env` in `%LOCALAPPDATA%\Relay Chat Dock` is left alone.

The companion window only opens links from a short approved list (plus the app's own sign-in page). Other addresses stay closed. The app serves the docks at `http://localhost:4173` and binds to loopback (`127.0.0.1`) by default so other devices on the network cannot connect at all. Watch behavior is in [Install](install.md).

GitHub Actions attaches both the zip and the setup exe when `main` first ships a given `package.json` version, when you push a `v*` tag, or when you run **Build and Release** from the Actions tab. A version that already has a release tag is not published again.

## Backend endpoints

Loopback (this computer) can call every route with no token. From another computer, access is split into:

- Watch token (`?token=` on the shared link, then the `relay_watch` cookie): `GET /watch`, `GET /api/state`, `GET /events`, and `GET /api/media` only.
- `RELAY_API_TOKEN` header (`x-relay-token` or `Authorization: Bearer`): other reads and writes, including the JWT routes below. Not accepted from the query string. A matching `Origin` is not enough.
- This computer only, even with that header: the operator docks (`/`, `/activity`), the companion (`/console`, `/api/console`, `/api/logs`, `/events/logs`, `/api/console/*`), and `POST /api/shutdown`.
- OAuth (`GET /oauth/:platform`, `GET /oauth/callback`): this computer, or the API token header. A LAN browser cannot replace the stored Twitch, Kick, or YouTube token.

- `GET /watch` — readonly chat and activity page for a shared LAN link
- `GET /api/state` — current accounts, stream info, recent messages, activity, and settings
- `GET /events` — Server-Sent Events stream for dock updates
- `POST /api/messages` — send a message to selected platforms
- `GET /api/jwts` — companion-internal StreamElements JWTs for Twitch, Kick, and YouTube. Not included in `/api/state`, and not readable with the watch token
- `POST /api/jwts` — save those JWTs into `production.env` and reconnect StreamElements. Same write rule as the other mutating routes
- `POST /api/settings` — toggle native backup, ignore-missing-JWT, 30-day drop, translate, per-platform `autoLiveCheck` (`{ Twitch, Kick, YouTube }`; omitted or missing means on), `lanWatch` (hosts `/watch`; rebinds the socket only when `RELAY_BIND` is loopback), and `alerts` (including saved looks)
- `POST /api/alerts/assets` — upload alert graphic or sound (this computer). JSON `{ name, mime, data }` with a data URL or base64 body. Files are `data/alerts/<uuid>`
- `GET /alerts/assets/:id` — serve a stored alert file (this computer, same as `/alerts`)
- `POST /api/moderate` — delete a message, or timeout, ban, or unban a chatter. Twitch and Kick accept an optional `reason` (trimmed, max 500, omitted when blank). YouTube ignores `reason` because `liveChat/bans` has no reason field
- `POST /api/youtube/privacy` — set a warned YouTube broadcast or archive to public, or dismiss that warning. Only ids the backend is already warning about are accepted
- `POST /api/open` — open an allowlisted link in the system browser: Twitch profiles and channel-scoped viewer cards (`/popout/<channel>/viewercard/<login>`), Kick profiles, YouTube channel or `@handle` pages, creator dashboards, and YouTube Studio
- `POST /api/activity/test` — fire a StreamElements emulate for that platform and kind. The overlay plays it. The dock row arrives on the activities socket, not as a local inject. YouTube subscriber uses kind `subscription`
- `POST /api/activity/delete` — remove one stored activity by id. This computer only
- `GET /api/categories/:platform` — search Twitch or Kick categories
- `POST /api/stream-info/:platform` — apply title, category, and tags to one platform
- `POST /api/stream-info` — apply shared title plus per-platform Twitch and Kick category and tags
- `POST /api/disconnect/:platform` — remove a saved platform connection
- `POST /api/live-check/:platform` — run that platform's live check immediately, even if Auto is off (does not change the slower automatic YouTube interval)
- `GET /oauth/:platform` — begin OAuth for `twitch`, `kick`, or `youtube`
- `GET /oauth/callback` — exchange the provider authorization code server-side

## Current platform status

Twitch reads chat through EventSub WebSockets and sends through the Helix chat API, with Twitch IRC as a fallback for older tokens that cannot call Helix. A Helix send that Twitch drops is not also sent on IRC. The IRC fallback counts as sent only after Twitch echoes a real message id. YouTube OAuth and live detection use the Data API; incoming chat and viewer counts prefer InnerTube so a stream day fits in the default 10,000-unit quota. Kick OAuth, category search, chat sending, viewer polling, and metadata updates use the current public API. Incoming Kick chat is read from Kick's realtime WebSocket after resolving the channel's chatroom id. A stalled YouTube or Kick page fetch times out and retries instead of stopping chat for the rest of the stream. Activity alerts prefer StreamElements JWTs, with optional native backup from those same connections. Stay on the latest [release](https://github.com/Milzstream/OBS-Multi-Chat/releases/latest).
