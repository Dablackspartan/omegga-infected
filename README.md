# Infected / Zombies (Omegga Plugin)

**New**: Preset import. Ship a `data/Infected.bp` with the plugin, and the plugin can copy it into your server's
Minigame Presets folder, load it by name, and bind automatically.

## Quick Setup
1. Drop this folder into `plugins/infected/`.
2. In the plugin UI:
   - Add yourself to **authorized-users**.
   - Set **minigame-name** (default `Infected`).
   - (Optional) Put your `.bp` in `plugins/infected/data/Infected.bp` or change **preset-source**.
   - Set **preset-target-dir** to your server's **Minigame Presets** folder (required for import):
     - Windows: `%LOCALAPPDATA%/Brickadia/Saved/Presets/Minigames`
     - Linux (launcher): `~/.local/share/Brickadia/Saved/Presets/Minigames`
3. Run `!infected createminigame` (admin). The plugin will:
   - bind to an existing minigame named `Infected`, or
   - import+load your `.bp` preset (if enabled and configured), or
   - try multiple creation paths and verify.
4. Start a round with `!infected startround`.

## Commands
- `!infected createminigame` – create/setup or import+load and bind (admin).
- `!infected importpreset` – manual import+load (admin).
- `!infected bindminigame <index>` / `!infected bindminigame name <PresetName>` – bind controls (admin).
- `!infected status` – show info.
- `!infected startround` / `!infected endround` – runtime control (admin).

## Notes
- Mid-round joiners are auto-infected (toggle in UI).
- Survivors convert on death; infected respawn; first infected gets a temporary bonus until first blood.
- Team tint and sounds are best-effort (no-op on builds that don't expose those commands).
- Persistent stats are stored via the plugin store under key `infected_stats_v1`.
- `access.json` must be a string array (e.g., `[ "fs", "path" ]`). Whitespace is fine; keep the strings exact.

If the list parser doesn't see your minigames, run `!infected debuglist` and check console output, then open an issue with the dump.
