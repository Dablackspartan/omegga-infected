
const { createMinigameFromJson } = require('./lib/create-minigame-from-json');

class Plugin {
  constructor(omegga, config, store) {
    this.omegga = omegga;
    this.config = config;
    this.store = store;
    this.state = { roundActive: false, firstBlood: false, infected: new Set(), survivors: new Set() };
  }

  async init() {
    // Register command handler for "!infected ..."
    this.omegga.on('cmd:infected', async (speaker, subcmd, ...rest) => {
      const sub = (subcmd || '').toLowerCase();
      try {
        if (sub === 'createminigame') {
          const msg = await createMinigameFromJson(this.omegga, this.config, this.omegga.logger || console);
          this.omegga.broadcast(`<b>Infected</> >> ${msg}`);
          if (this.config['start-on-create']) await this.startRound();
          return;
        }
        if (sub === 'status') return this.reportStatus(speaker);
        if (sub === 'startround') return await this.startRound();
        if (sub === 'endround') return await this.endRound('manual');
      } catch (e) {
        this.omegga.error(e?.stack || e?.message || String(e));
        this.omegga.broadcast(`<b>Infected</> >> failed: ${e?.message || e}`);
      }
    });

    return { registeredCommands: ['infected'] };
  }

  // --- Round control (minimal scaffolding; extend as needed) ---
  async startRound() {
    if (this.state.roundActive) return this.omegga.broadcast(`<b>Infected</> >> round already active`);
    this.state.roundActive = true;
    this.state.firstBlood = false;
    this.omegga.broadcast(`<b>Infected</> >> round started`);
  }

  async endRound(reason = 'ended') {
    if (!this.state.roundActive) return;
    this.state.roundActive = false;
    this.omegga.broadcast(`<b>Infected</> >> round ${reason}`);
  }

  reportStatus(target) {
    const r = this.state.roundActive ? 'active' : 'idle';
    this.omegga.whisper(target, `Infected status: round=${r}`);
  }

  async stop() {}
}

module.exports = Plugin;
