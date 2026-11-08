'use strict';
// Zero dependency minimal logger for roostr.

function warn(msg) {
  process.stderr.write(`[roostr WARN] ${msg}\n`);
}

function info(msg) {
  process.stdout.write(`[roostr INFO] ${msg}\n`);
}

function error(msg) {
  process.stderr.write(`[roostr ERROR] ${msg}\n`);
}

module.exports = {
  warn,
  info,
  error,
};
