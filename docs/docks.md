# Docks

[README](../README.md) · [Install](install.md) · [Setup](setup.md) · [Activity](activity.md) · [Alerts](alerts.md) · [Develop](develop.md)

The companion window shows both URLs on launch:

```text
http://localhost:4173
http://localhost:4173/activity
```

Add both as **Docks → Custom Browser Docks**, or let the installer register them and then check **Relay Chat** and **Relay Activity** under **Docks**. Chat is for messages and sending. Activity is the alert feed. See [Activity](activity.md).

## Chat

Twitch, Kick, and YouTube profile photos load through the local media proxy. A new chatter's photo fills in a moment after the line appears; you do not need to refresh the dock. Deleting a line you sent from the dock uses the platform message id from that send (or from the echo), so the message is removed in channel chat and not only struck through in the dock. A Twitch send that Twitch does not accept is removed from the dock instead of staying as a line Delete cannot remove. Saying the same thing twice within a few seconds stays as two lines.

7TV, BetterTTV, and FrankerFaceZ emotes show as images, from your channel's sets and each service's global set. Twitch gets all three. Kick gets 7TV (channel and global). YouTube gets 7TV global emotes; 7TV does not have YouTube channel connections. A word becomes an emote only when it matches the emote name exactly, the same way the browser extensions work. The sets load in the background when a platform connects and refresh every 30 minutes, so the first few lines after a connect can still show the plain word. Your own messages from the dock pick up these emotes when Twitch, Kick, or YouTube echo them back. The requests only send your public channel id to 7TV, BetterTTV, and FrankerFaceZ.

A line that names one of your connected accounts, with or without `@`, is highlighted with an orange edge. Add other words (a mod's name, `giveaway`) under **Highlight words** in the Relay Chat Dock window, separated by commas. Matching ignores case and only counts whole words, and your own lines are never highlighted. A Twitch Gigantify an Emote Power-up draws that emote large on its own line, the way Twitch chat shows it.

Click a chat username to open that person's Twitch viewer card for your channel, Kick profile, or YouTube channel page in the system browser. The viewer card needs your connected Twitch login in the path (`/popout/<you>/viewercard/<them>`). YouTube's community tab is often disabled, so that click opens the channel instead.

## Stream controls

Stream Controls (gamepad on the chat dock) sets one title, one category search, and one tag list for Twitch and Kick. Category search queries both platforms and merges matching names; platform-only hits show a Twitch or Kick icon and say which platform was not changed. A typed category is saved when it matches a listed game. Kick needs that listed id; if it does not have one, the save says the Kick category was not updated instead of looking successful. **Twitch / Kick separately** expands to two category fields when the games differ. Tags share one chip field (max 10). Toggle Twitch / Kick next to the field before adding a chip. Dots on each chip show who gets it.

**Open YouTube Studio** (next to the Twitch + Kick badge) opens the livestreaming dashboard for scheduling. Click a platform tile to open that platform's live dashboard (Twitch Stream Manager, Kick stream dashboard, or YouTube Studio). Hover a tile to see that platform's stream title. If YouTube has more than one live broadcast, the hover lists each title. The stream title opens YouTube Studio. The link uses the connected channel when Relay has that channel id.

## Moderation

Right-click a chat row to delete that message, or timeout or ban the chatter on that platform. Twitch asks for an optional reason (up to 500 characters) before a ban or timeout. Kick accepts up to 100 characters; a longer reason is shortened for Kick only. Leave it blank to send no reason. YouTube live chat bans have no reason field. The dock asks you to confirm right there in the row, with no pop-up window. Cancel does not ban. A successful ban or timeout shows the reason on the dock status line when one was sent (`Banned Ada: spam`).

A ban or timeout strikes through every message from that chatter in the Relay chat (the same strikethrough Kick and YouTube show). Right-click a struck-through ban or timeout and choose **Unban / untimeout** to restore those messages. A deleted message stays struck through; unban does not bring it back. A delete reported by Twitch, Kick, or YouTube strikes through just that one message. If Twitch, Kick, or YouTube report a ban, timeout, unban, or delete themselves, the same line-out or restore runs automatically. YouTube unban from Relay only works for bans and timeouts that were issued from this dock, because YouTube's API needs that ban id. Those ids are kept in the data folder, so a restart can still unban.
