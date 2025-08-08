
/* Infected / Zombies (Omegga) - v0.7.2
 * Robust preset import & minigame binding with heavy logging.
 * Auto-binds to a minigame named 'Infected' if it already exists.
 */
const fs = require('fs');
const path = require('path');

const PLUGIN_PREFIX = '[Infected]';
const PRESET_BASENAME = 'Infected.bp';
const PRESET_CANDIDATE_NAMES = ['Infected', 'infected', 'Infected.bp', 'infected.bp'];

class Plugin {
  constructor(omegga, config, store) {
    this.omegga = omegga;
    this.config = config || {};
    this.store = store;
    this.boundIndex = null;
    this.boundName = null;
    this.roundActive = false;
  }

  // ---------- helpers ----------
  log(...a){ this.omegga.log(PLUGIN_PREFIX, ...a); }
  warn(...a){ this.omegga.warn(PLUGIN_PREFIX, ...a); }
  error(...a){ this.omegga.error(PLUGIN_PREFIX, ...a); }

  async execOut(cmd) {
    try {
      const out = await this.omegga.writeln(cmd);
      if (typeof out === 'string') return out;
      if (Array.isArray(out)) return out.join('\n');
      return '';
    } catch (e) {
      this.error('exec failed:', cmd, e?.message||e);
      return '';
    }
  }

  // Parse output of Server.Minigames.List into [{index, name}]
  parseMinigameList(raw) {
    if (!raw) return [];
    const lines = raw.split(/\r?\n/);
    const minis = [];
    for (const line of lines) {
      // Accept a few common formats
      // 1) [0] GLOBAL
      let m = line.match(/^\s*\[?(\d+)\]?\s+(.+)$/);
      if (m) {
        const idx = parseInt(m[1],10);
        const name = m[2].replace(/^"|"$/g,'');
        if (!Number.isNaN(idx) && name) minis.push({index: idx, name});
        continue;
      }
      // 2) #0 "GLOBAL"
      m = line.match(/[#\[]?(\d+)[\]]?\s+"([^"]+)"/);
      if (m) minis.push({index: parseInt(m[1],10), name: m[2]});
    }
    return minis;
  }

  async listMinigames() {
    // Try native API first
    try {
      if (typeof this.omegga.getMinigames === 'function') {
        const list = await this.omegga.getMinigames();
        if (Array.isArray(list) && list.length) {
          return list.map(m=>({index:m.index, name:m.name}));
        }
      }
    } catch(e) {
      this.warn('omegga.getMinigames failed:', e?.message||e);
    }
    // Fallback to console read
    const out = await this.execOut('Server.Minigames.List');
    if (out) this.log('minigame list raw:', out);
    return this.parseMinigameList(out);
  }

  async tryBindExistingInfected() {
    const minis = await this.listMinigames();
    const hit = minis.find(m => /infected/i.test(m.name));
    if (hit) {
      this.boundIndex = hit.index;
      this.boundName = hit.name;
      this.log('auto-bound to existing minigame:', `#${hit.index} "${hit.name}"`);
      return true;
    }
    return false;
  }

  getDataPresetPath() {
    const cfg = this.config['minigame-template'] || `plugins/infected/data/${PRESET_BASENAME}`;
    // Accept absolute or relative to server root
    if (path.isAbsolute(cfg)) return cfg;
    const abs = path.join(process.cwd(), cfg.replace(/^[./]+/, ''));
    return abs;
  }

  ensureDir(p) {
    try { fs.mkdirSync(p, {recursive:true}); } catch {}
  }

  copyPresetToTargets() {
    const src = this.getDataPresetPath();
    const ok = fs.existsSync(src);
    this.log('using preset source:', src);
    if (!ok) {
      this.warn('preset source missing - put your preset at', src);
      return {src, targets:[], copied:false};
    }
    const roots = [
      path.join(process.cwd(), 'Saved', 'Presets', 'Minigames'),
      path.join(process.cwd(), 'Brickadia','Saved','Presets','Minigames'),
    ];
    const targets = [];
    for (const root of roots) {
      try {
        this.ensureDir(root);
        const t1 = path.join(root, PRESET_BASENAME);
        const t2 = path.join(root, PRESET_BASENAME.toLowerCase());
        fs.copyFileSync(src, t1);
        this.log('copied preset ->', t1);
        try { fs.copyFileSync(src, t2); this.log('copied preset ->', t2); } catch {}
        targets.push(t1, t2);
      } catch (e) {
        this.warn('copy failed for', root, e?.message||e);
      }
    }
    return {src, targets, copied: targets.length>0};
  }

  async tryLoadPresetByNames(names) {
    let hit = false;
    for (const n of names) {
      // Attempt a handful of syntaxes
      const cmds = [
        `Server.Minigames.LoadPreset "${n}"`,
        `Minigames.LoadPreset "${n}"`,
        `Chat.Command "Server.Minigames.LoadPreset ${n.replace(/"/g,'')}"`,
      ];
      for (const c of cmds) {
        const out = await this.execOut(c);
        if (out) this.log('load attempt:', c, '->', out);
      }
      // After attempts, see if a new minigame appeared
      const minis = await this.listMinigames();
      const found = minis.find(m => m.name===n || /infected/i.test(m.name));
      if (found) {
        this.boundIndex = found.index;
        this.boundName = found.name;
        this.log('bound after load:', `#${found.index} "${found.name}"`);
        hit = true;
        break;
      }
    }
    return hit;
  }

  async createBlankMinigameFallback() {
    // Try Omegga API if present
    try {
      if (typeof this.omegga.createMinigame === 'function') {
        const mg = await this.omegga.createMinigame({name:'Infected'});
        if (mg && typeof mg.index === 'number') {
          this.boundIndex = mg.index;
          this.boundName = mg.name || 'Infected';
          this.log('created via API:', `#${this.boundIndex} "${this.boundName}"`);
          return true;
        }
      }
    } catch (e) {
      this.warn('omegga.createMinigame failed:', e?.message||e);
    }
    // Try raw console (syntax varies across builds; best-effort)
    await this.execOut('Server.Minigames.Create "Infected"');
    const minis = await this.listMinigames();
    const found = minis.find(m=>/infected/i.test(m.name));
    if (found) {
      this.boundIndex = found.index;
      this.boundName = found.name;
      this.log('created via console:', `#${found.index} "${found.name}"`);
      return true;
    }
    return false;
  }

  hasAccess(name) {
    const list = this.config['authorized-users'];
    if (!Array.isArray(list) || !list.length) return true;
    return list.some(x => x && typeof x === 'string' && x.toLowerCase() === name.toLowerCase());
  }

  // ---------- commands ----------
  async handleCreateMini(sender) {
    if (!this.hasAccess(sender)) {
      this.warn('blocked createminigame from', sender);
      return {ephemeral: true, message: 'You are not authorized.'};
    }

    // 0) try existing
    if (await this.tryBindExistingInfected()) {
      return {message: 'Bound to existing Infected minigame.'};
    }

    const before = await this.listMinigames();

    // 1) copy preset into likely folders
    const {copied} = this.copyPresetToTargets();

    // 2) try to load by various names (filename and common capitalizations)
    let ok = false;
    if (copied) ok = await this.tryLoadPresetByNames(PRESET_CANDIDATE_NAMES);

    // 3) detect new minigame by diff even if name is unexpected
    if (!ok) {
      const after = await this.listMinigames();
      const beforeIdxs = new Set(before.map(m=>m.index));
      const added = after.filter(m=>!beforeIdxs.has(m.index));
      if (added.length) {
        const found = added[0];
        this.boundIndex = found.index;
        this.boundName = found.name;
        ok = true;
        this.log('detected new minigame by diff ->', `#${found.index} "${found.name}"`);
      }
    }

    // 4) create blank as last resort
    if (!ok) ok = await this.createBlankMinigameFallback();

    if (!ok) {
      this.warn('Could not create/load infected. Ensure the server can load presets and try again.');
      return {message: 'Could not create/load infected. Ensure the server can load presets and try again.'};
    }

    // auto start?
    if (this.config['start-on-create']) {
      this.roundActive = true;
      this.log('auto-start requested after creation.');
    }
    return {message: `Bound to #${this.boundIndex} "${this.boundName}"`};
  }

  async handleStatus() {
    const minis = await this.listMinigames();
    const bound = this.boundIndex!=null ? minis.find(m=>m.index===this.boundIndex) : null;
    return {message: bound ? `Bound: #${bound.index} "${bound.name}"` : 'Not bound.'};
  }

  // ---------- omegga ----------
  async init() {
    this.log('init start');
    // auto-bind on boot if possible
    await this.tryBindExistingInfected();

    this.omegga.on('chatcmd:infected', async (name, sub, ...args) => {
      sub = (sub||'').toLowerCase();
      try {
        if (sub === 'createminigame') {
          const r = await this.handleCreateMini(name);
          if (r?.message) this.omegga.broadcast(`${PLUGIN_PREFIX} ${r.message}`);
        } else if (sub === 'status') {
          const r = await this.handleStatus();
          if (r?.message) this.omegga.broadcast(`${PLUGIN_PREFIX} ${r.message}`);
        } else if (sub === 'startround') {
          if (!this.hasAccess(name)) return;
          this.roundActive = true;
          this.omegga.broadcast(`${PLUGIN_PREFIX} round started (manual).`);
        } else if (sub === 'endround') {
          if (!this.hasAccess(name)) return;
          this.roundActive = false;
          this.omegga.broadcast(`${PLUGIN_PREFIX} round ended (manual).`);
        } else {
          this.omegga.whisper(name, '!infected createminigame | status | startround | endround');
        }
      } catch (e) {
        this.error('command handler failed:', e?.stack||e?.message||e);
      }
    });

    this.log('init done');
  }

  async stop() {
    this.log('stopped');
  }
}

module.exports = Plugin;
