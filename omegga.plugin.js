
const fs = require('fs');
const path = require('path');

class Plugin {
  constructor(omegga, config, store) {
    this.omegga = omegga;
    this.config = config;
    this.store = store;
  }

  async init() {
    // Chat command: !infected createminigame
    this.omegga.on('cmd:infected', async (speaker, subcmd, ...rest) => {
      if ((subcmd || '').toLowerCase() === 'createminigame') {
        try {
          const msg = await this.createMinigameFromJson();
          this.omegga.broadcast(`<b>Infected</> >> ${msg}`);
        } catch (e) {
          this.omegga.error(e?.stack || e?.message || String(e));
          this.omegga.broadcast(`<b>Infected</> >> failed: ${e?.message || e}`);
        }
      }
    });

    return { registeredCommands: ['infected'] };
  }

  // Try a few likely preset directories; write to every one that exists or can be created.
  resolvePresetDirs() {
    const cwd = process.cwd();
    const dirs = [
      path.resolve(cwd, 'Brickadia/Saved/Presets/Minigames'),
      path.resolve(cwd, 'Saved/Presets/Minigames'),
      '/home/container/Brickadia/Saved/Presets/Minigames',
      '/home/container/Saved/Presets/Minigames',
    ];
    // De-duplicate
    return Array.from(new Set(dirs));
  }

  copyTemplateToPreset(name) {
    const rel = this.config['minigame-template'] || 'data/Infected.json';
    const templatePath = path.resolve(__dirname, rel);
    if (!fs.existsSync(templatePath)) {
      throw new Error(`template not found: ${rel} (resolved ${templatePath})`);
    }
    const raw = fs.readFileSync(templatePath, 'utf-8');
    let json;
    try { json = JSON.parse(raw); } catch {
      throw new Error(`template is not valid JSON: ${rel}`);
    }
    // Force ruleset name inside the JSON to match what we'll load by
    const desiredName = name || 'Infected';
    if (json?.data?.rulesetSettings) {
      json.data.rulesetSettings.rulesetName = desiredName;
    }
    const payload = JSON.stringify(json, null, 2);

    const written = [];
    for (const dir of this.resolvePresetDirs()) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const dst = path.join(dir, `${desiredName}.bp`); // Brickadia scans .bp extension
        fs.writeFileSync(dst, payload, 'utf-8');
        written.push(dst);
      } catch (e) {
        // Skip paths we can't write
      }
    }
    if (written.length === 0) throw new Error('could not write preset to any known Presets/Minigames folder');
    return { name: desiredName, written };
  }

  async createMinigameFromJson() {
    const name = this.config['minigame-name'] || 'Infected';
    const { written } = this.copyTemplateToPreset(name);

    // Use official server command added in Alpha 5 Patch 6:
    // Server.Minigames.LoadPreset <Name>
    this.omegga.writeln(`Server.Minigames.LoadPreset "${name}"`);

    // Give the server a moment to spawn it, then verify
    await new Promise(r => setTimeout(r, 500));
    const minis = await this.omegga.getMinigames().catch(() => []);
    const ok = Array.isArray(minis) && minis.some(m =>
      m?.name === name || m?.rulesetName === name || m?.minigameName === name
    );

    if (!ok) {
      throw new Error(`preset load verification failed for name: ${name}`);
    }

    return `copied template to ${written.length} path(s) and created minigame "${name}"`;
  }

  async stop() {}
}

module.exports = Plugin;
