# Infected / Zombies — Omegga

Round-based **Infected** for Brickadia. One random player starts infected; survivors convert on death; infected respawn. First infected gets a bonus until first blood. Mid-round joiners become infected.

## Install
1) Put this folder in `plugins/infected/`.
2) Put your real preset in `plugins/infected/data/` as **infected.bp** or **Infected.bp** (any `.bp` works; we auto-detect).

## Create/bind
Run `!infected createminigame` (admin). The plugin will:
- Detect the real Minigame Presets folder by saving a probe preset.
- Copy your `.bp` from `/data` (case-insensitive).
- Load it by name and bind. If it already exists, we bind to it.

## Admin commands
- `!infected createminigame` – setup/bind.
- `!infected startround` / `!infected endround` – control the round.
- `!infected status` – quick state.
- `!infected bindminigame <index>` or `name <PresetName>` – manual bind if needed.

## Config (UI)
- **minigame-name** – leave blank to derive from the preset filename.
- **round-seconds** – default 300.
- Weapons: **survivor-weapon**, **infected-knife**, **bonus-weapon** (blank = no-op).
- Visuals: **team-color-enabled**, **green-tint-enabled**, **green-tint-amount**.
- Sounds: **enable-sounds** and the 3 sound fields.
- QoL: **mid-join-assign-infected**, **start-on-create**.

## Notes
- Logs print to the **raw server console** (and Omegga console if available).
- Works across hosts where preset paths differ; no manual paths required.
- Stats stored under `infected_stats_v1`.
- `access.json` is `[ "fs", "path" ]`.

## Troubleshooting
- “Could not create/load”: ensure a `.bp` exists in `/data`. The server console will show the detected preset folder, copy steps, and load attempts.
