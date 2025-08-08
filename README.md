# Infected / Zombies (Omegga Plugin)

- **Auto-bind**: on load, if a minigame named **"Infected"** (or the configured `minigame-name`) already exists, the plugin binds to it.
- **Robust create**: `!infected createminigame` tries multiple creation paths and verifies via `Server.Minigames.List`. If creation is blocked, bind via `!infected bindminigame <index>`.
- Mid-round joiners auto-assigned to Infected (toggle: `mid-join-assign-infected`).
- Survivors convert on death; infected respawn; first-infected bonus removed on first blood.
- Optional team tint and sounds; persistent stats via plugin store.
- Blank preset at `plugins/infected/data/blank-minigame.json` you can replace later.
