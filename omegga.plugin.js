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
  const dirs = ['/home/container/data/Saved/Presets/Minigame'];
  return dirs;
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
};
