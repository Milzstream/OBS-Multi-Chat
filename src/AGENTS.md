# Frontend (Vite + React)

`main.tsx` picks a view from `dock-view.ts`:

| Path | App |
|---|---|
| `/` | `chat/App.tsx` |
| `/activity` | `activity/ActivityApp.tsx` |
| `/alerts` | `alerts/AlertsApp.tsx` (pill, or a custom look from `server/logic/alert-looks.ts`) |
| `/console` | `ConsoleApp.tsx` |
| `/watch` | `WatchApp.tsx` |

Chat, activity, and watch subscribe through `sse.ts`. Local filter/compact prefs are `dock-prefs.ts`. Shared `ChatMessage` / `Platform` / `Account` types come from `server/types.ts` (type-only on the client).

`src/App.tsx` re-exports `chat/App.tsx`. Split pieces:

| File | Owns |
|---|---|
| `chat/App.tsx` | SSE, composer, filter, feed shell |
| `chat/MessageItem.tsx` | row, avatar, badges, emotes |
| `chat/ModMenu.tsx` | delete / timeout / ban prompt |
| `chat/StreamControls.tsx` | title, category, tags |
| `chat/platform.tsx` | icon + color |
| `chat/types.ts` | dock-only aliases over `server/types.ts` |

Dock-only helpers (avatar proxy URLs, category combobox, mod menu labels) stay in `chat-helpers.ts`.

`sse.ts` `chatSliceStamp` is the cheap skip for chat frames. It must hash avatar, color, badges, parts, and other in-place fields the row renders. Leave avatar out of the stamp and letter fallbacks stick until an OBS refresh (#152).
