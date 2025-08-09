
const fs = require('fs');
const path = require('path');

const DATA_DIR = __dirname ? path.join(__dirname, 'data') : 'data';
const DEST_DIR = '/home/container/data/Saved/Presets/Minigame';
const PREFIX = '[Infected]';
function log(){ try{ console.log.apply(console, [PREFIX].concat([].slice.call(arguments))); }catch(e){} }

function sleep(ms){ return new Promise(function(res){ setTimeout(res, ms); }); }

function locatePresetSource(explicit){
  var exts = ['.json','.bp'];
  if (explicit){
    var p = path.isAbsolute(explicit) ? explicit : path.join(DATA_DIR, path.basename(explicit));
    if (fs.existsSync(p)) return p;
    var b = path.parse(p).name;
    for (var i=0;i<exts.length;i++){
      var q = path.join(DATA_DIR, b + exts[i]);
      if (fs.existsSync(q)) return q;
    }
  }
  var bases = ['Infected','infected','INFECTED'];
  for (var j=0;j<bases.length;j++){
    for (var k=0;k<exts.length;k++){
      var t = path.join(DATA_DIR, bases[j] + exts[k]);
      if (fs.existsSync(t)) return t;
    }
  }
  var list = fs.existsSync(DATA_DIR) ? fs.readdirSync(DATA_DIR) : [];
  for (var m=0;m<list.length;m++){
    var name = String(list[m]).toLowerCase();
    if (name.indexOf('.json')>=0 || name.indexOf('.bp')>=0){
      return path.join(DATA_DIR, list[m]);
    }
  }
  return null;
}

function basenameNoExt(p){
  if (!p) return 'Infected';
  var b = path.basename(p);
  if (b.toLowerCase().slice(-5) === '.json') return b.slice(0, -5);
  if (b.toLowerCase().slice(-3) === '.bp') return b.slice(0, -3);
  return b;
}

function ensureDir(p){
  if (!fs.existsSync(p)) fs.mkdirSync(p, {recursive:true});
}

function copyPreset(srcPath, name){
  ensureDir(DEST_DIR);
  var ext = path.extname(srcPath) || '.json';
  var out1 = path.join(DEST_DIR, name + ext);
  var out2 = path.join(DEST_DIR, name.toLowerCase() + ext);
  fs.copyFileSync(srcPath, out1);
  log('copied preset ->', out1);
  if (out2 !== out1){
    fs.copyFileSync(srcPath, out2);
    log('copied preset ->', out2);
  }
}

function writeln(omegga, cmd){
  if (omegga && typeof omegga.writeln === 'function') return omegga.writeln(cmd);
  return Promise.resolve('');
}

module.exports = class InfectedPlugin {
  constructor(omegga, config, store){
    this.omegga = omegga;
    this.config = config || {};
    this.store = store;
  }

  async init(){
    var self = this;
    this.omegga.on('chatcmd:infected', async function(speaker){
      var args = Array.prototype.slice.call(arguments, 1);
      var sub = (args[0]||'').toLowerCase();
      if (!sub){
        self.omegga.whisper(speaker, '[Infected] usage: !infected createminigame');
        return;
      }
      if (sub === 'createminigame'){
        await self.createMinigameCmd(speaker);
        return;
      }
      self.omegga.whisper(speaker, '[Infected] unknown subcommand: ' + sub);
    });

    return {registeredCommands: ['infected']};
  }

  async stop(){}

  async createMinigameCmd(speaker){
    var src = locatePresetSource(this.config['preset-source']);
    var name = this.config['minigame-name'] || basenameNoExt(src) || 'Infected';

    if (src){
      copyPreset(src, name);
    } else {
      this.omegga.whisper(speaker, '[Infected] no preset file found in /plugins/infected/data');
    }

    await sleep(1200);

    // Attempt loads, then fallback create
    await writeln(this.omegga, 'Server.Minigames.LoadPreset "Infected"');
    await sleep(300);
    await writeln(this.omegga, 'Server.Minigames.LoadPreset "' + name.replace(/"/g,'\\"') + '"');
    await sleep(300);
    await writeln(this.omegga, 'Minigame.Create "' + name.replace(/"/g,'\\"') + '"');
    await sleep(200);

    this.omegga.broadcast('[Infected] attempted to load/create "' + name + '". If not visible, run /writeln Server.Minigames.ListPresets');
  }
};
