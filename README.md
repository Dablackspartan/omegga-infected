# Infected / Zombies (Omegga Plugin)

An **Infected** (Zombies) round gamemode scaffold for Brickadia using **Omegga** (Node VM).  
Focus: reliable flow + safe fallbacks + good logging.

> ⚠️ Some Brickadia builds expose different console/chat commands. This plugin **never hard fails** when a command is missing — it logs a warning and no-ops. Configure the placeholders in the plugin UI.

## Features

- **Admin commands**
  - `!infected createminigame` – best-effort minigame setup from a **blank template** you can replace later; optionally starts a round.
  - `!infected status` – quick status readout.
  - `!infected startround` / `!infected endround` – manual control for testing.
- **Core rules**
  - One random player starts infected. First infected gets a **temporary bonus** until the first survivor death.
  - If a **survivor dies**, they instantly become infected (and are respawned best‑effort).
  - **Infected respawn**; survivors do not (they convert instead).
  - Round ends when **all survivors are infected** or when the **timer** expires.
- **Roles & loadouts**
  - Survivors: one firearm (`survivor-weapon`).
  - Infected: knife + **one slot** (`infected-knife`, slot limit is best‑effort).
  - First infected gets a `bonus-weapon` (until first blood).
- **Visual**: optional green **team tint** for infected (best‑effort).
- **Audio**: optional local sounds on role changes.
- **Stats**: persistent store (per‑player best survival time, total survival, rounds played; optional kill counters).

## Install

1. Copy the folder to your server: `plugins/infected/`
2. Ensure these files exist:
   - `omegga.plugin.js`
   - `doc.json`
   - `plugin.json`
   - `access.json`
   - `data/blank-minigame.json` (auto-created on first run)
3. Start Omegga and configure the plugin in the Web UI.

### The blank minigame file

- A placeholder is created at: **`plugins/infected/data/blank-minigame.json`**.  
- Replace this with your own preset at any time. The config key `minigame-template` points to this file.

## Config (via Omegga UI)

- **authorized-users**: admins allowed to use admin-only commands.
- **round-seconds**: default 300 (5 min).
- **survivor-weapon**, **infected-knife**, **bonus-weapon**: item names. Leave blank to no-op.
- **team-color-enabled / green-tint-enabled / green-tint-amount**: visual indicator for zombies. Toggle and tune.
- **enable-sounds** + **sound-***: per-event sound asset refs (leave blank to no-op).
- **minigame-template**: obvious placeholder you can replace.
- **start-on-create**: auto-start when you run `!infected createminigame`.
- **enable-kill-tracking**: off by default; kill parsing is version-dependent.

## Commands

- `!infected createminigame` (admin)
- `!infected status`
- `!infected startround` (admin)
- `!infected endround` (admin)

## Notes & Limitations

- This plugin uses **best-effort** calls for loadouts, respawns, tint, and preset loading. If your server build doesn’t support a given command, it will **log a warning** and continue.
- Kill tracking requires a reliable killfeed or event — it’s disabled by default. You can integrate your own event hook and call `addKill(uuid, name, isZombieKill)` from another plugin.
- If your Omegga exposes native minigame APIs, the plugin will try to use them; otherwise it attempts `Chat.Command` fallbacks. Adjust those in the code for your environment if needed.

## Logging & Errors

- All risky operations are wrapped in `try/catch` and log via the Omegga console (`[infected]` prefix). The plugin should never crash Omegga.

## Development

- Node VM plugin. `access.json` allows reading/writing the `data/` folder for your preset file.
- Stats stored via the **plugin store** under the key `infected_stats_v1`.
- Main state machine runs at 2 Hz and uses `getAllPlayerPositions()` to detect death transitions.

Happy hunting.
