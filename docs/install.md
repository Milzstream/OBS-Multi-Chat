# Install

[README](../README.md) · [Setup](setup.md) · [Docks](docks.md) · [Activity](activity.md) · [Alerts](alerts.md) · [Develop](develop.md)

Use the latest [release](https://github.com/Milzstream/OBS-Multi-Chat/releases/latest). Twitch, Kick, and YouTube change their chat and APIs, and Relay tracks those changes in new builds. An older install is not guaranteed to keep working after a provider change.

## Installer

The installer is the recommended download: `obs-multi-chat-v*-windows-x64-setup.exe`.

1. Run the setup exe.
2. In the installer, leave **Add Relay Chat and Relay Activity as OBS custom browser docks** checked unless those docks already exist. In OBS, open **Docks** and turn on **Relay Chat** and **Relay Activity**. OBS lists installer-added docks but leaves them hidden until you enable them.
3. Optional: connect Twitch, Kick, YouTube, and StreamElements in the installer. Each page has a button to open that provider's site. Skip and edit the env file later if you prefer.
4. The finish page shows `%LOCALAPPDATA%\Relay Chat Dock\production.env`. The companion window shows that path on every launch.
5. Start **Relay Chat Dock** from the Start Menu.

The app installs under Program Files. Settings stay out of that folder. See [Where your settings live](#where-your-settings-live). On launch, missing keys from `.env.example` are appended to `production.env` without changing values you already set.

Installed copies can prompt to download the next setup exe, run it, and reopen. That Yes/No prompt does not freeze chat while it is open. The download starts only when the asset URL is a GitHub release host and the file matches the release `sha256` digest. An update replaces the program files and leaves the LocalAppData folder alone.

## Portable zip

1. Download `obs-multi-chat-v*-windows-x64.zip`.
2. Unzip it and fill in `production.env`.
3. Keep the unzipped folder together. `relay-chat-dock.exe` needs the files beside it.
4. Run `relay-chat-dock.exe`. Add the two dock URLs in OBS if you did not use the installer. See [Docks](docks.md).

A portable unzip does not start a second settings folder if you already installed once. See [Where your settings live](#where-your-settings-live).

## Where your settings live

The installer puts the app under Program Files. `production.env`, `data\`, and `logs\` stay in `%LOCALAPPDATA%\Relay Chat Dock`, so an update does not write next to the exe.

A portable zip uses `production.env` and `data\` beside the exe only when that machine has no LocalAppData profile yet. Install once, then run a portable copy, and the exe still uses `%LOCALAPPDATA%\Relay Chat Dock`.

Development runs keep those files under the project directory. `RELAY_DATA_DIR` overrides any of these.

## Companion window

Start **Relay Chat Dock** from the Start Menu. There is no console window. The window shows the launch log, Twitch / Kick / YouTube connect and disconnect, translate, StreamElements JWTs, and an optional YouTube quota field. Each connected platform has **Check live** and an **Auto** box beside it. Auto is on by default. Chat filters, activity filters, and stream controls stay in the OBS docks.

The log is also the place to check a quiet dock. Each live-status poll prints `Twitch check: offline` or `Kick check: live, 12 viewers`. An unchanged result repeats about once a minute, and **Check live** always prints. YouTube also prints a quota line on every official call, which is why that platform looks busier while Auto is on and you are offline. Uncheck Auto if the app will sit open and you are not about to go live. New chat is a count, not each message (`Twitch: 40 messages (EventSub)`). A poll that added nothing stays silent. Deletes, timeouts, bans, and unbans print the action, platform, and user, never the message text. A stored activity alert prints one line (`Twitch follow: Ada`). Duplicate alerts the deduper drops are not logged.

The same lines are appended to `logs\relay.log` next to `production.env` (installer: `%LOCALAPPDATA%\Relay Chat Dock\logs\relay.log`). A crash, a killed process, or closing the window leaves that file. At about 2 MB it rotates into `relay.log.bak`, so disk use stays around 4 MB. Access tokens, refresh tokens, client secrets, StreamElements JWTs, and the Watch view token are stripped before a line is written.

Closing the window stops the relay, so the docks go blank until you start it again. Start the app before opening OBS.

Account apps, translation, and `production.env` keys are in [Setup](setup.md).

## Readonly LAN watch link

Click **Watch** in the companion window to share chat and activity with a friend on the same Wi-Fi. Click it again to turn sharing off. Turning it on copies a link like `http://192.168.1.20:4173/watch?token=...`. Right-click **Watch on** to copy that link again. The choice is saved. Windows may ask to allow the app on private networks the first time the process listens on the LAN.

Bind and Watch are separate:

- Default bind (`127.0.0.1`, or unset `RELAY_BIND`): Watch on temporarily listens on `0.0.0.0`. Watch off closes the LAN listener again.
- `RELAY_BIND=0.0.0.0` or a LAN IP such as `192.168.1.20`: that socket stays bound. Watch only hosts or unhosts the `/watch` page. Tools with `RELAY_API_TOKEN` can still reach the LAN listener while Watch is off.

Until Watch is on (and bind is loopback), other devices cannot reach the chat dock, the activity dock, or the live update stream. `RELAY_LAN=1` starts with Watch already on; you can still turn it off from the window. The companion log prints the Watch URL without the view token; copy it from the button. The view token is created in `data/watch-token` and stays stable. Set `RELAY_WATCH_TOKEN` to choose it yourself. Do not reuse `RELAY_API_TOKEN`: if they match, the app keeps a different view token so the shared link cannot be turned into a write secret.

That page is chat and activity only. It has no composer, mod menu, settings, or stream controls. A username opens that profile in the friend's own browser. It does not call `/api/open`, so it cannot open a link on the streaming PC. Anyone on the Wi-Fi who does not have the link cannot read state or the live update stream.

A browser on another device still cannot send, moderate, disconnect, change settings, read StreamElements JWTs, start OAuth, or shut the app down. `RELAY_API_TOKEN` is only for a tool that sends it in `x-relay-token` or `Authorization: Bearer`. It is not accepted from the query string. Shutdown, the companion window, and the operator docks stay on this computer even with that token. OAuth from another device requires the header; the companion window does not, because it is on this computer.
