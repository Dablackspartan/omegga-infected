// omegga.plugin.js
/* eslint-disable no-undef */
const fs = require('fs');
const path = require('path');

const PLUGIN_NAME = 'infected';
const DATA_DIR = __dirname ? path.join(__dirname, 'data') : 'data';
const DEFAULT_PRESET_SOURCE = path.join(DATA_DIR, 'infected.bp');
const STATS_KEY = 'infected_stats_v1';

function nowSec() { return Math.floor(Date.now() / 1000); }
function log(...args) { try { Omegga?.log?.(PLUGIN_NAME + ':', ...args); } catch (e) {} }
function warn(...args) { try { Omegga?.warn?.(PLUGIN_NAME + ':', ...args); } catch (e) {} }
function error(...args) { try { Omegga?.error?.(PLUGIN_NAME + ':', ...args); } catch (e) {} }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function safeTry(tag, fn) {
  try { return await fn(); }
  catch (e) { error(`[${tag}]`, e && e.stack ? e.stack : e); }
}

function choiceIndex(arr) {
  if (!arr || !arr.length) return -1;
  return Math.floor(Math.random() * arr.length);
}

function withDefaults(cfg) {
  const c = Object.assign({
    'authorized-users': [],
    // If empty => derive preset/minigame name from preset-source basename (without .bp)
    'minigame-name': '',
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
    'mid-join-assign-infected': true,
    // Always assume preset lives in plugin /data
    'preset-source': 'data/infected.bp'
  }, cfg || {});

  // Normalize relative preset source path to plugin dir
  if (c['preset-source'] && !path.isAbsolute(c['preset-source'])) {
    c['preset-source'] = path.join(DATA_DIR, path.basename(c['preset-source']));
  }
  return c;
}

// ----- generic output helpers -----
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

// breadth-first search for a filename under a set of roots
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
  }

  // ---- command exec & parsing ----
  async execOut(cmd) {
    try { return await this.omegga.exec?.(cmd); } catch { return ''; }
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
    if (!name) {
      const src = (this.config['preset-source'] || DEFAULT_PRESET_SOURCE);
      const base = path.basename(src, '.bp');
      name = base || 'Infected';
    }
    return name;
  }

  // >>> missing before: provide ensureBoundMinigame <<<
  async ensureBoundMinigame() {
    const name = this.getPresetName();
    const hit = await this.ensureExistsByName(name);
    if (hit) {
      this.boundMinigame = hit;
      log('bound to existing minigame:', hit.index, hit.name);
      return true;
    }
    return false;
  }

  // ---- detect the actual presets directory by saving a probe ----
  async detectMinigamePresetDir() {
    const probeName = `_infected_probe_${Date.now()}`;
    const cmd = `Server.Minigames.SavePreset 0 "${probeName}"`;
    const out = await this.execOut(cmd);
    if (looksLikeError(out)) warn('SavePreset probe returned:', out);
    await sleep(500);

    // Search likely roots for the probe file
    const roots = [
      process.cwd(),
      path.join(process.cwd(), 'Brickadia'),
      '/home/container',
      process.env.HOME,
      process.env.USERPROFILE,
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Brickadia'),
      process.env.HOME && path.join(process.env.HOME, '.local', 'share'),
    ].filter(Boolean);

    const found = findFile(roots, `${probeName}.bp`, 6);
    if (!found) {
      warn('probe preset not found; falling back to ./Saved/Presets/Minigames');
      const fallback = path.join(process.cwd(), 'Saved', 'Presets', 'Minigames');
      try { fs.mkdirSync(fallback, { recursive: true }); } catch {}
      return fallback;
    }

    // cleanup the probe
    try { fs.unlinkSync(found); } catch {}
    const dir = path.dirname(found);
    log('detected Minigame Presets dir:', dir);
    return dir;
  }

  // ---- import from plugin data and load by name (robust) ----
  async importAndLoadPreset() {
    const name = this.getPresetName();
    const src = (this.config['preset-source'] || DEFAULT_PRESET_SOURCE);
    if (!fs.existsSync(src)) {
      warn('preset source not found:', src);
      return false;
    }

    const presetDir = await this.detectMinigamePresetDir();
    try { fs.mkdirSync(presetDir, { recursive: true }); } catch {}

    // Copy as both name.bp and common case variants to dodge case issues
    const variants = Array.from(new Set([
      `${name}.bp`,
      `${name.toLowerCase()}.bp`,
      `${name[0].toUpperCase()}${name.slice(1)}.bp`,
      `Infected.bp`, `infected.bp`
    ]));
    for (const file of variants) {
      const t = path.join(presetDir, file);
      try { fs.copyFileSync(src, t); log('copied preset to', t); } catch (e) { warn('copy failed', t, e); }
    }

    // Try several likely load names
    const candidates = Array.from(new Set([name, name.toLowerCase(), name[0].toUpperCase()+name.slice(1), 'Infected', 'infected']));
    for (const n of candidates) {
      const out = await this.execOut(`Server.Minigames.LoadPreset "${n}"`);
      if (looksLikeError(out)) warn('LoadPreset returned:', out);
      await sleep(400);
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

  // ---- lifecycle ----
  async init() {
    log('initializing plugin...');

    try {
      const s = await this.store.get(STATS_KEY);
      if (s && typeof s === 'object') this.stats = s;
    } catch(e) { error('load-stats', e); }

    await this.ensureBoundMinigame();

    this.omegga.on('chatcmd:infected', (speaker, ...args) => this.onCommand(speaker, args));
    this.omegga.on('join', (player) => this.onJoin(player));

    this.roundTimer = setInterval(() => this.tick().catch(e => error('tick', e)), 500);

    log('initialized.');
    return { registeredCommands: ['infected'] };
  }

  async stop() {
    if (this.roundTimer) clearInterval(this.roundTimer);
    try { await this.store.set(STATS_KEY, this.stats); } catch(e) { error('save-stats', e); }
    log('stopped.');
  }

  // ---- events ----
  async onJoin(player) {
    try {
      if (!this.roundActive) return;
      if (!this.config['mid-join-assign-infected']) return;
      if (!player || !player.id || !player.name) return;

      if (!this.playerState.has(player.id)) {
        this.playerState.set(player.id, { name: player.name, isDead: false, becameInfectedAt: 0, survivalStartAt: 0 });
      }
      setTimeout(() => {
        this.becomeInfected({ id: player.id, name: player.name }).catch(e => error('onJoin->becomeInfected', e));
        this.omegga.whisper(player.name, '<b><color="22ff22">[Infected]</> You joined mid-round and were added to the Infected.</b>');
      }, 1000);
    } catch (e) { error('onJoin', e); }
  }

  // ---- commands ----
  async onCommand(speaker, args) {
    const sub = (args[0] || '').toLowerCase();
    if (!sub) return this.help(speaker);

    if (sub === 'status') return this.statusCmd(speaker);
    if (sub === 'createminigame') return this.createMinigameCmd(speaker);
    if (sub === 'bindminigame') return this.bindMinigameCmd(speaker, args[1], args[2]);
    if (sub === 'debuglist') return this.debugListCmd(speaker);

    if (sub === 'startround') return this.startRoundCmd(speaker);
    if (sub === 'endround') return this.endRoundCmd(speaker, 'forced');

    return this.help(speaker);
  }

  async help(speaker) {
    this.omegga.whisper(speaker, 'Infected commands:');
    this.omegga.whisper(speaker, '!infected createminigame  — setup/bind (admin)');
    this.omegga.whisper(speaker, '!infected startround / endround (admin)');
    this.omegga.whisper(speaker, '!infected status');
  }

  async isAuthorizedByName(name) {
    const p = this.omegga.getPlayer(name);
    if (!p) return false;
    try {
      const roles = await p.getRoles();
      if (roles && roles.includes('Admin')) return true;
    } catch (_) {}
    try {
      const id = p.id || (await p.getId?.());
      const allow = Array.isArray(this.config['authorized-users']) ? this.config['authorized-users'] : [];
      if (allow.find(u => u && (u.id === id || u.name === name))) return true;
    } catch (_) {}
    return false;
  }

  async createMinigameCmd(speaker) {
    if (!(await this.isAuthorizedByName(speaker))) {
      return this.omegga.whisper(speaker, 'Not authorized.');
    }

    const name = this.getPresetName();
    const teams = ['Survivors', 'Infected'];

    // If exists, bind and go
    const existing = await this.ensureExistsByName(name);
    if (existing) {
      this.boundMinigame = existing;
      this.omegga.broadcast(`<b><color="aaffaa">[Infected]</> Using existing minigame "${name}" (index ${existing.index}).`);
    } else {
      let ok = false;

      // A) Import from plugin /data into detected presets dir and LoadPreset
      const imported = await this.importAndLoadPreset();
      if (imported) ok = true;

      // B) LoadPreset by name anyway (in case the preset already existed under same/alt case name)
      if (!ok) {
        const out = await this.execOut(`Server.Minigames.LoadPreset "${name}"`);
        if (looksLikeError(out)) warn('LoadPreset returned:', out);
        const hit = await this.ensureExistsByName(name);
        if (hit) { this.boundMinigame = hit; ok = true; }
      }

      // C) direct console create (legacy)
      if (!ok) {
        try {
          const a = await this.execOut(`Minigame.Create "${name}"`);
          const b = await this.execOut(`Minigame.AddTeam "${name}" "${teams[0]}"`);
          const c = await this.execOut(`Minigame.AddTeam "${name}" "${teams[1]}"`);
          if (looksLikeError(a+b+c)) throw new Error('Minigame.Create path failed');
          const hit = await this.ensureExistsByName(name);
          if (hit) { this.boundMinigame = hit; ok = true; }
        } catch (e) { error('create path A failed', e); }
      }

      // D) Omegga API
      if (!ok) {
        try {
          if (typeof this.omegga.createMinigame === 'function') {
            await this.omegga.createMinigame?.({ name, teams });
            const hit = await this.ensureExistsByName(name);
            if (hit) { this.boundMinigame = hit; ok = true; }
          }
        } catch (e) { error('create path B API failed', e); }
      }

      // E) Chat.Command legacy
      if (!ok) {
        try {
          const a = await this.execOut(`Chat.Command Minigame.Create "${name}"`);
          const b = await this.execOut(`Chat.Command Minigame.AddTeam "${name}" "${teams[0]}"`);
          const c = await this.execOut(`Chat.Command Minigame.AddTeam "${name}" "${teams[1]}"`);
          if (looksLikeError(a+b+c)) throw new Error('Chat.Command path failed');
          const hit = await this.ensureExistsByName(name);
          if (hit) { this.boundMinigame = hit; ok = true; }
        } catch (e) { error('create path C chat failed', e); }
      }

      if (!ok) {
        this.omegga.broadcast(`<b><color="ff6666">[Infected]</> Could not create/load "${name}". Check console logs for detected preset dir and copy/load steps.`);
        return;
      }
    }

    this.omegga.broadcast(`<b><color="aaffaa">[Infected]</> Minigame ready: <b>${name}</b>.`);
    if (this.config['start-on-create']) await this.startRound();
    else this.omegga.broadcast('<b><color="aaffaa">[Infected]</> Use !infected startround to begin.');
  }

  async bindMinigameCmd(speaker, modeOrIndex, maybeName) {
    if (!(await this.isAuthorizedByName(speaker))) return this.omegga.whisper(speaker, 'Not authorized.');

    const mode = (modeOrIndex || '').toLowerCase();

    if (mode === 'name') {
      const name = (maybeName || '').trim();
      if (!name) return this.omegga.whisper(speaker, 'Usage: !infected bindminigame name <PresetName>');
      this.config['minigame-name'] = name;
      this.boundMinigame = await this.ensureExistsByName(name) || { index: -1, name };
      return this.omegga.broadcast(`<b><color="aaffaa">[Infected]</> Bound by name to "${name}"${this.boundMinigame.index>=0?` (index ${this.boundMinigame.index})`:''}.`);
    }

    const i = Number(modeOrIndex);
    if (Number.isInteger(i)) {
      const list = await this.listMinigames();
      const hit = list.find(m => m.index === i);
      if (!hit) return this.omegga.whisper(speaker, `No minigame at index ${i}. Try "!infected bindminigame name <name>".`);
      this.config['minigame-name'] = hit.name;
      this.boundMinigame = hit;
      return this.omegga.broadcast(`<b><color="aaffaa">[Infected]</> Bound: "${hit.name}" (index ${i}).`);
    }

    this.omegga.whisper(speaker, 'Usage: !infected bindminigame <index>  — or —  !infected bindminigame name <PresetName>');
  }

  async debugListCmd(speaker) {
    // Kept for admins; not advertised in help
    if (!(await this.isAuthorizedByName(speaker))) return;
    const a = await this.execOut('Server.Minigames.List');
    const b = await this.execOut('Minigame.List');
    const c = await this.execOut('Chat.Command Minigame.List');
    Omegga.log('infected: raw Server.Minigames.List >>>\n' + (a||'(empty)'));
    Omegga.log('infected: raw Minigame.List >>>\n' + (b||'(empty)'));
    Omegga.log('infected: raw Chat.Command Minigame.List >>>\n' + (c||'(empty)'));
    this.omegga.whisper(speaker, 'Dumped raw list outputs to server console.');
  }

  async statusCmd(speaker) {
    const secsLeft = Math.max(0, (this.roundEndAt || 0) - nowSec());
    const infectedCount = this.infectedById.size;
    const total = this.playerState.size;
    const mg = this.boundMinigame ? `#${this.boundMinigame.index} "${this.boundMinigame.name}"` : 'none';

    const lines = [
      `<b><color="aaffaa">[Infected]</> Round: ${this.roundActive ? 'ACTIVE' : 'idle'} | Minigame: ${mg}`,
      `Players: ${total} | Infected: ${infectedCount} | Survivors: ${Math.max(0, total - infectedCount)}`,
      `Timer: ${this.roundActive ? secsLeft + 's' : 'n/a'}`
    ];
    for (const line of lines) this.omegga.whisper(speaker, line);
  }

  // >>> missing before: provide wrappers used by onCommand <<<
  async startRoundCmd(speaker) {
    if (!(await this.isAuthorizedByName(speaker))) return this.omegga.whisper(speaker, 'Not authorized.');
    await this.startRound();
  }

  async endRoundCmd(speaker, why = 'forced') {
    if (!(await this.isAuthorizedByName(speaker))) return this.omegga.whisper(speaker, 'Not authorized.');
    await this.endRound(why);
  }

  // ---- round logic ----
  async startRound() {
    if (this.roundActive) return;
    const pos = await this.omegga.getAllPlayerPositions?.() || [];
    if (pos.length < 2) {
      this.omegga.broadcast('<b><color="ffaaaa">[Infected]</> Need at least 2 players to start.');
      return;
    }

    this.roundActive = true;
    this.firstBloodHappened = false;
    this.infectedById.clear();
    this.firstInfectedId = null;
    this.roundEndAt = nowSec() + Math.max(30, Number(this.config['round-seconds']) || 300);

    this.playerState.clear();
    for (const p of pos) {
      const pl = this.omegga.getPlayer(p.player);
      if (pl?.id) this.playerState.set(pl.id, { name: pl.name || p.player, isDead: false, becameInfectedAt: 0, survivalStartAt: nowSec() });
    }

    const players = [...this.playerState.keys()].map(id => ({ id, name: this.playerState.get(id).name }));
    const idx = choiceIndex(players);
    const first = players[idx];
    if (!first) return this.endRound('no players');

    await this.becomeInfected(first, { isFirst: true });
    for (const p of players) {
      if (p.id !== first.id) await this.becomeSurvivor(p);
    }

    this.omegga.broadcast(`<b><color="aaffaa">[Infected]</> Round started! Timer: ${this.config['round-seconds']}s.`);
  }

  async endRound(reason) {
    if (!this.roundActive) return;
    this.roundActive = false;

    const now = nowSec();
    for (const [id, st] of this.playerState.entries()) {
      if (st && st.survivalStartAt && !this.infectedById.has(id)) {
        const survived = now - st.survivalStartAt;
        this.updateBestTime(id, st.name, survived);
      }
    }

    try { await this.store.set(STATS_KEY, this.stats); } catch(e) { error('save-stats', e); }

    const survivorsLeft = [...this.playerState.keys()].filter(id => !this.infectedById.has(id)).length;
    const endMsg = reason === 'timer' ? 'Time\'s up! Survivors win.'
      : (survivorsLeft === 0 ? 'All survivors infected! Zombies win.' : `Round ended (${reason}).`);
    this.omegga.broadcast(`<b><color="aaffaa">[Infected]</> ${endMsg}`);

    this.playerState.clear();
    this.infectedById.clear();
    this.firstInfectedId = null;
    this.firstBloodHappened = false;
    this.roundEndAt = 0;
  }

  async tick() {
    if (!this.roundActive) return;

    if (this.roundEndAt && nowSec() >= this.roundEndAt) {
      return this.endRound('timer');
    }

    const pos = await this.omegga.getAllPlayerPositions?.() || [];
    const byName = new Map(pos.map(p => [p.player, p]));

    for (const [id, st] of this.playerState.entries()) {
      const name = st.name;
      const p = this.omegga.getPlayer(name);
      if (!p) continue;

      const plog = byName.get(name);
      const isDead = !!(plog && plog.isDead);

      const infected = this.infectedById.has(id);
      if (!infected && isDead) {
        if (!this.firstBloodHappened) {
          this.firstBloodHappened = true;
          await this.disableFirstBonus();
        }
        await this.convertSurvivorToInfectedByName(name);
      }
    }

    const survivorsLeft = [...this.playerState.keys()].filter(id => !this.infectedById.has(id)).length;
    if (survivorsLeft <= 0) await this.endRound('all infected');
  }

  // ---- roles, loadouts, visuals ----
  async becomeInfected(playerRef, opts = {}) {
    const p = typeof playerRef === 'object' && playerRef.id ? playerRef : this.omegga.getPlayer(playerRef);
    if (!p) return;
    this.infectedById.add(p.id);
    if (opts.isFirst) this.firstInfectedId = p.id;

    const st = this.playerState.get(p.id) || { name: p.name };
    if (st.survivalStartAt) {
      const survived = nowSec() - st.survivalStartAt;
      this.updateBestTime(p.id, p.name, survived);
    }
    st.becameInfectedAt = nowSec();
    this.playerState.set(p.id, st);

    if (this.config['team-color-enabled'] && this.config['green-tint-enabled']) await this.applyTint(p, true);
    await this.applyInfectedLoadout(p, !!opts.isFirst);
    await this.playSoundLocal(p, 'sound-become-zombie');
    this.omegga.middlePrint(p.name, '<b>You are <color="22ff22">INFECTED</>!</b>', 2);
  }

  async becomeSurvivor(playerRef) {
    const p = typeof playerRef === 'object' && playerRef.id ? playerRef : this.omegga.getPlayer(playerRef);
    if (!p) return;

    const st = this.playerState.get(p.id) || { name: p.name };
    st.survivalStartAt = nowSec();
    this.playerState.set(p.id, st);

    if (this.config['team-color-enabled'] && this.config['green-tint-enabled']) await this.applyTint(p, false);
    await this.applySurvivorLoadout(p);
    await this.playSoundLocal(p, 'sound-spawn-survivor');
    this.omegga.middlePrint(p.name, '<b>You are a <color="ffffff">SURVIVOR</>!</b>', 2);
  }

  async disableFirstBonus() {
    if (!this.firstInfectedId) return;
    try {
      const id = this.firstInfectedId;
      const st = this.playerState.get(id);
      if (!st) return;
      await this.applyInfectedLoadout({ id, name: st.name }, false);
      this.omegga.broadcast('<b><color="aaffaa">[Infected]</> First blood! Bonus weapon removed from the first infected.');
    } catch (e) { error('disableFirstBonus', e); }
  }

  async convertSurvivorToInfectedByName(name) {
    const p = this.omegga.getPlayer(name);
    if (!p) return;
    await this.becomeInfected({ id: p.id, name: p.name });
    try {
      if (typeof p.respawn === 'function') await p.respawn();
      else await this.omegga.exec?.(`Chat.Command Respawn "${p.name}"`);
    } catch(e) { error('force-respawn', e); }
    await this.playSoundLocal(p, 'sound-spawn-infected');
  }

  async applySurvivorLoadout(p) {
    try { await this.omegga.exec?.(`Chat.Command ClearInv "${p.name}"`); } catch(e) { error('clear-loadout', e); }
    const weapon = (this.config['survivor-weapon'] || '').trim();
    if (weapon) try { await this.omegga.exec?.(`Chat.Command Give "${p.name}" "${weapon}"`); } catch(e) { error('give-survivor-weapon', e); }
  }

  async applyInfectedLoadout(p, isFirst) {
    try { await this.omegga.exec?.(`Chat.Command ClearInv "${p.name}"`); } catch(e) { error('clear-loadout', e); }
    const knife = (this.config['infected-knife'] || '').trim();
    if (knife) try { await this.omegga.exec?.(`Chat.Command Give "${p.name}" "${knife}"`); } catch(e) { error('give-knife', e); }
    try { await this.omegga.exec?.(`Chat.Command LimitSlots "${p.name}" 1`); } catch(e) { error('limit-slot', e); }
    if (isFirst && !this.firstBloodHappened) {
      const bonus = (this.config['bonus-weapon'] || '').trim();
      if (bonus) try { await this.omegga.exec?.(`Chat.Command Give "${p.name}" "${bonus}"`); } catch(e) { error('give-bonus', e); }
    }
  }

  async applyTint(p, on) {
    if (!this.config['green-tint-enabled']) return;
    const amt = Math.max(0, Math.min(1, Number(this.config['green-tint-amount']) || 0.7));
    try {
      const val = on ? amt : 0;
      await this.omegga.exec?.(`Chat.Command Tint "${p.name}" ${val} 0.8 0.8`);
    } catch(e) { error('tint', e); }
  }

  async playSoundLocal(p, key) {
    if (!this.config['enable-sounds']) return;
    const sound = (this.config[key] || '').trim();
    if (!sound) return;
    try { await this.omegga.exec?.(`Chat.Command PlaySound "${p.name}" "${sound}"`); } catch(e) { error('play-sound', e); }
  }

  // ---- stats ----
  updateBestTime(id, name, seconds) {
    if (!id) return;
    const rec = this.stats.players[id] || { name, survivorKills: 0, zombieKills: 0, bestSurvival: 0, totalSurvival: 0, roundsPlayed: 0 };
    rec.bestSurvival = Math.max(rec.bestSurvival || 0, seconds || 0);
    rec.totalSurvival = (rec.totalSurvival || 0) + (seconds || 0);
    rec.roundsPlayed = (rec.roundsPlayed || 0) + 1;
    rec.name = name || rec.name;
    this.stats.players[id] = rec;
  }

  addKill(killerId, killerName, isZombieKill) {
    if (!this.config['enable-kill-tracking']) return;
    const rec = this.stats.players[killerId] || { name: killerName, survivorKills: 0, zombieKills: 0, bestSurvival: 0, totalSurvival: 0, roundsPlayed: 0 };
    if (isZombieKill) rec.zombieKills = (rec.zombieKills || 0) + 1;
    else rec.survivorKills = (rec.survivorKills || 0) + 1;
    rec.name = killerName || rec.name;
    this.stats.players[killerId] = rec;
  }
};
