# Server

`server.ts` is the process: env, listen, companion window, and the in-memory `state` the docks render. HTTP handlers live in `http-routes.ts`. Pure parsers live in `logic/` (imported through `logic.ts`).

## Start here

| Task | Files |
|---|---|
| Kick echo merge / unified send | `logic/chat-merge.ts`, `kick-chat.ts`, POST `/api/messages` in `http-routes.ts` |
| YouTube quota / official API | `logic/youtube-quota.ts`, `youtube-live.ts` |
| YouTube InnerTube | `youtube-chat.ts` |
| Twitch EventSub / IRC | `twitch-live.ts`, `logic/twitch-irc.ts` |
| Stream title / tags | `logic/stream-info.ts`, stream-info routes |
| OAuth / tokens | `oauth.ts`, `oauth-state.ts` |
| SSE fan-out | `logic/sse.ts` plus `broadcast` in `server.ts` |

`logic.ts` is a re-export barrel. Prefer importing from it in tests (`../server/logic.js`) so moves inside `logic/` stay local.
