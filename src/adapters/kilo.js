'use strict';
// Kilo CLI is built on opencode and draws the same footer. Its own adapter file
// exists so the two can diverge without touching each other.

const opencode = require('./opencode');

function parse(screen) {
  return opencode.parse(screen);
}

module.exports = { parse };
