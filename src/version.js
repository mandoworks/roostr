'use strict';
const fs = require('fs');
const path = require('path');

function readVersion() {
  try {
    const text = fs.readFileSync(path.join(__dirname, '..', 'herdr-plugin.toml'), 'utf8');
    const m = /^version\s*=\s*"([^"]+)"/m.exec(text);
    return m ? m[1] : '0.0.0';
  } catch (e) {
    return '0.0.0';
  }
}

module.exports = { VERSION: readVersion(), readVersion };
