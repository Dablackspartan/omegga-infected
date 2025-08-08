// omegga.plugin.js
// Infected / Zombies Gamemode for Brickadia via Omegga
// Node VM plugin (safe).
// Requirements: Omegga (Node VM), doc.json, access.json, plugin.json.
// This plugin aims to provide an "Infected" style round with minimal hard game-API assumptions.
// Some features (minigame creation, loadouts, sounds, tint) are implemented as best-effort + configurable no-ops.
// Everything is wrapped in try/catch and logs to the server console on error as requested.

/* eslint-disable no-undef */
const fs = require('fs');
const path = require('path');

const PLUGIN_NAME = 'infected';
const DATA_DIR = __dirname ? path.join(__dirname, 'data') : 'data';
const TEMPLATE_FILE = path.join(DATA_DIR, 'blank-minigame.json');
const STATS_KEY = 'infected_stats_v1';

function nowSec() { return Math.floor(Date.now() / 1000); }

/** Safe logger helpers */
function log(...args) { try { Omegga?.log?.(PLUGIN_NAME + ':', ...args); } catch (e) {} }
function warn(...args) { try { Omegga?.warn?.(PLUGIN_NAME + ':', ...args); } catch (e) {} }
function error(...args) { try { Omegga?.error?.(PLUGIN_NAME + ':', ...args); } catch (e) {} }

/** Helper to wrap async ops and always log errors */
async function safeTry(tag, fn) {
  try { return await fn(); }
  catch (e) { error(`[${tag}]`, e && e.stack ? e.stack : e); }
}

/** Random element from array */
function choice(arr) {
  if (!arr || !arr.length) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Normalize config defaults */
function withDefaults(cfg) {
  const c = Object.assign({
    'authorized-users': [],
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
    'team-color-enabled': true // alias for the user's "Team color. Tint green" ask
  }, cfg || {});
  // keep template path absolute within plugin dir if a relative path is used
  if (c['minigame-template'] && !path.isAbsolute(c['minigame-template'])) {
    c['minigame-template'] = path.join(DATA_DIR, path.basename(c['minigame-template']));
  }
  return c;
}

module.exports = class InfectedPlugin {
  /** @param {Omegga} omegga @param {Object} config @param {Store} store */
  constructor(omegga, config, store) {
    this.omegga = omegga;
    this.config = withDefaults(config);
    this.store = store;

    this.roundActive = false;
    this.roundEndAt = 0;
    this.roundTimer = null;
    this.firstBloodHappened = false;

    this.infectedById = new Set(); // UUIDs
    this.firstInfectedId = null;

    this.playerState = new Map(); // uuid -> { name, isDead, becameInfectedAt, survivalStartAt }
    this.stats = { players: {} }; // uuid -> { name, survivorKills, zombieKills, bestSurvival, totalSurvival, roundsPlayed }

    // cache of name->player object by tick
    this.playerByName = new Map();
  }

  // === Lifecycle ===
  async init() {
    log('initializing plugin...');

    // Ensure obvious blank file for minigame mapping
    await safeTry('ensure-template', async () => {
      if (!fs.existsSync(TEMPLATE_FILE)) {
        const blank = {
          name: "Infected_Minigrame_Template",
          description: "Replace this JSON with your own minigame preset if your server supports loading presets from file. This file is only a placeholder.",
          createdAt: new Date().toISOString(),
          teams: [
            { name: "Survivors", color: [1,1,1], capacity: 0 },
            { name: "Infected", color: [0.2, 0.8, 0.2], capacity: 0 }
          ],
          rules: {
            friendlyFire: false,
            allowRespawn: true
          }
        };
        fs.writeFileSync(TEMPLATE_FILE, JSON.stringify(blank, null, 2));
      }
    });

    // Load persistent stats
    await safeTry('load-stats', async () => {
      const s = await this.store.get(STATS_KEY);
      if (s && typeof s === 'object') this.stats = s;
    });

    // Listen to command
    this.omegga.on('chatcmd:infected', (speaker, ...args) => this.onCommand(speaker, args));

    // heartbeat to watch deaths and end-of-round
    this.roundTimer = setInterval(() => this.tick().catch(e => error('tick', e)), 500);

    log('initialized.');

    // Register slash command and return handlers to Omegga
    return { registeredCommands: ['infected'] };
  }

  async stop() {
    if (this.roundTimer) clearInterval(this.roundTimer);
    await safeTry('save-stats', async () => this.store.set(STATS_KEY, this.stats));
    log('stopped.');
  }

  // === Command handling ===
  async onCommand(speaker, args) {
    const sub = (args[0] || '').toLowerCase();
    if (!sub) return this.help(speaker);

    if (sub === 'status') return this.statusCmd(speaker);
    if (sub === 'createminigame') return this.createMinigameCmd(speaker);

    // You can also trigger rounds manually if needed
    if (sub === 'startround') return this.startRoundCmd(speaker);
    if (sub === 'endround') return this.endRoundCmd(speaker, 'forced');

    return this.help(speaker);
  }

  async help(speaker) {
    this.omegga.whisper(speaker, 'Infected plugin commands:');
    this.omegga.whisper(speaker, '!infected createminigame - create/setup minigame (admin only)');
    this.omegga.whisper(speaker, '!infected status - show current state');
    this.omegga.whisper(speaker, '!infected startround - start a round (admin only)');
    this.omegga.whisper(speaker, '!infected endround - end current round (admin only)');
  }

  // Simple auth check: allow Admins or listed users in config
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

    // Best-effort: attempt to create a new minigame using Omegga helpers or Chat.Command fallbacks.
    await safeTry('create-minigame', async () => {
      // Not all installs expose minigame creation helpers. Try a few options.
      // 1) If your Omegga has minigame APIs (recent versions claim support), try to use them.
      if (typeof this.omegga.createMinigame === 'function') {
        await this.omegga.createMinigame?.({ name: 'Infected', teams: ['Survivors', 'Infected'] });
      } else {
        // 2) Fallback: try a console Chat.Command that your build might support (safe no-op if unknown).
        // NOTE: You may need to adjust these for your server build.
        // Many servers allow a subset of chat commands to be callable from console via Chat.Command.
        // We try to ensure this is harmless if the command doesn't exist.
        await this.omegga.exec?.('Chat.Command Minigame.Create Infected');
        await this.omegga.exec?.('Chat.Command Minigame.AddTeam Infected Survivors');
        await this.omegga.exec?.('Chat.Command Minigame.AddTeam Infected Infected');
      }

      // Create or overwrite our template file path for you to replace later
      if (!fs.existsSync(this.config['minigame-template'])) {
        fs.copyFileSync(TEMPLATE_FILE, this.config['minigame-template']);
      }
    });

    this.omegga.broadcast('<b><color="aaffaa">[Infected]</> Minigame created (or verified).');
    if (this.config['start-on-create']) {
      await this.startRound();
    } else {
      this.omegga.broadcast('<b><color="aaffaa">[Infected]</> Use !infected startround to begin.');
    }
  }

  async statusCmd(speaker) {
    const secsLeft = Math.max(0, (this.roundEndAt || 0) - nowSec());
    const infectedCount = this.infectedById.size;
    const players = await this.getAlivePlayerList();
    const total = players.length;

    const lines = [
      `<b><color="aaffaa">[Infected]</> Round: ${this.roundActive ? 'ACTIVE' : 'idle'}`,
      `Players: ${total} | Infected: ${infectedCount} | Survivors: ${Math.max(0, total - infectedCount)}`,
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

  // === Round Mechanics ===
  async startRound() {
    if (this.roundActive) return;
    const players = await this.getAlivePlayerList();
    if (!players || players.length < 2) {
      this.omegga.broadcast('<b><color="ffaaaa">[Infected]</> Need at least 2 players to start.');
      return;
    }

    this.roundActive = true;
    this.firstBloodHappened = false;
    this.infectedById.clear();
    this.firstInfectedId = null;
    this.roundEndAt = nowSec() + Math.max(30, Number(this.config['round-seconds']) || 300);

    // Initialize per-player state
    for (const p of players) {
      this.playerState.set(p.id, { name: p.name, isDead: false, becameInfectedAt: 0, survivalStartAt: nowSec() });
    }

    // Pick first infected
    const first = choice(players);
    if (!first) return this.endRound('no players');
    await this.becomeInfected(first, { isFirst: true });

    // Everyone else = survivors
    for (const p of players) {
      if (p.id !== first.id) {
        await this.becomeSurvivor(p);
      }
    }

    this.omegga.broadcast(`<b><color="aaffaa">[Infected]</> Round started! Timer: ${this.config['round-seconds']}s.`);
  }

  async endRound(reason) {
    if (!this.roundActive) return;
    this.roundActive = false;

    // finalize survival times
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

    // cleanup internal state
    this.playerState.clear();
    this.infectedById.clear();
    this.firstInfectedId = null;
    this.firstBloodHappened = false;
    this.roundEndAt = 0;
  }

  async tick() {
    if (!this.roundActive) return;

    // Timer check
    if (this.roundEndAt && nowSec() >= this.roundEndAt) {
      return this.endRound('timer');
    }

    // Build a quick lookup of online players and isDead
    const pos = await safeTry('getAllPlayerPositions', async () => this.omegga.getAllPlayerPositions?.()) || [];
    const byName = new Map();
    for (const p of pos) {
      // p: { player: string, pos: [x,y,z], isDead: boolean }
      byName.set(p.player, p);
    }
    this.playerByName = byName;

    // Check transitions for each tracked player
    for (const [id, st] of this.playerState.entries()) {
      const name = st.name;
      const p = this.omegga.getPlayer(name);
      if (!p) continue;
      let aliveDead = false;
      try {
        const plog = byName.get(name);
        aliveDead = !!(plog && plog.isDead);
      } catch (_) {}

      // If this survivor died -> immediately convert to infected and (try to) respawn
      const isInfected = this.infectedById.has(id);
      if (!isInfected && aliveDead) {
        if (!this.firstBloodHappened) {
          this.firstBloodHappened = true;
          await this.disableFirstBonus();
        }
        await this.convertSurvivorToInfectedByName(name);
      }
    }

    // Check victory if no survivors left
    const survivorsLeft = [...this.playerState.keys()].filter(id => !this.infectedById.has(id)).length;
    if (survivorsLeft <= 0) {
      await this.endRound('all infected');
      return;
    }
  }

  /** Utility: returns list of connected players with id+name */
  async getAlivePlayerList() {
    const list = [];
    // getAllPlayerPositions contains all connected with names
    const pos = await safeTry('getAllPlayerPositions', async () => this.omegga.getAllPlayerPositions?.()) || [];
    for (const p of pos) {
      try {
        const pl = this.omegga.getPlayer(p.player);
        if (pl) list.push({ id: pl.id, name: pl.name || p.player });
      } catch (_) {}
    }
    return list;
  }

  // === Role/Loadout operations (best-effort and configurable no-ops) ===

  async becomeInfected(playerRef, opts = {}) {
    // playerRef: {id, name} or Omegga Player
    const p = typeof playerRef === 'object' && playerRef.id ? playerRef : this.omegga.getPlayer(playerRef);
    if (!p) return;
    this.infectedById.add(p.id);
    if (opts.isFirst) this.firstInfectedId = p.id;

    // Update survival start for infected (they stop surviving now)
    const st = this.playerState.get(p.id) || { name: p.name };
    if (st.survivalStartAt) {
      const survived = nowSec() - st.survivalStartAt;
      this.updateBestTime(p.id, p.name, survived);
    }
    st.becameInfectedAt = nowSec();
    this.playerState.set(p.id, st);

    // Visual / team tint
    if (this.config['team-color-enabled'] && this.config['green-tint-enabled']) {
      await this.applyTint(p, true);
    }

    // Equip
    await this.applyInfectedLoadout(p, !!opts.isFirst);

    // Sound
    await this.playSoundLocal(p, 'sound-become-zombie');

    // UI
    this.omegga.middlePrint(p.name, '<b>You are <color="22ff22">INFECTED</>!</b>', 2);
  }

  async becomeSurvivor(playerRef) {
    const p = typeof playerRef === 'object' && playerRef.id ? playerRef : this.omegga.getPlayer(playerRef);
    if (!p) return;

    // Start survival timer
    const st = this.playerState.get(p.id) || { name: p.name };
    st.survivalStartAt = nowSec();
    this.playerState.set(p.id, st);

    // Remove tint
    if (this.config['team-color-enabled'] && this.config['green-tint-enabled']) {
      await this.applyTint(p, false);
    }

    // Equip
    await this.applySurvivorLoadout(p);

    // Sound
    await this.playSoundLocal(p, 'sound-spawn-survivor');

    this.omegga.middlePrint(p.name, '<b>You are a <color="ffffff">SURVIVOR</>!</b>', 2);
  }

  async disableFirstBonus() {
    // best-effort: simply re-apply infected loadout without bonus to the first infected player
    if (!this.firstInfectedId) return;
    try {
      const p = [...(await this.getAlivePlayerList())].find(pl => pl.id === this.firstInfectedId);
      if (!p) return;
      await this.applyInfectedLoadout(p, false);
      this.omegga.broadcast('<b><color="aaffaa">[Infected]</> First blood! Bonus weapon removed from the first infected.');
    } catch (e) { error('disableFirstBonus', e); }
  }

  async convertSurvivorToInfectedByName(name) {
    const p = this.omegga.getPlayer(name);
    if (!p) return;

    await this.becomeInfected({ id: p.id, name: p.name });

    // Try to force a respawn (some builds respawn on death automatically)
    await safeTry('force-respawn', async () => {
      if (typeof p.respawn === 'function') await p.respawn();
      else await this.omegga.exec?.(`Chat.Command Respawn "${p.name}"`);
    });

    await this.playSoundLocal(p, 'sound-spawn-infected');
  }

  // === Loadouts / Tint / Sound (best-effort implementations) ===

  async applySurvivorLoadout(p) {
    await safeTry('clear-loadout', async () => {
      await this.omegga.exec?.(`Chat.Command ClearInv "${p.name}"`);
    });
    const weapon = (this.config['survivor-weapon'] || '').trim();
    if (weapon) {
      await safeTry('give-survivor-weapon', async () => {
        await this.omegga.exec?.(`Chat.Command Give "${p.name}" "${weapon}"`);
      });
    }
  }

  async applyInfectedLoadout(p, isFirst) {
    await safeTry('clear-loadout', async () => {
      await this.omegga.exec?.(`Chat.Command ClearInv "${p.name}"`);
    });

    const knife = (this.config['infected-knife'] || '').trim();
    if (knife) {
      await safeTry('give-knife', async () => {
        await this.omegga.exec?.(`Chat.Command Give "${p.name}" "${knife}"`);
      });
    }

    // one slot only - best effort (depends on server commands availability)
    await safeTry('limit-slot', async () => {
      await this.omegga.exec?.(`Chat.Command LimitSlots "${p.name}" 1`);
    });

    // Temporary bonus for first infected until first blood
    if (isFirst && !this.firstBloodHappened) {
      const bonus = (this.config['bonus-weapon'] || '').trim();
      if (bonus) {
        await safeTry('give-bonus', async () => {
          await this.omegga.exec?.(`Chat.Command Give "${p.name}" "${bonus}"`);
        });
      }
    }
  }

  async applyTint(p, on) {
    if (!this.config['green-tint-enabled']) return;
    const amt = Math.max(0, Math.min(1, Number(this.config['green-tint-amount']) || 0.7));
    // Attempt to use a hypothetical team color/tint console command
    await safeTry('tint', async () => {
      const val = on ? amt : 0;
      await this.omegga.exec?.(`Chat.Command Tint "${p.name}" ${val} 0.8 0.8`);
    });
  }

  async playSoundLocal(p, key) {
    if (!this.config['enable-sounds']) return;
    const sound = (this.config[key] || '').trim();
    if (!sound) return;
    await safeTry('play-sound', async () => {
      await this.omegga.exec?.(`Chat.Command PlaySound "${p.name}" "${sound}"`);
    });
  }

  // === Stats ===

  updateBestTime(id, name, seconds) {
    if (!id) return;
    const rec = this.stats.players[id] || { name, survivorKills: 0, zombieKills: 0, bestSurvival: 0, totalSurvival: 0, roundsPlayed: 0 };
    rec.bestSurvival = Math.max(rec.bestSurvival || 0, seconds || 0);
    rec.totalSurvival = (rec.totalSurvival || 0) + (seconds || 0);
    rec.roundsPlayed = (rec.roundsPlayed || 0) + 1;
    rec.name = name || rec.name;
    this.stats.players[id] = rec;
  }

  // NOTE: Kill tracking is optional; not all builds expose a friendly killfeed/parsing option.
  // Leave disabled by default; feel free to hook your own event and call addKill().
  addKill(killerId, killerName, isZombieKill) {
    if (!this.config['enable-kill-tracking']) return;
    const rec = this.stats.players[killerId] || { name: killerName, survivorKills: 0, zombieKills: 0, bestSurvival: 0, totalSurvival: 0, roundsPlayed: 0 };
    if (isZombieKill) rec.zombieKills = (rec.zombieKills || 0) + 1;
    else rec.survivorKills = (rec.survivorKills || 0) + 1;
    rec.name = killerName || rec.name;
    this.stats.players[killerId] = rec;
  }
};
