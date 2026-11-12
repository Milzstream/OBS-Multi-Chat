# Architecture

Relay Chat Dock is a local Node + Electron process plus OBS browser docks.

```text
OBS docks / companion / watch
        |  HTTP + SSE
        v
   server.ts (state)
        |-- twitch-live.ts     EventSub / IRC / Helix
        |-- kick-live.ts       Kick public API + KickChat
        |-- youtube-live.ts    Data API + YouTubeLiveChat (InnerTube)
        |-- streamelements.ts  activity socket
        v
   data/*.json  tokens, chat, activity, settings
```

The docks are static Vite pages served by the same Express app. They do not hold the source of truth. `state` in `server.ts` does. SSE pushes slices (`snapshot`, `chat`, `activity`, `presence`, `settings`).

A dock gets the whole chat history in a `snapshot`: on connect, then every 60 seconds as a safety net. In between, `chat` frames carry only added, updated, and removed rows (`chatSseFields` on the server, `applyChatFrame` in the dock). A missed frame, or a frame that does not fit the dock's rows, resyncs through `/api/state`. Pages that connect to `/events` without `?chat=delta` get the whole list per message, because an OBS dock keeps its old bundle across an app update.

The chat dock skips `setMessages` when a snapshot's `chatSliceStamp` matches, so the periodic snapshot does not rewrite the whole feed. The stamp includes avatar, color, badges, parts, and other in-place fields because Twitch and Kick backfill photos onto existing rows (#152).

Unified chat send creates one local row; platform echoes merge through `mergeIncomingChat` in `server/logic/chat-merge.ts`. Twitch send prefers Helix so the row gets a real message id; IRC is only a fallback and does not count as sent until that id is echoed.

User-facing setup lives under `docs/`: [install.md](install.md), [setup.md](setup.md), [docks.md](docks.md), [activity.md](activity.md), [alerts.md](alerts.md), and [develop.md](develop.md). The GitHub landing page is the repo README. Coding conventions live in `AGENTS.md`.
