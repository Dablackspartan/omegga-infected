# Infected / Zombies (Omegga)

Lightweight infected (zombies) round gamemode for Brickadia using Omegga (Node VM). Focuses on reliable flow, safe fallbacks, and useful logs.

**Preset**  
Put your preset at: `plugins/infected/data/Infected.bp`.  
`!infected createminigame` will import it automatically and bind the plugin to the created minigame. If it can’t load the preset, it falls back to creating a blank minigame named **Infected**.

**Defaults**
- Round length: 5 minutes (change in UI).
- Survivors get one firearm. Infected get a knife and 1 slot. First infected gets a temporary bonus weapon until first survivor death.
- New joiners mid‑round are assigned to the infected team.
- Optional green team tint and local sounds.

**Admin Commands**
- `!infected createminigame` – Import preset and bind to it (no extra config needed).
- `!infected status` – Show current binding and round status.
- `!infected startround` / `!infected endround` – Manual testing control.

**Config (UI)**
- `authorized-users` (list)
- `round-seconds`, `survivor-weapon`, `infected-knife`, `bonus-weapon`
- `team-color-enabled`, `green-tint-enabled`, `green-tint-amount`
- `enable-sounds`, `sound-*`
- `minigame-template` (leave default)
- `start-on-create`, `enable-kill-tracking`

**Why preset import might fail**
- Server build may not expose `Server.Minigames.LoadPreset` in the console.
- Preset name inside the `.bp` may not be “Infected” (the game loads by internal name, not filename).
- Hosts place presets under different roots.

**What the plugin does about it**
- Copies `Infected.bp` into *both* common preset paths (and creates folders):  
  - `./Saved/Presets/Minigames/`  
  - `./Brickadia/Saved/Presets/Minigames/`
- Tries multiple load syntaxes and both `Infected` and `infected` names, plus filename fallback.
- Diffs minigame list **before vs after** to detect what actually got created and binds to it.
- If loading still fails, it creates a blank minigame via Omegga’s API and binds to that.

**Stats**
- Stored in plugin store (`infected_stats_v1`). Includes time survived and round counts. Kill tracking is opt‑in.

**Errors & Logs**
- Everything is wrapped in try/catch. Errors are printed to the server console with an `[infected]` prefix.

---

Drop your questions or issues in GitHub Issues.
