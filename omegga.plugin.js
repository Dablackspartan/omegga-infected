const fs = require('fs');
const path = require('path');

const TARGET_DIR = '/home/container/data/Saved/Presets/Minigame';
const SOURCE_FILE = path.join(__dirname, 'data', 'Infected.json');

module.exports = class Plugin {
  constructor(omegga, config, store) {
    this.omegga = omegga;
    this.config = config;
    this.store = store;

    this.onCmd = this.onCmd.bind(this);
  }

  async init() {
    // register !infected command
    this.omegga.on('chatcmd:infected', this.onCmd);
    this.omegga.log('[Infected] plugin init OK');
    return {};
  }

  async stop() {
    // remove listener on stop (important for unsafe plugins, still good practice here)
    this.omegga.off && this.omegga.off('chatcmd:infected', this.onCmd);
  }

  async onCmd(name, sub, ...args) {
    const say = (m)=>this.omegga.broadcast(`"[Infected] ${m}"`);

    sub = (sub||'').toLowerCase().trim();
    if (!sub || sub === 'help') {
      this.omegga.whisper(name, 'usage: !infected createminigame');
      return;
    }

    if (sub === 'createminigame') {
      // 1) Copy preset into Brickadia preset folder
      try {
        await fs.promises.mkdir(TARGET_DIR, {recursive: true});

        const dstUpper = path.join(TARGET_DIR, 'Infected.json');
        const dstLower = path.join(TARGET_DIR, 'infected.json');

        await fs.promises.copyFile(SOURCE_FILE, dstUpper);
        say(`copied preset -> ${dstUpper}`);

        // also copy lower-case to accommodate UI differences
        await fs.promises.copyFile(SOURCE_FILE, dstLower);
        say(`copied preset -> ${dstLower}`);
      } catch (e) {
        this.omegga.warn('[Infected] copy failed', e && e.message);
        this.omegga.whisper(name, `copy failed: ${e && e.message}`);
        return;
      }

      // 2) Verify the preset is visible to the game (ListPresets)
      let hasPreset = false;
      try {
        const results = await this.omegga.watchLogChunk(
          'Server.Minigames.ListPresets',
          /(?<index>\d+)\)\s+(?<name>.+)$/,
          { first: 'index', timeoutDelay: 250 }
        );
        const names = results
          .map(r => (r && r.groups && r.groups.name || '').trim())
          .filter(Boolean);

        hasPreset = names.some(n => n.toLowerCase() === 'infected' || n.toLowerCase() === 'infected.json');
        if (!hasPreset) {
          this.omegga.warn('[Infected] preset not reported by ListPresets; will attempt load anyway');
        }
      } catch (e) {
        this.omegga.warn('[Infected] ListPresets check failed', e && e.message);
      }

      // 3) Try to load the preset
      try {
        this.omegga.writeln('Server.Minigames.LoadPreset "Infected"');
        say('requested load preset "Infected"');
      } catch (e) {
        this.omegga.warn('[Infected] LoadPreset command failed', e && e.message);
        this.omegga.whisper(name, `LoadPreset failed: ${e && e.message}`);
        return;
      }

      // 4) Give basic confirmation by listing minigames shortly after
      try {
        await new Promise(r => setTimeout(r, 800));
        const games = await this.omegga.getMinigames();
        if (Array.isArray(games) && games.length) {
          say(`minigames on server: ${games.length} (check UI for "Infected")`);
        } else {
          say('minigame list is empty or unavailable; check the Minigame UI. If missing, open the editor and see if the preset appears.');
        }
      } catch (e) {
        this.omegga.warn('[Infected] getMinigames failed', e && e.message);
      }

      return;
    }

    // unknown subcommand
    this.omegga.whisper(name, `unknown subcommand "${sub}". usage: !infected createminigame`);
  }
};