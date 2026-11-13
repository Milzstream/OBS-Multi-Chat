Windows x64 build of Relay Chat Dock.

**Installer (recommended):** run `obs-multi-chat-v*-windows-x64-setup.exe`. The app window goes in Program Files. Closing that window stops the OBS docks. Fill in `%LOCALAPPDATA%\Relay Chat Dock\production.env`. The installer can add the two OBS docks if those URLs are not already present.

**Portable:** unzip the archive, fill in `production.env`, and run `relay-chat-dock.exe`. Keep the whole folder together.

Dock URLs:
- Chat      `http://127.0.0.1:4173/`
- Activity  `http://127.0.0.1:4173/activity`

Installed copies can prompt to install the next release. `production.env` and `data\` are kept.

Do not commit or share `production.env` or the `data` folder.
