'use strict';
// Terminal helpers: colour, display width, truncation. No side effects.

let colorOn = true;

function setColor(on) {
  colorOn = Boolean(on);
}

function isColorOn() {
  return colorOn;
}

function defaultColor(stream) {
  if (process.env.FORCE_COLOR) return process.env.FORCE_COLOR !== '0';
  if (process.env.NO_COLOR || process.env.TERM === 'dumb') return false;
  return Boolean(stream && stream.isTTY);
}

function fg(n) {
  return (s) => (colorOn ? `\x1b[38;5;${n}m${s}\x1b[39m` : s);
}
const bold = (s) => (colorOn ? `\x1b[1m${s}\x1b[22m` : s);

// 256 colour palette, picked to read on dark and light panes.
const C = {
  title: fg(255),
  text: fg(252),
  dim: fg(243),
  screen: fg(180), // values read from the pane screen
  green: fg(78),
  amber: fg(214),
  red: fg(203),
  cyan: fg(80),
  gold: fg(221),
  accent: fg(117),
};

// Workspace names, one vibrant colour each, in workspace order.
const WS = [fg(117), fg(213), fg(156), fg(221), fg(177), fg(209), fg(87), fg(219)];

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const ESCAPE_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b[\s\S]|\x1b/g;
const SGR_RE = /^\x1b\[[0-9;]*m$/;

function stripAnsi(s) {
  return String(s).replace(ANSI_RE, '');
}

// Keep colour codes and drop every other escape: cursor moves, clears, OSC
// titles, and anything else a pane could smuggle into a row.
function stripEscapes(s) {
  return String(s).replace(ESCAPE_RE, (m) => (SGR_RE.test(m) ? m : ''));
}

// Symbols below U+FFFF that terminals draw two cells wide (emoji
// presentation: ⚡ ⌛ ⏳ ✅ ❌ ⭐ and friends). Counting them as one cell makes a
// full width line wrap.
const WIDE_BMP = new Set([
  0x231a, 0x231b, 0x23e9, 0x23ea, 0x23eb, 0x23ec, 0x23f0, 0x23f3, 0x25fd, 0x25fe, 0x2614, 0x2615,
  0x2648, 0x2649, 0x264a, 0x264b, 0x264c, 0x264d, 0x264e, 0x264f, 0x2650, 0x2651, 0x2652, 0x2653,
  0x267f, 0x2693, 0x26a1, 0x26aa, 0x26ab, 0x26bd, 0x26be, 0x26c4, 0x26c5, 0x26ce, 0x26d4, 0x26ea,
  0x26f2, 0x26f3, 0x26f5, 0x26fa, 0x26fd, 0x2705, 0x270a, 0x270b, 0x2728, 0x274c, 0x274e, 0x2753,
  0x2754, 0x2755, 0x2757, 0x2795, 0x2796, 0x2797, 0x27b0, 0x27bf, 0x2b1b, 0x2b1c, 0x2b50, 0x2b55,
]);

function charWidth(cp) {
  if (
    cp < 0x20 ||
    (cp >= 0x300 && cp <= 0x36f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x2060 && cp <= 0x206f) ||
    cp === 0xfeff ||
    (cp >= 0xfe00 && cp <= 0xfe0f)
  ) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    WIDE_BMP.has(cp) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f7e0 && cp <= 0x1f7eb) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x1fa70 && cp <= 0x1faff)
  ) return 2;
  return 1;
}

function strWidth(s) {
  let w = 0;
  for (const ch of stripAnsi(s)) w += charWidth(ch.codePointAt(0));
  return w;
}

// Text from panes, labels, and reports is untrusted: drop every control
// character (C0, DEL, C1) so nothing can move the cursor, clear the screen, or
// write the clipboard. Whitespace becomes a space first.
function clean(s) {
  return String(s == null ? '' : s)
    .replace(/[\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '');
}

// Cut plain text to `width` cells, ending with … when something was cut.
function truncate(s, width) {
  const text = clean(s);
  if (width <= 0) return '';
  if (strWidth(text) <= width) return text;
  let out = '';
  let w = 0;
  for (const ch of text) {
    const cw = charWidth(ch.codePointAt(0));
    if (w + cw > width - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

function padEnd(s, width) {
  const d = width - strWidth(s);
  return d > 0 ? s + ' '.repeat(d) : s;
}

function padStart(s, width) {
  const d = width - strWidth(s);
  return d > 0 ? ' '.repeat(d) + s : s;
}

// Fit plain text into exactly `width` cells, then colour it.
function cell(text, width, paint = (s) => s, right = false) {
  const t = truncate(text, width);
  const painted = paint(t);
  return right ? padStart(painted, width) : padEnd(painted, width);
}

// Cut a line that may hold ANSI codes to `width` cells. Stripping happens even
// when the line already fits, so no non-SGR escape can reach the terminal.
function clip(line, width) {
  const safe = stripEscapes(line);
  if (strWidth(safe) <= width) return safe;
  let out = '';
  let w = 0;
  let i = 0;
  while (i < safe.length) {
    if (safe[i] === '\x1b') {
      const m = /^\x1b\[[0-9;]*m/.exec(safe.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    const cp = safe.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const cw = charWidth(cp);
    if (w + cw > width) break;
    out += ch;
    w += cw;
    i += ch.length;
  }
  return out + (colorOn ? '\x1b[0m' : '');
}

module.exports = { C, WS, bold, clean, setColor, colorOn: isColorOn, defaultColor, stripAnsi, strWidth, truncate, padEnd, padStart, cell, clip };
