# Infected / Zombies — Omegga

Round-based **Infected** for Brickadia. One random player starts infected; survivors convert on death; infected respawn. First infected gets a bonus until the first survivor dies. Mid‑round joiners become infected.

## Install
1) Put this folder in `plugins/infected/`.
2) Restart or enable the plugin in Omegga.

## Preset (auto)
- Ship your preset as `plugins/infected/data/infected.bp` (replace the placeholder).
- `!infected createminigame` will:
  - copy that file into the server’s **Minigame Presets** directory (path is auto‑detected),
  - load it by name (name = file name without `.bp`, or the `minigame-name` you set),
  - bind the plugin to it.
- If a minigame with that name already exists, we just bind to it.

## Admin commands
- `!infected createminigame` – setup/bind.
- `!infected startround` / `!infected endround` – control the round.
- `!infected status` – quick state.
- `!infected bindminigame <index>` or `name <PresetName>` – point the plugin at an existing minigame (fallback).

## Config (UI)
- **minigame-name** – leave blank to derive from `infected.bp` (recommended).
- **round-seconds** – default 300.
- **survivor-weapon**, **infected-knife**, **bonus-weapon** – blank = no‑op.
- **team-color-enabled**, **green-tint-enabled**, **green-tint-amount** – visual cue for infected.
- **enable-sounds** and sound keys – optional local SFX.
- **mid-join-assign-infected** – auto‑infect mid‑round joiners.
- **start-on-create** – begin immediately after create/bind.

## Notes
- All commands are best‑effort. If your build lacks a command, we no‑op and log the error.
- Stats (best survival, etc.) persist in the plugin store under `infected_stats_v1`.
- `access.json` must be a JSON string array; this plugin ships with `[ "fs", "path" ]`.

## Troubleshooting
- `!infected createminigame` says it failed:
  - Make sure `plugins/infected/data/infected.bp` exists (not the placeholder).
  - Check console logs; we print which path failed and the directories we tried.
- Nothing shows in the preset list:
  - We copy to several common locations and create the folders if needed. If your host is unusual, bind by name (`!infected bindminigame name Infected`) once and you’re set.

Have feedback? Open an issue on your repo and paste any console errors.
