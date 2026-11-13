# Setup

[README](../README.md) · [Install](install.md) · [Docks](docks.md) · [Activity](activity.md) · [Alerts](alerts.md) · [Develop](develop.md)

Create an API application for each platform you connect. Use this callback URL in every provider dashboard:

```text
http://localhost:4173/oauth/callback
```

Click **Connect** for each platform in the Relay Chat Dock window. Each button opens a browser authorization window. After authorization, the callback stores the token and the backend begins polling or connecting to that platform.

The client secret stays in the backend environment file and is never sent to OBS. Never commit or share `.env` or `production.env`. Client secrets, JWTs, access tokens, and refresh tokens must remain on the backend and must not be placed in `VITE_` variables or the OBS Browser Source.

## Twitch

1. Visit https://dev.twitch.tv/console/apps.
2. Create a new application.
3. Set the OAuth redirect URL to the callback URL above.
4. Set the client type to **Confidential/Private**, copy the client ID, and generate a client secret.

The app requests email, IRC chat, EventSub chat read/write, broadcast metadata, moderation (so platform-reported bans and unbans update the dock), follower, subscription, and bits permissions. After updating the app, disconnect and reconnect Twitch so the new chat and alert scopes can be granted.

## Translation

Messages in another language can be translated to English for the dock. Script detection covers CJK (Chinese, Japanese, Korean), Cyrillic, Arabic, and Hebrew. Longer Latin-script lines are detected locally, so Spanish, French, German, and other languages are detected too without sending every line to the translator. Short lines are skipped because detection is unreliable there; right-click a chat line and choose Translate to force that one. The original message stays visible with an **EN** marker. Translation is on by default; turn it off with **Translate non-English chat to English** in the Relay Chat Dock window. Right-click Translate is hidden while that setting is off.

By default the translated text comes from Google's unofficial `translate.googleapis.com` endpoint (`client=gtx`), which needs no key. If you would rather not use the unofficial endpoint, set one of these in `production.env` and restart:

- `TRANSLATE_API_KEY` — uses Google Cloud Translation (the official API).
- `TRANSLATE_URL` — uses a LibreTranslate-compatible endpoint, with optional `TRANSLATE_API_KEY` for the service's key.

If translation fails, the Relay Chat Dock window shows why and messages stay in the original language. Translation is an outbound third-party request, so turn the setting off if that is not acceptable for your stream.

## YouTube

1. Visit https://console.cloud.google.com/.
2. Create or select a Google Cloud project.
3. Enable **YouTube Data API v3**.
4. Configure the OAuth consent screen.
5. Create an OAuth client as a **Web application**.
6. Add the callback URL above as an authorized redirect URI.
7. Copy the client ID and client secret.

The app requests YouTube read access and the live-chat scope needed to send and moderate chat. Google's consent screen describes that scope as permission to delete videos. This app never deletes or uploads videos. The only video edit is setting a broadcast or archive to **public** when you confirm the privacy prompt.

YouTube Data API v3 defaults to **10,000 units per day** (reset at midnight Pacific). This project is built to stay under that free-tier cap for a normal stream day, without requesting a quota increase. Higher limits exist only if Google approved a quota increase for that Cloud project. A quota increase isn't something you buy. Google has to approve it for your project.

The companion window links to the [Cloud Console quotas page](https://console.cloud.google.com/iam-admin/quotas?service=youtube.googleapis.com). To enter your current usage, open the **YouTube Data API v3** group and read the **Queries per day** row: **Current usage** (for example `35`) and **Value** (the daily limit, usually `10,000`). Ignore the **All quotas & system limits** card near the top of the page (for example `1,247`). That is a count of how many quota rows exist, not units you have used. Type `35` or `35/10000` in the window; you can type it while the app is running. After that, the app estimates forward from its own official API calls and warns near 80% and when the daily cap is reached. InnerTube site chat does not count against the quota.

Live chat and viewer counts use YouTube's public site/InnerTube reader, not a polling loop on `liveChatMessages.list`. The viewer number is concurrent viewers (`watching now` or `concurrentViewers`). A lifetime `viewCount` is not shown, and a page scrape does not mark YouTube live by itself. The official API is used sparingly: live-broadcast detection about every 15 seconds until the broadcast is live (same cadence as Twitch and Kick; `liveBroadcasts.list` is 1 unit), then about every 5 minutes while live so ending the stream is noticed without a status call four times a minute. A one-shot history seed runs when a new live chat appears, plus sending and deleting messages, and a slow official chat fallback only if InnerTube fails.

### Auto (live checks)

The **Auto** box beside **Check live** is on by default for Twitch, Kick, and YouTube. Uncheck it to skip that platform's automatic live-status polls. Chat that is already connected keeps updating. Going live or offline, and viewer counts from those polls, stay as last seen until you press **Check live**. **Check live** runs that official status check immediately without changing the automatic interval.

For YouTube, Auto off skips the official live-broadcast status call (the quota one) until **Check live**, including on launch. A restart with Auto off does not refresh the YouTube token, seed the saved live chat, or rediscover a YouTube live until then. InnerTube chat for a broadcast that is already connected keeps running.

If you run two separate live broadcasts at the same time — a normal 16:9 stream and a vertical Shorts stream — put `#shortsfeed` in the title of the vertical/Shorts broadcast only. The dock then labels that chat **Shorts** and the other chat **Live**, without spending extra API calls to guess which is which. If only one live broadcast is up, the labels stay hidden. If your single scheduled livestream already feeds both 16:9 and vertical viewers at once, this tag is not needed and may not be honored.

The app does not use `search.list`. YouTube subscribers come from StreamElements only. A backend restart reloads `data/chat.json` and skips another YouTube history API call when that live chat is already on disk.

If a YouTube broadcast is unlisted or private, the companion window and the chat dock each show that broadcast's title (`YouTube "Night stream" is unlisted.`). That can be intentional, or a leftover from reusing an unlisted stream. **Make public** sets only that video to public (a 50-unit `videos.update`, only when you confirm). **Dismiss** hides that video's warning until the app restarts; the next broadcast still warns. The post-stream check is a 1-unit `videos.list` about every 3 minutes for 30 minutes after the broadcast leaves the live list, so it does not add a poll while you are live.

Twitch and Kick end when OBS stops sending RTMP. A scheduled YouTube live stays up until you end it in Studio. When you create or edit that schedule in YouTube Studio, turn on **end the stream when the signal stops** (or the equivalent auto-stop option). This companion does not end YouTube broadcasts.

### YouTube quota

Leaving Auto on while YouTube is offline all day is about 5,800 units, so uncheck it if the app stays open and you are not about to go live. If the daily quota is exhausted, official calls pause until midnight Pacific and InnerTube chat continues. That pause is saved with the day's usage, so restarting the app the same Pacific day does not resume official calls.

## Kick

1. Create an application in the Kick developer portal: https://dev.kick.com/.
2. Set the OAuth redirect URL to the callback URL above.
3. Copy the client ID and client secret.

The app requests `channel:write` so it can update stream metadata.

Kick API access can vary by developer account and API version, so the backend accepts `KICK_API_BASE` for the current public API base URL. It defaults to `https://api.kick.com/public/v1`. Incoming Kick chat uses Kick's realtime WebSocket. Sending still uses the official chat API.

## production.env

For the packaged Windows executable, name the file `production.env`. Where it lives: [Install](install.md#where-your-settings-live).

```powershell
copy .env.example production.env
notepad production.env
```

```env
PORT=4173
OAUTH_REDIRECT_URI=http://localhost:4173/oauth/callback
# RELAY_BIND=127.0.0.1
# RELAY_WATCH_TOKEN=
# RELAY_API_TOKEN=
# RELAY_DATA_DIR=

TWITCH_CLIENT_ID=your_twitch_client_id
TWITCH_CLIENT_SECRET=your_twitch_client_secret

KICK_CLIENT_ID=your_kick_client_id
KICK_CLIENT_SECRET=your_kick_client_secret
# KICK_API_BASE=
# Optional if Edge/Chrome is installed in a non-standard location:
# Shared by the Kick chatroom-ID lookup and the YouTube InnerTube fallback:
# BROWSER_PATH=C:\\Path\\To\\msedge.exe
# (KICK_BROWSER_PATH still works as a deprecated alias for it)

YOUTUBE_CLIENT_ID=your_google_client_id
YOUTUBE_CLIENT_SECRET=your_google_client_secret

# StreamElements JWTs — one per linked platform
# Dashboard → avatar → switch to that platform → Show secrets
STREAMELEMENTS_JWT_TWITCH=
STREAMELEMENTS_JWT_KICK=
STREAMELEMENTS_JWT_YOUTUBE=
```

The docks, companion, and control API stay on this computer until Watch is turned on. Where `data/` lives: [Install](install.md#where-your-settings-live). On launch, new keys from `.env.example` are merged into `production.env` with an atomic replace, so a crash during that rewrite does not wipe existing secrets. A failed title save, a Kick status error, or a locked settings file is logged and the relay keeps running.

StreamElements JWTs can also be pasted in the companion window. How the activity dock uses them is in [Activity](activity.md).
