# Relay Chat Dock

A responsive OBS Browser Source that combines Twitch, Kick, and YouTube live chat into one dock. It starts offline and empty, then shows live accounts, viewer totals, messages, emotes, and a multi-platform composer after the companion backend connects.

## What is included

- Responsive OBS dock with platform filters and compact mode
- OAuth callback server for Twitch, Kick, and YouTube
- Server-side token persistence in the local `data/tokens.json` file
- Twitch live detection, viewer count, IRC chat reading, message sending, and title/category updates
- YouTube live detection, viewer count, and live-chat polling
- SSE updates from the backend to the browser source
- Unified Twitch + Kick stream title/category controls
- Windows background executable packaging

## API setup

You need to create an API application for each platform. Use this callback URL in every provider dashboard:

```text
http://localhost:4173/oauth/callback
```

### Twitch

1. Visit https://dev.twitch.tv/console/apps.
2. Create a new application.
3. Set the OAuth redirect URL to the callback URL above.
4. Copy the client ID and generate a client secret.

The app requests email, chat read/write, and broadcast metadata permissions.

### Google / YouTube

1. Visit https://console.cloud.google.com/.
2. Create or select a Google Cloud project.
3. Enable **YouTube Data API v3**.
4. Configure the OAuth consent screen.
5. Create an OAuth client as a **Web application**.
6. Add the callback URL above as an authorized redirect URI.
7. Copy the client ID and client secret.

The app requests YouTube read access and YouTube live metadata/chat access.

### Kick

1. Create an application in the Kick developer portal: https://dev.kick.com/.
2. Set the OAuth redirect URL to the callback URL above.
3. Copy the client ID and client secret.
4. Confirm that your account has access to the current Kick chat and channel API endpoints.

Kick API access can vary by developer account and API version, so the backend accepts `KICK_API_BASE` for the current public API base URL.

## Configure the backend

Create the environment file from the included template:

```powershell
copy .env.example .env
notepad .env
```

Fill in the values:

```env
PORT=4173
OAUTH_REDIRECT_URI=http://localhost:4173/oauth/callback

TWITCH_CLIENT_ID=your_twitch_client_id
TWITCH_CLIENT_SECRET=your_twitch_client_secret

KICK_CLIENT_ID=your_kick_client_id
KICK_CLIENT_SECRET=your_kick_client_secret
KICK_API_BASE=

YOUTUBE_CLIENT_ID=your_google_client_id
YOUTUBE_CLIENT_SECRET=your_google_client_secret
```

Never commit or share `.env`. Client secrets, access tokens, and refresh tokens must remain on the backend and must not be placed in `VITE_` variables or the OBS Browser Source.

## Run with Node

```powershell
npm install
npm run build
npm start
```

The backend serves the completed dock at:

```text
http://localhost:4173
```

Add that URL to OBS as a **Browser Source**. Keep `npm start` running while OBS is open. For frontend development, use `npm run dev` and run `npm run dev:backend` in a second terminal.

Click **Connect** for each platform in the dock. Each button opens a browser authorization window. After authorization, the callback stores the token and the backend begins polling or connecting to the platform.

## Run as a Windows background app

Build the executable:

```powershell
npm run package:win
```

This creates `relay-chat-dock.exe` using the Node 18 Windows x64 runtime supported by the packaging tool. Keep `.env` beside the executable, then run:

```powershell
.\relay-chat-dock.exe
```

The executable serves the dock at `http://localhost:4173`. Start it before opening OBS.

## Backend endpoints

- `GET /api/state` - current accounts, stream info, and recent messages
- `GET /events` - Server-Sent Events stream for dock updates
- `POST /api/messages` - send a message to selected platforms
- `POST /api/stream-info` - apply the unified title/category to Twitch and Kick
- `POST /api/disconnect/:platform` - remove a saved platform connection
- `GET /oauth/:platform` - begin OAuth for `twitch`, `kick`, or `youtube`
- `GET /oauth/callback` - exchange the provider authorization code server-side

## Current platform status

Twitch has the most complete adapter: live detection, viewer counts, IRC chat reading, sending, and metadata updates are implemented. YouTube OAuth, live detection, viewer counts, and chat polling are implemented. Kick OAuth and the adapter hooks are included, but its chat, viewer, and metadata requests require the current Kick API base URL and the corresponding developer permissions.
