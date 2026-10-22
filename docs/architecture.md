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

Unified chat send creates one local row; platform echoes merge through `mergeIncomingChat` in `server/logic/chat-merge.ts`.

User-facing setup (OAuth apps, YouTube quota, Watch LAN, installer) lives in the README. Coding conventions live in `AGENTS.md`.
