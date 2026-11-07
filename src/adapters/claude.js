'use strict';
// Claude Code. Its statusline sits below the input box. The stock footer shows
// no usage, so this reads the common statusline fields: "$2.1655", "ctx:18%",
// "in:207865 out:501". A value cut by the pane edge ("$2.…", "in:2078…") does
// not match and stays unknown.

const { belowLastRule, empty } = require('./util');

function parse(screen) {
  const f = belowLastRule(screen);
  const r = empty();
  const cost = /(?:^|[\s|])\$(\d+(?:\.\d+)?)(?=\s|\||$)/m.exec(f);
  if (cost) r.cost = parseFloat(cost[1]);
  const ctx = /\bctx:\s?(\d+(?:\.\d+)?)%/.exec(f);
  if (ctx) r.ctx = parseFloat(ctx[1]);
  const tok = /\bin:(\d+)\s+out:(\d+)(?=\s|\||$)/m.exec(f);
  if (tok) r.tokens = parseInt(tok[1], 10) + parseInt(tok[2], 10);
  const mod = /\b(?:model:\s*)?(claude-[\w.-]+|Sonnet\s+[\d.]+|Opus\s+[\d.]+|Haiku\s+[\d.]+)\b/i.exec(f)
    || /\b(Sonnet\s+[\d.]+|Opus\s+[\d.]+|Haiku\s+[\d.]+)\b/i.exec(screen);
  if (mod) r.model = mod[1];
  return r;
}

module.exports = { parse };
