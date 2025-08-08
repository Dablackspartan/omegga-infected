
# infected (JSON preset version)

This variant reads a JSON minigame template from `infected/data/Infected.json`,
copies it into Brickadia's `Saved/Presets/Minigames/` as `<Name>.bp`, then runs
`Server.Minigames.LoadPreset "<Name>"` to create the minigame.

**Command**
- `!infected createminigame`

**Config**
- `minigame-template`: relative path to the JSON template (default: `data/Infected.json`)
- `minigame-name`: name for the minigame/preset (default: `Infected`)
