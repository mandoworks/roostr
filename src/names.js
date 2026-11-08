'use strict';
// `crew-board name --language en|es|pt|fr [--count 1..20] [--exclude a,b]`
//
// Draws lowercase human names for worker agents, without replacement, using
// crypto.randomInt. The command renames nothing: the Head Honcho passes each
// name to `herdr agent rename`. A small history file keeps recently drawn
// names out of the next draw so the same few names do not keep coming back.
// The secretary is the fixed exception, `Secretary` / `secretary`.

const { randomInt } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('./config');

const LANGUAGES = config.LANGUAGES;

const POOLS = {
  en: [
    'james', 'oliver', 'noah', 'liam', 'ethan', 'mason', 'lucas', 'henry', 'jack', 'leo',
    'owen', 'ryan', 'nathan', 'adam', 'cole', 'felix', 'hugo', 'miles', 'oscar', 'theo',
    'wesley', 'arthur', 'caleb', 'dylan', 'evan', 'graham', 'isaac', 'jonah', 'kevin', 'marcus',
    'nolan', 'patrick', 'quinn', 'reid', 'simon', 'tobias', 'victor', 'walter', 'xavier', 'yusuf',
    'zane',
  ],
  es: [
    'mateo', 'diego', 'lucas', 'hugo', 'martin', 'pablo', 'bruno', 'andres', 'javier', 'sergio',
    'raul', 'miguel', 'carlos', 'alberto', 'enrique', 'francisco', 'gonzalo', 'ignacio', 'joaquin', 'lorenzo',
    'manuel', 'nicolas', 'oscar', 'pedro', 'ramon', 'rodrigo', 'ruben', 'salvador', 'santiago', 'tomas',
    'valentin', 'vicente', 'adrian', 'alejandro', 'emilio', 'fernando', 'gabriel', 'hector', 'ivan', 'julio',
  ],
  pt: [
    'joao', 'pedro', 'lucas', 'gabriel', 'rafael', 'miguel', 'gustavo', 'bruno', 'felipe', 'rodrigo',
    'thiago', 'matheus', 'carlos', 'danilo', 'eduardo', 'fernando', 'henrique', 'igor', 'leandro', 'marcelo',
    'nelson', 'otavio', 'paulo', 'ricardo', 'sergio', 'tiago', 'vinicius', 'andre', 'caio', 'diogo',
    'evandro', 'fabio', 'guilherme', 'hugo', 'ivo', 'julio', 'leonardo', 'murilo', 'renato', 'vitor',
  ],
  fr: [
    'lucas', 'hugo', 'louis', 'jules', 'gabriel', 'arthur', 'raphael', 'leo', 'paul', 'nathan',
    'ethan', 'tom', 'noah', 'theo', 'adam', 'aaron', 'baptiste', 'clement', 'damien', 'etienne',
    'fabien', 'gregoire', 'henri', 'isaac', 'julien', 'kevin', 'laurent', 'marc', 'nicolas', 'olivier',
    'pierre', 'quentin', 'remi', 'sebastien', 'thomas', 'valentin', 'vincent', 'yann', 'antoine', 'benjamin',
  ],
};

function pool(language) {
  return POOLS[language] ? POOLS[language].slice() : null;
}

// u+umlaut: the capitalized display form of a drawn name.
function capitalize(name) {
  const s = String(name);
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function randomPick(list) {
  return list[randomInt(list.length)];
}

// Draw `count` names without replacement, excluding any name in `exclude`.
// When the pool is exhausted, append -2, -3.
function draw({ language, count = 1, exclude = [] } = {}) {
  const names = POOLS[language];
  if (!names) throw new Error(`unknown language: ${language}`);
  const used = new Set([...exclude].map((n) => String(n).toLowerCase()).filter(Boolean));
  const out = [];
  let suffix = 2;
  while (out.length < count) {
    const available = names.filter((n) => !used.has(n));
    let name;
    if (available.length) {
      name = randomPick(available);
    } else {
      for (const base of names) {
        const candidate = `${base}-${suffix}`;
        if (!used.has(candidate)) {
          name = candidate;
          break;
        }
      }
      if (!name) {
        suffix++;
        continue;
      }
      suffix++;
    }
    used.add(name);
    out.push(name);
  }
  return out;
}

const USAGE = 'usage: roostr name [--language en|es|pt|fr] [--count 1..20] [--exclude a,b,c] [--no-record] [--history [--json]]';

function historyPath() {
  if (process.env.ROOSTR_NAMES) return process.env.ROOSTR_NAMES;
  if (process.env.CREW_BOARD_NAMES) return process.env.CREW_BOARD_NAMES;
  const roostr = path.join(os.homedir(), '.roostr', 'names.json');
  const legacy = path.join(os.homedir(), '.crew-board', 'names.json');
  if (fs.existsSync(roostr) || !fs.existsSync(legacy)) return roostr;
  return legacy;
}

function readHistory(file = historyPath()) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || !Array.isArray(data.names)) return [];
    return data.names.filter((e) => e && typeof e.name === 'string' && typeof e.language === 'string');
  } catch {
    return [];
  }
}

function writeHistory(entries, file = historyPath()) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ version: 1, names: entries }, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch (_) {}
}

// Recent names for one language, capped so the pool can rotate without
// excluding every name forever. About half a pool is held back, so a normal
// crew never runs out and the same handful does not repeat every time.
function recent(language, file = historyPath(), limit = null) {
  const poolSize = (POOLS[language] || []).length;
  const window = Number.isInteger(limit) ? limit : Math.max(0, Math.floor(poolSize / 2));
  return readHistory(file)
    .filter((e) => e.language === language)
    .slice(-window)
    .map((e) => e.name);
}

// Boss titles use the same recent-name history with the key `titles`, so a
// crew does not come back as la-jefa every single time.
function pickTitle({ exclude = [], file = historyPath(), remember = true } = {}) {
  const pool = config.HEAD_NAMES.map((h) => h.name);
  const used = new Set([...exclude].map((n) => String(n).toLowerCase()).filter(Boolean));
  const recentTitles = readHistory(file)
    .filter((e) => e.language === 'titles')
    .slice(-Math.max(0, Math.floor(pool.length / 2)))
    .map((e) => e.name);
  for (const name of recentTitles) used.add(name);
  const available = pool.filter((name) => !used.has(name));
  let name;
  if (available.length) {
    name = randomPick(available);
  } else {
    let suffix = 2;
    for (;;) {
      const candidate = pool.map((base) => `${base}-${suffix}`).find((n) => !used.has(n));
      if (candidate) { name = candidate; break; }
      suffix++;
    }
  }
  if (remember) {
    try { record([name], { language: 'titles', role: 'head-honcho', file }); } catch (_) {}
  }
  return name;
}

function record(drawn, { language, role = 'worker', file = historyPath() } = {}) {
  if (!Array.isArray(drawn) || !drawn.length) return;
  const entries = readHistory(file);
  const at = new Date().toISOString();
  for (const name of drawn) entries.push({ name, language, role, at });
  // Keep the file small; one full rotation plus a little history is enough.
  const cap = Math.max(200, (POOLS[language] || []).length * 5);
  writeHistory(entries.slice(-cap), file);
}

// Draw and remember. `exclude` wins over history. A failed history write never
// blocks a crew: the draw still returns the names.
function drawFor({ language, count = 1, exclude = [], role = 'worker', file = historyPath(), remember = true } = {}) {
  const avoid = [...new Set([...exclude, ...recent(language, file)])];
  const drawn = draw({ language, count, exclude: avoid });
  if (remember) {
    try { record(drawn, { language, role, file }); } catch (_) {}
  }
  return drawn;
}

function flagValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

function parseArgs(argv) {
  if (argv.includes('--history')) return { history: true, json: argv.includes('--json') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return { help: true };
    if (a === '--language' || a === '--count' || a === '--exclude') {
      if (i + 1 >= argv.length) return { error: `${a} needs a value` };
      i++;
    }
  }
  const language = flagValue(argv, '--language') || config.loadConfig().config.headLanguage;
  if (!LANGUAGES.includes(language)) return { error: `unknown language: ${language} (use ${LANGUAGES.join(', ')})` };
  const countRaw = flagValue(argv, '--count');
  const count = countRaw === null ? 1 : Number(countRaw);
  if (!Number.isInteger(count) || count < 1 || count > 20) return { error: '--count must be an integer from 1 to 20' };
  const excludeRaw = flagValue(argv, '--exclude') || '';
  const exclude = excludeRaw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const remember = !argv.includes('--no-record');
  return { language, count, exclude, remember };
}

function main(argv = []) {
  const p = parseArgs(argv);
  if (p.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (p.error) {
    process.stderr.write(`roostr name: ${p.error}\n${USAGE}\n`);
    return 2;
  }
  if (p.history) {
    const entries = readHistory();
    if (p.json) process.stdout.write(JSON.stringify({ version: 1, names: entries }, null, 2) + '\n');
    else for (const e of entries) process.stdout.write(`${e.name}\t${e.language}\t${e.role}\t${e.at}\n`);
    return 0;
  }
  for (const name of drawFor({ language: p.language, count: p.count, exclude: p.exclude, remember: p.remember })) {
    process.stdout.write(`${name}\n`);
  }
  return 0;
}

module.exports = {
  LANGUAGES, POOLS, capitalize, pool, draw, drawFor, pickTitle, historyPath, readHistory, writeHistory, recent, record, parseArgs, main, USAGE,
};
