'use strict';
// opencode. The footer holds "340.9K (34%)": tokens in context and the
// context percentage. A narrow pane clips the percentage to "90.4K ( ctrl+p",
// so the count still parses without it. The last "▣  <mode> · <model>" message
// header names the model (a finished message adds " · <duration>"). No cost is shown, so cost stays unknown.

const { lastLines, parseCount, empty } = require('./util');

function parse(screen) {
  const f = lastLines(screen, 12);
  const r = empty();
  const all = [...f.matchAll(/(?:^|\s)(\d+(?:\.\d+)?[kKmM]?)\s+\((\d+(?:\.\d+)?)%\)(?=\s|$)/gm)];
  const m = all[all.length - 1] || null;
  if (m) {
    r.tokens = parseCount(m[1]);
    r.ctx = parseFloat(m[2]);
  } else {
    // The percentage is clipped by a narrow pane or a side panel. Only accept
    // the count when the clipped footer still carries its control hint, so a
    // number in the transcript is never mistaken for usage.
    const clipped = [...f.matchAll(/(?:^|\s)(\d+(?:\.\d+)?[kKmM]?)\s+\(\s*ctrl\+[a-z]/gm)];
    const last = clipped[clipped.length - 1];
    if (last) r.tokens = parseCount(last[1]);
  }
  const headers = String(screen || '').match(/^\s*▣\s+\S+\s+·\s+(.+?)\s*$/gm);
  // The model is words with single spaces: a wide gap ends it, since a side
  // panel can share the header's row.
  if (headers) r.model = /·\s+([^\s·]+(?: [^\s·]+)*)/.exec(headers[headers.length - 1])[1];
  return r;
}

module.exports = { parse };
