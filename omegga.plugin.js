// omegga.plugin.js
// Infected / Zombies Gamemode for Brickadia via Omegga (Node VM safe)
/* eslint-disable no-undef */
const fs = require('fs');
const path = require('path');

const PLUGIN_NAME = 'infected';
const DATA_DIR = __dirname ? path.join(__dirname, 'data') : 'data';
const TEMPLATE_FILE = path.join(DATA_DIR, 'blank-minigame.json');
const STATS_KEY = 'infected_stats_v1';

function nowSec() { return Math.floor(Date.now() / 1000); }

function log(...args) { try { Omegga?.log?.(PLUGIN_NAME + ':', ...args); } catch (e) {} }
function warn(...args) { try { Omegga?.warn?.(PLUGIN_NAME + ':', ...args); } catch (e) {} }
function error(...args) { try { Omegga?.error?.(PLUGIN_NAME + ':', ...args); } catch (e) {} }

async function safeTry(tag, fn) {
  try { return await fn(); }
  catch (e) { error(`[${tag}]`, e && e.stack ? e.stack : e); }
}

function choice(arr) {
  if (!arr || !arr.length) return null;
  return Math.floor(Math.random() * arr.length);
}

function withDefaults(cfg) {
  const c = Object.assign({
    'authorized-users': [],
    'minigame-name': 'Infected',
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
    'minigame-template': 'data/blank-minigame.json',
    'timer-visible': true,
    'start-on-create': true,
    'enable-kill-tracking': false,
    'team-color-enabled': true,
    'mid-join-assign-infected': true
  }, cfg || {});
  if (c['minigame-template'] && !path.isAbsolute(c['minigame-template'])) {
    c['minigame-template'] = path.join(DATA_DIR, path.basename(c['minigame-template']));
  }
  return c;
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

    this.boundMinigame = null; // {index, name} when detected
  }

  // ---- helpers for exec and minigame discovery ----
  async execOut(cmd) {
    try { return await this.omegga.exec?.(cmd); } catch { return ''; }
  }

  looksLikeError(out='') {
    return /unknown|invalid|error|usage|not found|failed/i.test(String(out));
  }

  async listMinigames() {
    // Uses Server.Minigames.List (modern builds). Gracefully returns [] if unsupported.
    const out = await this.execOut('Server.Minigames.List');
    const lines = String(out || '').split(/\r?\n/);
    const list = [];
    for (const line of lines) {
      // Try to parse formats like:
      // "[0] Infected", "0: Infected", "0 - Infected"
      const m = line.match(/(?:\[)?(\d+)(?:\])?[^A-Za-z0-9_-]*([A-Za-z0-9 ._\-\[\]\(\)]+)/);
      if (m) list.push({ index: Number(m[1]), name: m[2].trim() });
    }
    return list;
  }

  async ensureExistsByName(targetName) {
    const list = await this.listMinigames();
    const hit = list.find(m => m.name.toLowerCase() === targetName.toLowerCase());
    return hit || null;
  }

  async ensureBoundMinigame() {
    const name = (this.config['minigame-name'] || 'Infected').trim() || 'Infected';
    const hit = await this.ensureExistsByName(name);
    if (hit) {
      this.boundMinigame = hit;
      log('bound to existing minigame:', hit.index, hit.name);
      return true;
    }
    return false;
  }

  // ---- lifecycle ----
  async init() {
    log('initializing plugin...');

    await safeTry('ensure-template', async () => {
      const exists = fs.existsSync(TEMPLATE_FILE);
      if (!exists) {
        const blank = {
          name: "Infected_Minigrame_Template",
          description: "Replace this JSON with your own minigame preset if your server supports loading presets from file. This file is only a placeholder.",
          createdAt: new Date().toISOString(),
          teams: [
            { name: "Survivors", color: [1,1,1], capacity: 0 },
            { name: "Infected", color: [0.2, 0.8, 0.2], capacity: 0 }
          ],
          rules: { friendlyFire: false, allowRespawn: true }
        };
        fs.writeFileSync(TEMPLATE_FILE, JSON.stringify(blank, null, 2));
      }
    });

    await safeTry('load-stats', async () => {
      const s = await this.store.get(STATS_KEY);
      if (s && typeof s === 'object') this.stats = s;
    });

    // Auto-bind if a minigame named "Infected" (or config name) already exists
    await this.ensureBoundMinigame();

    // Commands
    this.omegga.on('chatcmd:infected', (speaker, ...args) => this.onCommand(speaker, args));

    // Mid-round join handling
    this.omegga.on('join', (player) => this.onJoin(player));

    // Tick loop
    this.roundTimer = setInterval(() => this.tick().catch(e => error('tick', e)), 500);

    log('initialized.');
    return { registeredCommands: ['infected'] };
  }

  async stop() {
    if (this.roundTimer) clearInterval(this.roundTimer);
    await safeTry('save-stats', async () => this.store.set(STATS_KEY, this.stats));
    log('stopped.');
  }

  // ---- events ----
  async onJoin(player) {
    try {
      if (!this.roundActive) return;
      if (!this.config['mid-join-assign-infected']) return;
      if (!player || !player.id || !player.name) return;

      // Track and convert shortly after join so they’re fully spawned
      if (!this.playerState.has(player.id)) this.playerState.set(player.id, { name: player.name, isDead: false, becameInfectedAt: 0, survivalStartAt: 0 });
      setTimeout(() => {
        this.becomeInfected({ id: player.id, name: player.name }).catch(e => error('onJoin->becomeInfected', e));
        this.omegga.whisper(player.name, '<b><color="22ff22">[Infected]</> You joined mid-round and were added to the Infected.</b>');
      }, 1000);
    } catch (e) {
      error('onJoin', e);
    }
  }

  // ---- commands ----
  async onCommand(speaker, args) {
    const sub = (args[0] || '').toLowerCase();
    if (!sub) return this.help(speaker);

    if (sub === 'status') return this.statusCmd(speaker);
    if (sub === 'createminigame') return this.createMinigameCmd(speaker);
    if (sub === 'bindminigame') return this.bindMinigameCmd(speaker, args[1]);

    if (sub === 'startround') return this.startRoundCmd(speaker);
    if (sub === 'endround') return this.endRoundCmd(speaker, 'forced');

    return this.help(speaker);
  }

  async help(speaker) {
    this.omegga.whisper(speaker, 'Infected plugin commands:');
    this.omegga.whisper(speaker, '!infected createminigame - create/setup or bind to minigame (admin only)');
    this.omegga.whisper(speaker, '!infected bindminigame <index> - bind to existing minigame (admin only)');
    this.omegga.whisper(speaker, '!infected status - show current state');
    this.omegga.whisper(speaker, '!infected startround - start a round (admin only)');
    this.omegga.whisper(speaker, '!infected endround - end current round (admin only)');
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
      return this.omegga.whisper(speaker, 'You are not authorized to do that.');
    }

    const name = (this.config['minigame-name'] || 'Infected').trim() || 'Infected';
    const teams = ['Survivors', 'Infected'];

    // If it already exists, bind and move on
    const existing = await this.ensureExistsByName(name);
    if (existing) {
      this.boundMinigame = existing;
      this.omegga.broadcast(`<b><color="aaffaa">[Infected]</> Minigame "${name}" exists (index ${existing.index}). Bound to it.`);
    } else {
      // Try 3 creation paths, verify after each
      const attempts = [
        async () => {
          log('createMinigame: trying direct console commands...');
          const a = await this.execOut(`Minigame.Create "${name}"`);
          const b = await this.execOut(`Minigame.AddTeam "${name}" "${teams[0]}"`);
          const c = await this.execOut(`Minigame.AddTeam "${name}" "${teams[1]}"`);
          if (this.looksLikeError(a+b+c)) throw new Error('Minigame.Create path failed');
        },
        async () => {
          if (typeof this.omegga.createMinigame === 'function') {
            log('createMinigame: trying omegga.createMinigame API...');
            await this.omegga.createMinigame?.({ name, teams });
          } else {
            throw new Error('createMinigame API not available');
          }
        },
        async () => {
          log('createMinigame: trying Chat.Command fallback...');
          const a = await this.execOut(`Chat.Command Minigame.Create "${name}"`);
          const b = await this.execOut(`Chat.Command Minigame.AddTeam "${name}" "${teams[0]}"`);
          const c = await this.execOut(`Chat.Command Minigame.AddTeam "${name}" "${teams[1]}"`);
          if (this.looksLikeError(a+b+c)) throw new Error('Chat.Command path failed');
        },
      ];

      let ok = false;
      for (const attempt of attempts) {
        try {
          await attempt();
          const hit = await this.ensureExistsByName(name);
          if (hit) { this.boundMinigame = hit; ok = true; break; }
        } catch (e) { error('createMinigame attempt failed', e); }
      }

      if (!ok) {
        this.omegga.broadcast(`<b><color="ff6666">[Infected]</> Could not create minigame "${name}". Create it in UI once, then run <b>!infected bindminigame &lt;index&gt;</b>.`);
        return;
      }
    }

    await safeTry('ensure-template-copy', async () => {
      if (!fs.existsSync(this.config['minigame-template'])) {
        fs.copyFileSync(TEMPLATE_FILE, this.config['minigame-template']);
      }
    });

    this.omegga.broadcast(`<b><color="aaffaa">[Infected]</> Minigame ready: <b>${name}</b>.`);
    if (this.config['start-on-create']) await this.startRound();
    else this.omegga.broadcast('<b><color="aaffaa">[Infected]</> Use !infected startround to begin.');
  }

  async bindMinigameCmd(speaker, idx) {
    if (!(await this.isAuthorizedByName(speaker))) {
      return this.omegga.whisper(speaker, 'You are not authorized to do that.');
    }
    const list = await this.listMinigames();
    if (!list.length) return this.omegga.whisper(speaker, 'No minigames found. Create one in the UI, then try again.');
    const i = Number(idx);
    if (!Number.isInteger(i)) return this.omegga.whisper(speaker, 'Usage: !infected bindminigame <index>');
    const hit = list.find(m => m.index === i);
    if (!hit) return this.omegga.whisper(speaker, `No minigame at index ${i}.`);
    this.config['minigame-name'] = hit.name;
    this.boundMinigame = hit;
    this.omegga.broadcast(`<b><color="aaffaa">[Infected]</> Bound to minigame "${hit.name}" (index ${i}).`);
  }

  async statusCmd(speaker) {
    const secsLeft = Math.max(0, (this.roundEndAt || 0) - nowSec());
    const infectedCount = this.infectedById.size;
    const total = this.playerState.size;
    const mg = this.boundMinigame ? `#${this.boundMinigame.index} "${this.boundMinigame.name}"` : 'none';

    const lines = [
      `<b><color="aaffaa">[Infected]</> Round: ${this.roundActive ? 'ACTIVE' : 'idle'} | Minigame: ${mg}`,
      `Players tracked: ${total} | Infected: ${infectedCount} | Survivors: ${Math.max(0, total - infectedCount)}`,
      `Timer: ${this.roundActive ? secsLeft + 's remaining' : 'n/a'}`
    ];
    for (const line of lines) this.omegga.whisper(speaker, line);
  }

  async startRoundCmd(speaker) {
    if (!(await this.isAuthorizedByName(speaker))) {
      return this.omegga.whisper(speaker, 'You are not authorized to do that.');
    }
    await this.startRound();
  }

  async endRoundCmd(speaker, why = 'forced') {
    if (!(await this.isAuthorizedByName(speaker))) {
      return this.omegga.whisper(speaker, 'You are not authorized to do that.');
    }
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

    // Initialize player state
    this.playerState.clear();
    for (const p of pos) {
      const pl = this.omegga.getPlayer(p.player);
      if (pl?.id) this.playerState.set(pl.id, { name: pl.name || p.player, isDead: false, becameInfectedAt: 0, survivalStartAt: nowSec() });
    }

    const players = [...this.playerState.keys()].map(id => ({ id, name: this.playerState.get(id).name }));
    const idx = choice(players);
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

    await safeTry('save-stats', async () => this.store.set(STATS_KEY, this.stats));

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

    // Detect deaths via getAllPlayerPositions when available
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
    await safeTry('force-respawn', async () => {
      if (typeof p.respawn === 'function') await p.respawn();
      else await this.omegga.exec?.(`Chat.Command Respawn "${p.name}"`);
    });
    await this.playSoundLocal(p, 'sound-spawn-infected');
  }

  async applySurvivorLoadout(p) {
    await safeTry('clear-loadout', async () => this.omegga.exec?.(`Chat.Command ClearInv "${p.name}"`));
    const weapon = (this.config['survivor-weapon'] || '').trim();
    if (weapon) await safeTry('give-survivor-weapon', async () => this.omegga.exec?.(`Chat.Command Give "${p.name}" "${weapon}"`));
  }

  async applyInfectedLoadout(p, isFirst) {
    await safeTry('clear-loadout', async () => this.omegga.exec?.(`Chat.Command ClearInv "${p.name}"`));
    const knife = (this.config['infected-knife'] || '').trim();
    if (knife) await safeTry('give-knife', async () => this.omegga.exec?.(`Chat.Command Give "${p.name}" "${knife}"`));
    await safeTry('limit-slot', async () => this.omegga.exec?.(`Chat.Command LimitSlots "${p.name}" 1`));
    if (isFirst && !this.firstBloodHappened) {
      const bonus = (this.config['bonus-weapon'] || '').trim();
      if (bonus) await safeTry('give-bonus', async () => this.omegga.exec?.(`Chat.Command Give "${p.name}" "${bonus}"`));
    }
  }

  async applyTint(p, on) {
    if (!this.config['green-tint-enabled']) return;
    const amt = Math.max(0, Math.min(1, Number(this.config['green-tint-amount']) || 0.7));
    await safeTry('tint', async () => {
      const val = on ? amt : 0;
      await this.omegga.exec?.(`Chat.Command Tint "${p.name}" ${val} 0.8 0.8`);
    });
  }

  async playSoundLocal(p, key) {
    if (!this.config['enable-sounds']) return;
    const sound = (this.config[key] || '').trim();
    if (!sound) return;
    await safeTry('play-sound', async () => this.omegga.exec?.(`Chat.Command PlaySound "${p.name}" "${sound}"`));
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
