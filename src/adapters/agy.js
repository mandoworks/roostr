'use strict';
// agy (Antigravity CLI). Reads the model and effort from the footer or banner.

const { empty, edgeLines } = require('./util');

// agy has no usage footer. The board reads the banner and last lines for model and effort only.
function parse(screen) {
  const r = empty();
  if (typeof screen !== 'string') return r;
  // Match footer or banner like "Gemini 3.8 Flash · high" or "Gemini 2.5 Flash"
  const m = /\b(Gemini\s+[\d.]+\s+[A-Za-z]+)(?:\s*(?:·|\()\s*(low|medium|high|xhigh|max)\)?)?/i.exec(edgeLines(screen, 6));
  if (m) {
    r.model = m[1].trim();
    if (m[2]) r.effort = m[2].toLowerCase();
  }
  return r;
}

module.exports = { parse, readsScreen: true };
