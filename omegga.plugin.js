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
  return arr[Math.floor(Math.random() * arr.length)];
}

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

    this.playerByName = new Map();
  }

  async init() {
    log('initializing plugin...');

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
          rules: { friendlyFire: false, allowRespawn: true }
        };
        fs.writeFileSync(TEMPLATE_FILE, JSON.stringify(blank, null, 2));
      }
    });

    await safeTry('load-stats', async () => {
      const s = await this.store.get(STATS_KEY);
      if (s && typeof s === 'object') this.stats = s;
    });

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

  async onJoin(player) {
    try {
      if (!this.roundActive) return;
      if (!this.config['mid-join-assign-infected']) return;
      if (!player || !player.id || !player.name) return;

      // Skip if we already marked them infected this round
      if (this.playerState.has(player.id) && this.infectedById.has(player.id)) return;

      // Track and convert shortly after join so they’re fully spawned
      this.playerState.set(player.id, { name: player.name, isDead: false, becameInfectedAt: 0, survivalStartAt: 0 });
      setTimeout(() => {
        this.becomeInfected({ id: player.id, name: player.name }).catch(e => error('onJoin->becomeInfected', e));
        this.omegga.whisper(player.name, '<b><color="22ff22">[Infected]</> You joined mid-round and were added to the Infected.</b>');
      }, 1000);
    } catch (e) {
      error('onJoin', e);
    }
  }

  async onCommand(speaker, args) {
    const sub = (args[0] || '').toLowerCase();
    if (!sub) return this.help(speaker);

    if (sub === 'status') return this.statusCmd(speaker);
    if (sub === 'createminigame') return this.createMinigameCmd(speaker);

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

    const name = 'Infected';
    const teams = ['Survivors', 'Infected'];

    const attempts = [
      async () => {
        log('createMinigame: trying direct console commands...');
        await this.omegga.exec?.(`Minigame.Create "${name}"`);
        for (const t of teams) {
          await this.omegga.exec?.(`Minigame.AddTeam "${name}" "${t}"`);
        }
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
        await this.omegga.exec?.(`Chat.Command Minigame.Create "${name}"`);
        for (const t of teams) {
          await this.omegga.exec?.(`Chat.Command Minigame.AddTeam "${name}" "${t}"`);
        }
      },
    ];

    let ok = false;
    for (const attempt of attempts) {
      try { await attempt(); ok = true; break; }
      catch (e) { error('createMinigame attempt failed', e); }
    }

    if (!ok) {
      this.omegga.broadcast('<b><color="ff6666">[Infected]</> Failed to create minigame. Check console for errors.');
      return;
    }

    await safeTry('ensure-template-copy', async () => {
      if (!fs.existsSync(this.config['minigame-template'])) {
        fs.copyFileSync(TEMPLATE_FILE, this.config['minigame-template']);
      }
    });

    this.omegga.broadcast('<b><color="aaffaa">[Infected]</> Minigame created (or already existed).');

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

    for (const p of players) {
      this.playerState.set(p.id, { name: p.name, isDead: false, becameInfectedAt: 0, survivalStartAt: nowSec() });
    }

    const first = choice(players);
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

    const pos = await safeTry('getAllPlayerPositions', async () => this.omegga.getAllPlayerPositions?.()) || [];
    const byName = new Map();
    for (const p of pos) byName.set(p.player, p);
    this.playerByName = byName;

    for (const [id, st] of this.playerState.entries()) {
      const name = st.name;
      const p = this.omegga.getPlayer(name);
      if (!p) continue;
      let aliveDead = false;
      try {
        const plog = byName.get(name);
        aliveDead = !!(plog && plog.isDead);
      } catch (_) {}

      const isInfected = this.infectedById.has(id);
      if (!isInfected && aliveDead) {
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

  async getAlivePlayerList() {
    const list = [];
    const pos = await safeTry('getAllPlayerPositions', async () => this.omegga.getAllPlayerPositions?.()) || [];
    for (const p of pos) {
      try {
        const pl = this.omegga.getPlayer(p.player);
        if (pl) list.push({ id: pl.id, name: pl.name || p.player });
      } catch (_) {}
    }
    return list;
  }

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
