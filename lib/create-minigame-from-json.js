
const fs = require('fs');
const path = require('path');

function resolvePresetDirs() {
  const cwd = process.cwd();
  const dirs = [
    path.resolve(cwd, 'Brickadia/Saved/Presets/Minigames'),
    path.resolve(cwd, 'Saved/Presets/Minigames'),
    '/home/container/Brickadia/Saved/Presets/Minigames',
    '/home/container/Saved/Presets/Minigames',
  ];
  return Array.from(new Set(dirs));
}

function copyTemplateToPreset(templateRelPath, desiredName) {
  const templatePath = path.resolve(__dirname, '..', templateRelPath);
  if (!fs.existsSync(templatePath)) {
    throw new Error(`template not found: ${templateRelPath} (resolved ${templatePath})`);
  }
  const raw = fs.readFileSync(templatePath, 'utf-8');
  let json;
  try { json = JSON.parse(raw); } catch {
    throw new Error(`template is not valid JSON: ${templateRelPath}`);
  }
  const name = desiredName || 'Infected';
  // Normalize internal name so server lookups succeed
  if (json?.data?.rulesetSettings) {
    json.data.rulesetSettings.rulesetName = name;
  }
  const payload = JSON.stringify(json, null, 2);

  const written = [];
  for (const dir of resolvePresetDirs()) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const dst = path.join(dir, `${name}.bp`);
      fs.writeFileSync(dst, payload, 'utf-8');
      written.push(dst);
    } catch (_) { /* ignore */ }
  }
  if (written.length === 0) throw new Error('could not write preset to any known Presets/Minigames folder');
  return { name, written };
}

async function createMinigameFromJson(omegga, config, logger = console) {
  const templateRel = config['minigame-template'] || 'data/Infected.json';
  const targetName = config['minigame-name'] || 'Infected';
  const { name, written } = copyTemplateToPreset(templateRel, targetName);

  omegga.writeln(`Server.Minigames.LoadPreset "${name}"`);

  await new Promise(r => setTimeout(r, 500));
  let minis = [];
  try { minis = await omegga.getMinigames(); } catch (_) {}
  const ok = Array.isArray(minis) && minis.some(m =>
    m?.name === name || m?.rulesetName === name || m?.minigameName === name
  );
  if (!ok) {
    throw new Error(`preset load verification failed for name: ${name}`);
  }

  return `copied template to ${written.length} path(s) and created minigame "${name}"`;
}

module.exports = { createMinigameFromJson };
