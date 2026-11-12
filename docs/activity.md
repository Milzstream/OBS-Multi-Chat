# Activity

[README](../README.md) · [Install](install.md) · [Setup](setup.md) · [Docks](docks.md) · [Alerts](alerts.md) · [Develop](develop.md)

StreamElements is the source of truth. Paste one JWT per linked platform in the Relay Chat Dock window, or in `production.env`. Copy each while switched to that channel in the SE dashboard (avatar → Show secrets). JWTs last weeks, not hours. Saving a JWT reconnects StreamElements without restarting the companion.

If a JWT is missing, the companion window and Activity dock warn you. Use **Ignore missing StreamElements JWT alerts** in the window if you only use some platforms. Dismissing the banner with × hides that warning for the current session. A later, different warning still shows. A page refresh brings dismissed warnings back unless ignore is checked.

The banner waits before it complains. StreamElements hydrates its JWTs over the network on start and after every saved JWT, and it cycles its own websocket, so those windows read as `Connecting…` in the Relay Chat Dock window and raise no alert. A websocket that is back and streaming inside 10 seconds never warns at all; only a longer outage does.

| Filter | What you see |
| --- | --- |
| Twitch / Kick / YouTube | Follows, subs, gifts, cheers, raids, Super Chats, memberships from that platform |
| SE | Donations, merch, and other non-platform StreamElements events |
| All | Everything |

The funnel next to the flask filters by kind (Follow, Sub/gift, Cheer/raid, Donation/merch, Super Chat/membership) without a second toolbar. Combine it with the platform icons. All kinds are on by default.

Gifted subs sit under the person who gifted them, slightly indented, so you see the gifter first. A gift row takes as many subs as it says it gifted, from within two minutes of it. A gifted sub with no gift row nearby, such as one sub gifted straight to one person, gets a gift row of its own built from the gifter's name. Turn off **Group gifted subs under the gifter** in the same funnel menu to list every row on its own instead; each gifted sub then says who gifted it. The choice is saved per dock. Gift rows show the tier chip too. Older gifted subs pick up their gifter from StreamElements on the next launch, as long as they are under 60 days old.

Newest alerts stay at the top; older rows drop down. Each row shows the platform logo first, then the event type. Left-click a row to open that user's Twitch viewer card, Kick profile, or YouTube channel page in the system browser (not inside the OBS dock). Both docks paint only the on-screen rows.

**Right-click a pill to delete it.** An X slides out from the right side. Click the X to remove that alert from the dock and from `activity.json`. Right-click again, or wait 5 seconds, and the X hides without deleting. Emulated alerts are saved like real ones, so this is how you clear a test. The watch page does not get this control.

**Drop alerts older than 30 days** is off by default so quieter streams keep a long history. Turn it on to automatically remove events older than 30 days.

**Use connected accounts as backup for StreamElements** is on by default. Turn it off if you do not want native Twitch, Kick, or YouTube events as a fallback. The same alert from the other feed is dropped when the user id matches, or when the login and display name are the same letters with different spacing or case (`Cool User` and `cooluser`). Follows, raids, and memberships still merge with older ones loaded at startup. Subs, gifts, cheers, and donations only collapse within two minutes, and only when the amount matches. The same feed sending again (two Twitch cheers, or two StreamElements cheers) is a second spend and stays as two rows. A YouTube member join is a membership. A YouTube subscriber is its own **SUBSCRIBER** alert, not a member.

A Twitch sub keeps its **SUBSCRIPTION** pill, and a second chip beside it shows the plan: **PRIME** in blue for a Prime Gaming sub, or **TIER 1**, **TIER 2**, or **TIER 3**. On-stream alerts show the chip too, except with Show Platform off. StreamElements sends the plan with the sub. With native backup on, Relay also reads Twitch's sub and resub chat notices, because the plain subscribe event never says Prime; when that notice arrives second, it upgrades the row instead of adding another.

Twitch Power-ups paid with Bits (Gigantify an Emote, Message Effects, On-Screen Celebrations) show in the Activity dock as Bits alerts labeled **GIGANTIFY**, **MESSAGE EFFECT**, or **CELEBRATION**. A custom Power-up the streamer made shows as **POWER-UP** with its title, and so does any new built-in Power-up Twitch adds later. A Power-up never fires a normal cheer, so Relay reads them from Twitch directly, even when native backup is off. They stay in the dock and in chat (gigantified emotes). The on-stream alert page skips them: Gigantify and message effects already play in chat, and they are not a StreamElements-style alert box. Cheer on the overlay is a real Bits cheer.

On launch, Relay also loads the last 14 days of StreamElements activity, so an alert that arrived while the app was closed still shows up, and a sub stored earlier without its plan picks up Prime or its tier. For subs and gifts up to 60 days old it only fills in a missing plan or gifter on rows already in the feed; it never adds those older rows back, so an alert you deleted stays deleted.

Hiding or skipping an event in the StreamElements dashboard does not remove it here. SE does not publish a hide or delete activity event over the websocket this app uses.

The flask fires a StreamElements mock activity, the same call the overlay editor makes when Preview LIVE on stream is checked. The row shows up when that event comes back on the activities socket, and it is saved like any other alert. A replay of an alert already in history is dropped, because StreamElements reuses the activity id.

## History

Activity history is stored locally in `data/activity.json` (last 5000 real events by default, or 30 days if that setting is on). Chat history is stored locally in `data/chat.json`. Think of `data/chat.json` as a crash buffer: it lets a backend restart or an OBS refresh reload the last messages so the dock never comes back empty mid-stream. It is not a full archive or a VOD. Messages that arrived while the backend was down are never backfilled.

The chat buffer holds the last 5000 messages by default. Set `RELAY_CHAT_MAX` in `production.env` to a value from 100 to 1,000,000 to keep more or fewer. Activity uses the same range via `RELAY_ACTIVITY_MAX`. Memory and the size of `chat.json` and `activity.json` both scale with that number, so a high-volume stream might set 50,000 while a small one can lower it. Where those files live: [Install](install.md#where-your-settings-live).

Token, settings, chat, and activity files are written atomically with a `.bak` fallback so a crash during save does not wipe credentials or history. Restarting the backend reloads both files, so the docks are not empty. Past messages from while the backend was down do not appear: Twitch and Kick have no cheap replay, and YouTube live-chat history is skipped when this live chat is already on disk so a restart does not spend extra quota filling the gap.

## Testing alerts

1. Open the Activity dock and click the flask icon. That posts a StreamElements emulate (`POST /activities/{channel}/mock`) for the platform's JWT. The live overlay plays it, and the dock shows the row when the activities socket delivers it. This needs the matching StreamElements JWT.
2. Overlay **Emulate** with **Preview LIVE on stream** checked is the same call. Without that box, Emulate stays in the editor tab and this dock does not see it. Replaying an activity already in the feed is dropped here, because the id does not change.
3. Native backup (if the settings checkbox is on): reconnect Twitch so follow, sub, and bits EventSub is granted, then follow from an alt. Kick follows and subs appear on the public chat socket. YouTube Super Chats and memberships appear in live chat. YouTube subscribers are StreamElements-only.

On-stream playback is in [Alerts](alerts.md).
