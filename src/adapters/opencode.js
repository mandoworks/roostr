'use strict';
// opencode. The last line of the screen holds "340.9K (34%)": tokens in
// context and the context percentage. The last "▣  <mode> · <model>" message
// header names the model (a finished message adds " · <duration>"). No cost is shown, so cost stays unknown.

const { lastLines, parseCount, empty } = require('./util');

function parse(screen) {
  const f = lastLines(screen, 2);
  const r = empty();
  const m = /(?:^|\s)(\d+(?:\.\d+)?[kKmM]?)\s+\((\d+(?:\.\d+)?)%\)(?=\s|$)/m.exec(f);
  if (m) {
    r.tokens = parseCount(m[1]);
    r.ctx = parseFloat(m[2]);
  }
  const headers = String(screen || '').match(/^\s*▣\s+\S+\s+·\s+(.+?)\s*$/gm);
  // The model is words with single spaces: a wide gap ends it, since a side
  // panel can share the header's row.
  if (headers) r.model = /·\s+([^\s·]+(?: [^\s·]+)*)/.exec(headers[headers.length - 1])[1];
  return r;
}

module.exports = { parse };
