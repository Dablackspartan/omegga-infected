# Infected / Zombies — Omegga

Round-based **Infected** for Brickadia. One random player starts infected; survivors convert on death; infected respawn. First infected gets a bonus until first blood. Mid-round joiners become infected.

## Install
1) Put this folder in `plugins/infected/`.
2) Put your real preset as `plugins/infected/data/infected.bp` (replace the placeholder).
3) Enable the plugin in Omegga.

## Create/bind
Run `!infected createminigame` (admin). The plugin will:
- **Detect** the real Minigame Presets folder by saving a probe preset.
- **Copy** `data/infected.bp` there (handles case variants).
- **Load** it by name and **bind** to it. If it already exists, we bind to it.

## Admin commands
- `!infected createminigame` – setup/bind.
- `!infected startround` / `!infected endround` – control the round.
- `!infected status` – quick state.
- `!infected bindminigame <index>` or `name <PresetName>` – manually bind if needed.

## Config (UI)
- **minigame-name** – leave blank to derive from `infected.bp` (recommended).
- **round-seconds** – default 300.
- **survivor-weapon**, **infected-knife**, **bonus-weapon** – blank = no-op.
- **team-color-enabled**, **green-tint-enabled**, **green-tint-amount** – visual cue for infected.
- **enable-sounds** and sound keys – optional local SFX.
- **mid-join-assign-infected** – auto-infect mid-round joiners.
- **start-on-create** – begin immediately after create/bind.

## Notes
- Works on hosts where preset paths differ; no manual paths required.
- If a command is missing on your Brickadia build, we no-op and log to console.
- Stats are stored under `infected_stats_v1`.
- `access.json` is a JSON string array: `[ "fs", "path" ]`.

## Troubleshooting
- “Could not create/load”: ensure `data/infected.bp` exists and check the console; we log the detected preset folder, copy steps, and load attempts.
