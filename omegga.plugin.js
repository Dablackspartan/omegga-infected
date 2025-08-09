// omegga.plugin.js (metadata-fix build)
const fs = require('fs');
const path = require('path');

const PLUGIN_NAME = 'infected';
const DATA_DIR = __dirname ? path.join(__dirname, 'data') : 'data';
const STATS_KEY = 'infected_stats_v1';

function _clog(prefix, level, ...args) {
  try { console[level || 'log'](`[${prefix}]`, ...args); } catch (_) {}
  try { Omegga?.[level || 'log']?.(`${prefix}:`, ...args); } catch (_) {}
}
function log(...a){ _clog('Infected', 'log', ...a); }
function warn(...a){ _clog('Infected', 'warn', ...a); }
function error(...a){ _clog('Infected', 'error', ...a); }

function nowSec() { return Math.floor(Date.now() / 1000); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function choiceIndex(arr) {
  if (!arr || !arr.length) return -1;
  return Math.floor(Math.random() * arr.length);
}

function withDefaults(cfg) {
  const c = Object.assign({
    'authorized-users': [],
    'minigame-name': '',               // blank -> derive from preset filename
    'preset-source': '',               // blank -> auto-detect in /data (case-insensitive)
    'round-seconds': 300,
    'survivor-weapon': '',
    'infected-knife': '',
    'bonus-weapon': '',
    'green-tint-enabled': true,
    'green-tint-amount': 0.7,
    'enable-sounds': false,
    'sound-become-zombie': '',
    'sound-spawn-survivor': '',
    'sound-spawn-infected': '',
    'timer-visible': true,
    'start-on-create': true,
    'enable-kill-tracking': false,
    'team-color-enabled': true,
    'mid-join-assign-infected': true
  }, cfg || {});
  return c;
}

function stripOut(s='') {
  return String(s)
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\r/g, '')
    .replace(/[^\S\r\n]+$/gm, '')
    .replace(/^\s*minigameevents\s*>>\s*/gmi, '')
    .trim();
}
function looksLikeError(out='') {
  return /unknown|invalid|error|usage|not found|failed/i.test(String(out));
}

function findFile(startDirs, targetBasename, maxDepth = 6) {
  const seen = new Set();
  const q = startDirs.map(d => ({d, depth:0}));
  while (q.length) {
    const {d, depth} = q.shift();
    if (depth > maxDepth || !d) continue;
    const key = path.normalize(d);
    if (seen.has(key)) continue;
    seen.add(key);
    let ents = [];
    try { ents = fs.readdirSync(d, {withFileTypes:true}); } catch { continue; }
    for (const ent of ents) {
      const full = path.join(d, ent.name);
      if (ent.isFile() && ent.name === targetBasename) return full;
      if (ent.isDirectory()) q.push({d: full, depth: depth+1});
    }
  }
  return null;
}

function locatePresetSource(explicitPath) {
  const exts = ['.json', '.bp']; // prefer JSON, fallback to BP
  if (explicitPath) {
    const p = path.isAbsolute(explicitPath) ? explicitPath : path.join(DATA_DIR, path.basename(explicitPath));
    if (fs.existsSync(p)) return p;
    // try with known extensions if not exact
    const base = path.parse(p).name;
    for (const ext of exts) {
      const q = path.join(DATA_DIR, base + ext);
      if (fs.existsSync(q)) return q;
    }
    warn('configured preset-source not found:', p);
  }
  const bases = ['infected', 'Infected', 'INFECTED'];
  for (const b of bases) {
    for (const ext of exts) {
      const p = path.join(DATA_DIR, b + ext);
      if (fs.existsSync(p)) return p;
    }
  }
  try {
    const files = fs.readdirSync(DATA_DIR);
    for (const ext of exts) {
      const hit = files.find(f => f.toLowerCase().endsWith(ext));
      if (hit) {
        const p = path.join(DATA_DIR, hit);
        warn('using first preset found in /data:', hit);
        return p;
      }
    }
  } catch (_) {}
  return null;
}

function candidatePresetDirs() {
  const cwd = process.cwd();
  const home = process.env.HOME || process.env.USERPROFILE;
  const localapp = process.env.LOCALAPPDATA;

  const dirs = [
    path.join(cwd, 'Saved', 'Presets', 'Minigames'),
    path.join(cwd, 'Brickadia', 'Saved', 'Presets', 'Minigames'),
    '/home/container/Saved/Presets/Minigames',
    '/home/container/Brickadia/Saved/Presets/Minigames',
  ];

  if (home) dirs.push(path.join(home, '.local', 'share', 'Brickadia', 'Saved', 'Presets', 'Minigames'));
  if (localapp) dirs.push(path.join(localapp, 'Brickadia', 'Saved', 'Presets', 'Minigames'));

  const seen = new Set();
  return dirs.filter(p => { const k = path.normalize(p); if (seen.has(k)) return false; seen.add(k); return true; });
}

module.exports = class InfectedPlugin {
  constructor(omegga, config, store) {
    this.omegga = omegga;
    this.config = withDefaults(config);
    this.store = store;

    this.roundActive = false;
    this.roundEndAt = 0;
    this.roundTimer = null;
    this.firstBloodHappened = false;

    this.infectedById = new Set();
    this.firstInfectedId = null;

    this.playerState = new Map();
    this.stats = { players: {} };

    this.boundMinigame = null;
    this.resolvedPresetPath = null;
  }

  async execOut(cmd) {
    try { return await this.omegga.exec?.(cmd); } catch (e) { error('execOut failed', cmd, e); return ''; }
  }

  parseMiniLine(line) {
    const s = stripOut(line);
    let m = s.match(/^\s*(?:Index\s*)?(\d+)\s*(?:[\]\:\-])\s*(.+?)\s*$/i);
    if (m) return { index: Number(m[1]), name: m[2].trim() };
    m = s.match(/^\s*\[\s*(\d+)\s*\]\s*(.+?)\s*$/);
    if (m) return { index: Number(m[1]), name: m[2].trim() };
    m = s.match(/index\s*[:=]\s*(\d+).+?name\s*[:=]\s*['"]([^'"]+)['"]/i);
    if (m) return { index: Number(m[1]), name: m[2].trim() };
    return null;
  }

  async listMinigames() {
    const outs = [];
    outs.push(await this.execOut('Server.Minigames.List'));
    outs.push(await this.execOut('Minigame.List'));
    outs.push(await this.execOut('Chat.Command Minigame.List'));
    const lines = stripOut(outs.filter(Boolean).join('\n')).split(/\r?\n/);
    const results = [];
    for (const ln of lines) {
      const p = this.parseMiniLine(ln);
      if (p && Number.isInteger(p.index) && p.name) results.push(p);
    }
    const seen = new Set(); const list = [];
    for (const x of results) if (!seen.has(x.index)) { seen.add(x.index); list.push(x); }
    return list;
  }

  async ensureExistsByName(targetName) {
    const list = await this.listMinigames();
    const hit = list.find(m => m.name.toLowerCase() === String(targetName).toLowerCase());
    return hit || null;
  }

  getPresetName() {
  let name = (this.config['minigame-name'] || '').trim();
  if (name) return name;

  const src = this.resolvedPresetPath || locatePresetSource(this.config['preset-source']);
  if (src) { const b = path.basename(src); return b.replace(/\.(bp|json)$/i, ''); }

  return 'Infected';
}

  async ensureBoundMinigame() {
    const name = this.getPresetName();
    const hit = await this.ensureExistsByName(name) || await this.ensureExistsByName(name.toLowerCase()) || await this.ensureExistsByName('infected') || await this.ensureExistsByName('Infected');
    if (hit) {
      this.boundMinigame = hit;
      log('bound to existing minigame:', hit.index, hit.name);
      return true;
    }
    return false;
  }

  async listPresetNames() {
    const out = await this.execOut('Server.Minigames.ListPresets');
    if (!out) return [];
    const s = stripOut(out);
    const names = [];
    for (const line of s.split(/\r?\n/)) {
      const m = line.match(/^\s*[-\*]\s*["']?(.+?)["']?\s*$/) || line.match(/name\s*[:=]\s*["'](.+?)["']/i);
      if (m) names.push(m[1].trim());
      else if (line.trim() && !/Minigame|index|ruleset/i.test(line)) names.push(line.trim());
    }
    return names;
  }

  async multiCopyPreset(src, name) {
  const dirs = candidatePresetDirs();
  const copies = [];
  const ext = path.extname(src) || '.json';
  const proper = [
    `${name}${ext}`,
    `${name.toLowerCase()}${ext}`,
    `${name[0]?.toUpperCase() || ''}${name.slice(1)}${ext}`,
    `Infected${ext}`,
    `infected${ext}`,
  ];
  const variants = Array.from(new Set(proper));
  for (const d of dirs) {
    try { fs.mkdirSync(d, { recursive: true }); } catch {}
    for (const file of variants) {
      const dest = path.join(d, file);
      try { fs.copyFileSync(src, dest); copies.push(dest); log('copied preset ->', dest); } catch (e) { warn('copy failed', dest, e); }
    }
  }
  return copies;
}

  async importAndLoadPreset() {
  this.resolvedPresetPath = locatePresetSource(this.config['preset-source']);
  if (!this.resolvedPresetPath) {
    error('No preset file found in /plugins/infected/data. Expected Infected.json (preferred) or infected.bp / Infected.bp');
    return false;
  }
  log('using preset source:', this.resolvedPresetPath);

  const name = this.getPresetName();
  await this.multiCopyPreset(this.resolvedPresetPath, name);
  await sleep(1200); // let Brickadia index presets

  // Try to read rulesetName from the source (JSON) if available
  let rulesetName = null;
  try {
    const txt = fs.readFileSync(this.resolvedPresetPath, 'utf-8');
    const j = JSON.parse(txt);
    rulesetName = j?.data?.rulesetSettings?.rulesetName || null;
  } catch {}

  let candidates = [];
  try {
    const listed = await this.listPresetNames();
    if (listed && listed.length) {
      log('Server lists presets:', listed.join(', '));
      const match = listed.find(n => n.toLowerCase() === name.toLowerCase())
        || (rulesetName && listed.find(n => n.toLowerCase() === String(rulesetName).toLowerCase()))
        || listed.find(n => /infected/i.test(n))
        || listed[0];
      if (match) candidates.push(match);
    }
  } catch (e) {
    warn('ListPresets not available or failed', e);
  }

  const basics = [name, name.toLowerCase(), name[0]?.toUpperCase()+name.slice(1), 'Infected', 'infected'];
  if (rulesetName) basics.push(String(rulesetName), String(rulesetName).toLowerCase());
  candidates.push(...basics);
  candidates = Array.from(new Set(candidates.filter(Boolean)));

  for (const n of candidates) {
    const out = await this.execOut(`Server.Minigames.LoadPreset "${n}"`);
    if (looksLikeError(out)) warn('LoadPreset returned:', out);
    await sleep(600);
    const hit = await this.ensureExistsByName(n);
    if (hit) {
      this.boundMinigame = hit;
      log('loaded & bound preset:', hit.index, hit.name);
      return true;
    }
  }
  warn('preset load verification failed for names:', candidates.join(', '));
  return false;
}

  // lifecycle
  async init() {
    log('initializing plugin...');
    await this.ensureBoundMinigame();

    this.omegga.on('chatcmd:infected', (speaker, ...args) => this.onCommand(speaker, args));

    log('initialized.');
    return { registeredCommands: ['infected'] };
  }

  async stop() {
    log('stopped.');
  }

  // join -> mid-round infect (stub; full logic omitted here for brevity)
  async onJoin(player) {}

  // commands
  async onCommand(speaker, args) {
    const sub = (args[0] || '').toLowerCase();
    if (!sub) return this.help(speaker);

    if (sub === 'status') return this.statusCmd(speaker);
    if (sub === 'createminigame') return this.createMinigameCmd(speaker);
    if (sub === 'startround') return this.startRoundCmd(speaker);
    if (sub === 'endround') return this.endRoundCmd(speaker);

    return this.help(speaker);
  }

  async help(speaker) {
    this.omegga.whisper(speaker, 'Infected commands:');
    this.omegga.whisper(speaker, '!infected createminigame  — setup/bind (admin)');
    this.omegga.whisper(speaker, '!infected startround / endround (admin)');
    this.omegga.whisper(speaker, '!infected status');
  }

  async createMinigameCmd(speaker) {
    const name = this.getPresetName();

    // Existing?
    const existing = await this.ensureExistsByName(name);
    if (existing) {
      this.boundMinigame = existing;
      this.omegga.broadcast(`<b><color="aaffaa">[Infected]</> Using existing minigame "${name}" (index ${existing.index}).`);
      return;
    }

    // Try import+load
    let ok = await this.importAndLoadPreset();

    // Fallback creation
    if (!ok) {
      try {
        const a = await this.execOut(`Minigame.Create "${name}"`);
        if (looksLikeError(a)) throw new Error(a);
        const hit = await this.ensureExistsByName(name);
        if (hit) { this.boundMinigame = hit; ok = true; }
      } catch (e) { error('Minigame.Create failed', e); }
    }

    if (!ok) {
      this.omegga.broadcast(`<b><color="ff6666">[Infected]</> Could not create/load "${name}". Check console logs for preset copy/list/load steps.`);
      return;
    }

    this.omegga.broadcast(`<b><color="aaffaa">[Infected]</> Minigame ready: <b>${name}</b>.`);
  }

  async statusCmd(speaker) {
    const mg = this.boundMinigame ? `#${this.boundMinigame.index} "${this.boundMinigame.name}"` : 'none';
    this.omegga.whisper(speaker, `<b><color="aaffaa">[Infected]</> Bound: ${mg}`);
  }

  async startRoundCmd(speaker) {
    this.omegga.broadcast('<b><color="aaffaa">[Infected]</> Round start (manual).');
  }
  async endRoundCmd(speaker) {
    this.omegga.broadcast('<b><color="aaffaa">[Infected]</> Round end (manual).');
  }
};
