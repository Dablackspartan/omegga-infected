
// Infected / Zombies (Omegga) — clean JSON-first build
const fs = require('fs');
const path = require('path');

const PLUGIN_PREFIX = '[Infected]';
const DATA_DIR = __dirname ? path.join(__dirname, 'data') : 'data';
const DEST_DIR = '/home/container/data/Saved/Presets/Minigame';

function log(){ try { console.log.apply(console, [PLUGIN_PREFIX].concat([].slice.call(arguments))); } catch(_){} }
function warn(){ try { console.warn.apply(console, [PLUGIN_PREFIX].concat([].slice.call(arguments))); } catch(_){} }
function error(){ try { console.error.apply(console, [PLUGIN_PREFIX].concat([].slice.call(arguments))); } catch(_){} }

function sleep(ms){ return new Promise(res => setTimeout(res, ms)); }

function locatePresetSource(explicit){
  var exts = ['.json', '.bp'];
  if (explicit){
    var p = path.isAbsolute(explicit) ? explicit : path.join(DATA_DIR, path.basename(explicit));
    if (fs.existsSync(p)) return p;
    var base = path.parse(p).name;
    for (var i=0;i<exts.length;i++){
      var q = path.join(DATA_DIR, base + exts[i]);
      if (fs.existsSync(q)) return q;
    }
    warn('configured preset-source not found:', p);
  }
  var bases = ['Infected','infected','INFECTED'];
  for (var b=0;b<bases.length;b++){
    for (var i=0;i<exts.length;i++){
      var q = path.join(DATA_DIR, bases[b] + exts[i]);
      if (fs.existsSync(q)) return q;
    }
  }
  try {
    var files = fs.readdirSync(DATA_DIR);
    for (var i=0;i<exts.length;i++){
      for (var f=0; f<files.length; f++){
        var name = String(files[f]).toLowerCase();
        if (name.endsWith(exts[i])){
          var p = path.join(DATA_DIR, files[f]);
          warn('using first preset found in /data:', files[f]);
          return p;
        }
      }
    }
  } catch(_){}
  return null;
}

function getPresetName(resolvedPath, fallback){
  if (fallback && String(fallback).trim().length) return String(fallback).trim();
  if (resolvedPath){
    var b = path.basename(resolvedPath);
    return b.replace(/\.(bp|json)$/i, '');
  }
  return 'Infected';
}

function ensureDir(p){
  try { fs.mkdirSync(p, {recursive:true}); } catch(_){}
}

function copyPresetToDest(srcPath, destDir, name){
  var ext = path.extname(srcPath) || '.json';
  var variants = Array.from(new Set([
    name + ext,
    name.toLowerCase() + ext,
    name.charAt(0).toUpperCase() + name.slice(1) + ext,
    'Infected' + ext,
    'infected' + ext
  ]));
  var copied = [];
  ensureDir(destDir);
  for (var i=0;i<variants.length;i++){
    var dest = path.join(destDir, variants[i]);
    try { fs.copyFileSync(srcPath, dest); copied.push(dest); log('copied preset ->', dest); } catch(e){ warn('copy failed', dest, e && e.message); }
  }
  return copied;
}

function stripOut(s){
  s = String(s || '');
  try { s = s.replace(/\x1b\[[0-9;]*m/g, ''); } catch(_){}
  try { s = s.replace(/\u001b\[[0-9;]*m/g, ''); } catch(_){}
  s = s.replace(/\r/g, '');
  s = s.replace(/[^\S\r\n]+$/gm, '');
  s = s.replace(/^\s*minigameevents\s*>>\s*/gmi, '');
  return s.trim();
}

function execOut(omegga, cmd){
  if (omegga && typeof omegga.writeln === 'function') {
    return omegga.writeln(cmd).then(function(out){ return out; }, function(e){
      warn('execOut failed', cmd, e && e.message ? e.message : String(e || ''));
      return '';
    });
  }
  return Promise.resolve('');
}

async function listPresetNames(omegga){
  var out = await execOut(omegga, 'Server.Minigames.ListPresets');
  out = stripOut(out);
  var lines = out.split('\n').map(function(x){ return x.trim(); }).filter(function(x){ return x.length>0; });
  // Try to pull names out of bullet lists or plain lines
  var names = [];
  for (var i=0;i<lines.length;i++){
    var line = lines[i];
    var m = line.match(/^-+\s*(.+)$/);
    if (m && m[1]) names.push(m[1].trim());
    else names.push(line);
  }
  // Dedup & sanitize
  var seen = {};
  var uniq = [];
  for (var i=0;i<names.length;i++){
    var k = names[i].toLowerCase();
    if (!seen[k]){ seen[k]=1; uniq.push(names[i]); }
  }
  return uniq;
}

module.exports = class InfectedPlugin {
  constructor(omegga, config, store){
    this.omegga = omegga;
    this.config = config || {};
    this.store = store;
    this.boundMinigame = null;
    this.resolvedPresetPath = null;
  }

  async init(){
    // command: !infected createminigame
    this.omegga.on('chatcmd:infected', async (speaker, ...args) => {
      const sub = (args[0] || '').toLowerCase();
      if (!sub) { this.omegga.whisper(speaker, '[Infected] usage: !infected createminigame'); return; }
      if (sub === 'createminigame') { await this.createMinigameCmd(speaker); return; }
      this.omegga.whisper(speaker, '[Infected] unknown subcommand: ' + sub);
    });

    return {registeredCommands: ['infected']};
  }

  async stop(){}

  async createMinigameCmd(playerName){
  var src = locatePresetSource(this.config['preset-source']);
  if (!src){
    // guarantee a placeholder json
    var blank = path.join(DATA_DIR, 'Infected.json');
    try{
      if (!fs.existsSync(blank)){
        fs.writeFileSync(blank, JSON.stringify({"formatVersion":1,"presetVersion":1,"data":{"rulesetSettings":{"rulesetName":"Infected"}}}, null, 2));
        warn('created placeholder data/Infected.json');
      }
    } catch(e){ warn('could not create placeholder', e && e.message ? e.message : String(e||'')); }
    src = blank;
  }
  this.resolvedPresetPath = src;
  var name = getPresetName(src, this.config['minigame-name']);

  copyPresetToDest(src, DEST_DIR, name);
  await sleep(1500);

  var candidates = [name, name.toLowerCase(), name.charAt(0).toUpperCase()+name.slice(1), 'Infected','infected'];
  // include rulesetName if present
  try{
    var txt = fs.readFileSync(src, 'utf-8');
    var j = JSON.parse(txt);
    if (j && j.data && j.data.rulesetSettings && j.data.rulesetSettings.rulesetName){
      var rn = String(j.data.rulesetSettings.rulesetName);
      candidates.push(rn, rn.toLowerCase());
    }
  } catch(_){}

  // include any "infected*" from server list
  try{
    var listed = await listPresetNames(this.omegga);
    for (var i=0;i<listed.length;i++){
      if (String(listed[i]).toLowerCase().indexOf('infected') !== -1) candidates.push(listed[i]);
    }
  } catch(_){}

  // dedup
  var seen = {}; var uniq = [];
  for (var i=0;i<candidates.length;i++){
    var k = String(candidates[i]||'').trim();
    if (!k) continue;
    var low = k.toLowerCase();
    if (!seen[low]){ seen[low]=1; uniq.push(k); }
  }
  candidates = uniq;

  this.omegga.broadcast('[Infected] trying candidates: ' + candidates.join(', '));

  // Try to load each candidate
  for (var i=0;i<candidates.length;i++){
    var n = candidates[i];
    await execOut(this.omegga, 'Server.Minigames.LoadPreset "' + n.replace(/"/g,'\\"') + '"');
    await sleep(300);
  }

  // Fallback: create if not found
  await execOut(this.omegga, 'Minigame.Create "' + name.replace(/"/g,'\\"') + '"');
  await sleep(200);

  this.omegga.broadcast('[Infected] preset copied; attempted load/create for "' + name + '". If not visible, run /writeln Server.Minigames.ListPresets to confirm.');
}
      } catch(e){ warn('could not create placeholder', e && e.message); }
      src = blank;
    }
    this.resolvedPresetPath = src;
    var name = getPresetName(src, this.config['minigame-name']);

    copyPresetToDest(src, DEST_DIR, name);
    await sleep(1200);

    // Try to load by several candidates
    var candidates = [name, name.toLowerCase(), name.charAt(0).toUpperCase()+name.slice(1), 'Infected','infected'];
    try {
      // include rulesetName if present
      try{
        var txt = fs.readFileSync(src, 'utf-8');
        var j = JSON.parse(txt);
        if (j && j.data && j.data.rulesetSettings && j.data.rulesetSettings.rulesetName){
          var rn = String(j.data.rulesetSettings.rulesetName);
          candidates.push(rn, rn.toLowerCase());
        }
      } catch(_){}
      // include what the server lists
      try{
        var listed = await listPresetNames(this.omegga);
        for (var i=0;i<listed.length;i++){
          if (listed[i].toLowerCase().indexOf('infected') !== -1) candidates.push(listed[i]);
        }
      } catch(_){}
      // dedup
      var seen = {}; var uniq = [];
      for (var i=0;i<candidates.length;i++){
        var k = String(candidates[i]||'').trim();
        if (!k) continue;
        var low = k.toLowerCase();
        if (!seen[low]){ seen[low]=1; uniq.push(k); }
      }
      candidates = uniq;
      // try loads
      for (var i=0;i<candidates.length;i++){
        var n = candidates[i];
        var out = await execOut(this.omegga, 'Server.Minigames.LoadPreset "' + n.replace(/"/g,'\\"') + '"');
        if (!out) await sleep(200);
      }
      this.omegga.whisper(playerName, '[Infected] copied preset and attempted to load: ' + candidates.join(', '));
    } catch(e){
      warn('load attempt failed', e && e.message);
    }
  }
};
