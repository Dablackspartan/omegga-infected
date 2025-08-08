# Infected / Zombies — Omegga

- Auto-detects preset **in /plugins/infected/data/** (case-insensitive).
- Copies the preset to **multiple** common Minigame Presets folders (covers most hosts).
- Tries to load by the **exact name** reported by `Server.Minigames.ListPresets` if available.
- Falls back to creating a simple minigame if load fails.
- Logs to the raw server console.

## Install
1) Put this folder in `plugins/infected/`.
2) Place your preset in `plugins/infected/data/` (e.g., `Infected.bp` or `infected.bp`).

## Use
- `!infected createminigame` — import + load + bind (or create as fallback).
- `!infected startround` / `!infected endround` — control the round.
- `!infected status` — quick state.
- `!infected bindminigame <index>` or `name <PresetName>` — manual bind if needed.

If it fails, paste the console output that lists: copied paths, `ListPresets` names, and `LoadPreset` attempts.
