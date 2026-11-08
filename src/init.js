'use strict';
// `roostr init [--dir <path>] [--json]`
//
// One command to make a project ready for roostr: write a starter .roostr.toml,
// trust it so its checks may run, and record which coding agent CLIs are on
// PATH into ~/.roostr/config.json. Every step is skipped when it is already
// done, so running init twice is harmless.

const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const crewfile = require('./crewfile');
const state = require('./state');

const AGENTS = ['claude', 'opencode', 'kilo', 'agy', 'codex', 'gemini'];
const CREW_FILES = ['.roostr.toml', '.crew-board.toml'];

function helpText() {
  return [
    'usage: roostr init [--dir <path>] [--json]',
    '',
    'Prepare a project for roostr in one command:',
    '  1. write a starter .roostr.toml when none exists',
    '  2. trust that crew file so its checks may run',
    '  3. record the coding agent CLIs found on PATH',
    '',
    'flags:',
    '  --dir <path>    the project directory (default: the current directory)',
    '  --json          emit the result as JSON',
    '  -h, --help      show this help',
  ].join('\n');
}

// A binary found on PATH. Existence is enough: init only records what it sees.
function which(bin) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32'
    ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // Not there: keep looking.
      }
    }
  }
  return null;
}

function detectAgents() {
  return AGENTS.filter((agent) => which(agent));
}

// ./verify.sh when it is executable, else npm test when a package.json exists,
// else there is no check to write.
function detectCheck(dir) {
  const verify = path.join(dir, 'verify.sh');
  try {
    const st = fs.statSync(verify);
    if (st.isFile() && (st.mode & 0o111)) return './verify.sh';
  } catch {
    // No verify.sh.
  }
  if (fs.existsSync(path.join(dir, 'package.json'))) return 'npm test';
  return null;
}

function starterToml(dir, check) {
  const name = path.basename(path.resolve(dir)) || 'project';
  const lines = [
    '[board]',
    `name = "${name}"`,
    'budget = 20',
    'tags = "label"',
  ];
  if (check) {
    lines.push('', '[[check]]', 'name = "verify"', `run = "${check}"`);
  }
  return lines.join('\n') + '\n';
}

// Trust the crew file the same way the board does, so its checks start running
// without a second prompt.
function trustCrew(crewPath, hash) {
  const board = require('./board');
  board.trustCrews([{ file: crewPath, hash }]);
}

function initConfig() {
  const p = config.configPath();
  if (fs.existsSync(p)) return { path: p, created: false, tools: null };
  const found = detectAgents();
  const cfg = config.defaultConfig();
  if (found.length) {
    cfg.tools = found;
    cfg.defaultTool = found[0];
  }
  const saved = config.saveConfig(cfg);
  return { path: saved.path, created: true, tools: cfg.tools };
}

function flagValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

function runInit(argv = [], opts = {}) {
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(helpText() + '\n');
    return 0;
  }
  const json = argv.includes('--json');
  const dir = path.resolve(flagValue(argv, '--dir') || opts.dir || process.cwd());

  const result = {
    dir,
    crewFile: null,
    crewCreated: false,
    trusted: false,
    config: null,
    checks: [],
  };

  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      throw new Error(`not a directory: ${dir}`);
    }

    const existing = CREW_FILES.map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
    if (existing) {
      result.crewFile = existing;
    } else {
      const check = detectCheck(dir);
      const crewPath = path.join(dir, '.roostr.toml');
      fs.writeFileSync(crewPath, starterToml(dir, check), { mode: 0o600 });
      const hash = crewfile.hashFile(crewPath);
      trustCrew(crewPath, hash);
      result.crewFile = crewPath;
      result.crewCreated = true;
      result.trusted = true;
      if (check) result.checks.push({ name: 'verify', run: check });
    }

    result.config = initConfig();
  } catch (e) {
    process.stderr.write(`roostr init: ${e.message}\n`);
    return 1;
  }

  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    const lines = [`roostr init: ${result.dir}`];
    if (result.crewCreated) {
      lines.push(`  wrote ${result.crewFile}`);
      lines.push('  trusted the crew file');
      for (const c of result.checks) lines.push(`  check ${c.name}: ${c.run}`);
    } else {
      lines.push(`  kept the existing crew file ${result.crewFile}`);
    }
    if (result.config && result.config.created) {
      lines.push(`  wrote ${result.config.path} (tools: ${(result.config.tools || []).join(', ') || 'none detected'})`);
    } else if (result.config) {
      lines.push(`  kept ${result.config.path}`);
    }
    process.stdout.write(lines.join('\n') + '\n');
  }
  return 0;
}

module.exports = { AGENTS, which, detectAgents, detectCheck, starterToml, initConfig, runInit, main: runInit, helpText };
