<p align="center">
  <img src="assets/app-icon.png" width="88" alt="Relay Chat Dock">
</p>

<h1 align="center">Relay Chat Dock</h1>

---

<p align="center">A local OBS companion with three pieces: a unified chat dock, a unified activity dock, and an alerts browser source you can customize.</p>

<p align="center">
  <img alt="Windows" src="https://img.shields.io/badge/platform-Windows-0078D4?style=for-the-badge">
  <a href="https://github.com/Milzstream/OBS-Multi-Chat/releases/latest"><img alt="latest release" src="https://img.shields.io/github/v/release/Milzstream/OBS-Multi-Chat?style=for-the-badge&label=release&color=orange"></a>
  <a href="LICENSE"><img alt="license: MIT with Commons Clause" src="https://img.shields.io/badge/license-MIT%20with%20Commons%20Clause-blue?style=for-the-badge"></a>
  <a href="https://github.com/Milzstream/OBS-Multi-Chat/actions/workflows/build.yml"><img alt="build" src="https://img.shields.io/github/actions/workflow/status/Milzstream/OBS-Multi-Chat/build.yml?style=for-the-badge&label=build"></a>
</p>

<p align="center">
  <img src="docs/screenshots/obs.png" width="760" alt="OBS with Relay Chat and Relay Activity docks">
</p>

<p align="center">
  <img src="docs/screenshots/activity.png" height="300" alt="Activity dock with follows, donations, and platform icons">
  <img src="docs/screenshots/stream-controls.png" height="300" alt="Stream controls for a shared Twitch and Kick title, category, and tags">
</p>

<p align="center">
  <img src="docs/screenshots/screenshot.png" height="420" alt="Chat dock combining Twitch, Kick, and YouTube">
</p>

<p align="center">
  <img src="docs/screenshots/AlertsCustomization.png" width="760" alt="Editor for the on-stream alerts browser source">
</p>

## Features

- One OBS chat dock for Twitch, Kick, and YouTube, with filters, emotes, highlights, and moderation
- Activity dock for follows, subs, gifts, cheers, raids, Super Chats, memberships, merch, and donations
- On-stream alerts, with a look editor in the companion window
- Shared Twitch and Kick title, category, and tag controls
- Optional English translation of non-English chat
- Readonly LAN watch link from the companion window

## Download

The latest Windows build is on the [Releases](https://github.com/Milzstream/OBS-Multi-Chat/releases/latest) page. Use the installer. A portable zip is on the same release.

Install steps, where `production.env` and `data\` live, and why an older build is not guaranteed after a provider change: [Install](docs/install.md).

## Docs

- [Install](docs/install.md) — installer, portable zip, data folder, updates, and the LAN watch link
- [Setup](docs/setup.md) — Twitch, Kick, YouTube, translation, and `production.env`
- [Docks](docs/docks.md) — chat, stream controls, emotes, highlights, and moderation
- [Activity](docs/activity.md) — the activity dock and how to test alerts
- [Alerts](docs/alerts.md) — on-stream alerts and the look editor
- [Develop](docs/develop.md) — run from source, package, and backend endpoints

## License

Source-available under the MIT License with the [Commons Clause](https://commonsclause.com/). You may use it on your own stream, including a monetized one. You may not sell it or offer it as a paid product or hosted service. See [LICENSE](LICENSE).

## For contributors

Operator setup is in the docs above. The coding map is [AGENTS.md](AGENTS.md). A short process sketch is [docs/architecture.md](docs/architecture.md).
