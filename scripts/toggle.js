'use strict';
// The toggle action, scoped to the current tab:
//   no board in this tab          -> open one in a split (focused)
//   a board here, not focused     -> focus it
//   the focused pane is the board -> close it
// With --popup it opens the popup board instead; q or Esc closes that one.
// With --backups it opens the popup on the backups view.
// Any failure reading panes falls back to opening a board.

const path = require('path');
const herdr = require(path.join(__dirname, '..', 'src', 'herdr.js'));

// Herdr labels plugin panes with their manifest title. The board is always
// `🐓ROOSTR🐓`; the old `crew-board` label is still recognized so an open pane
// from before the rename still focuses and closes correctly. Agent panes are
// never the board.
const BOARD_TITLES = new Set(['🐓ROOSTR🐓', 'crew-board']);
function isBoard(p) {
  return !p.agent && (BOARD_TITLES.has(p.terminal_title_stripped) || BOARD_TITLES.has(p.label));
}

// panes -> { action: "open" } | { action: "focus" | "close", pane }
function decide(panes) {
  const focused = panes.find((p) => p && p.focused === true);
  if (!focused) return { action: 'open' };
  if (isBoard(focused)) return { action: 'close', pane: focused.pane_id };
  const board = panes.find((p) => p && p.tab_id === focused.tab_id && isBoard(p));
  return board ? { action: 'focus', pane: board.pane_id } : { action: 'open' };
}

async function main(argv) {
  if (argv.includes('--popup')) return herdr.openBoard('board-popup', false);
  if (argv.includes('--backups')) return herdr.openBoard('backups', false);
  let d = { action: 'open' };
  try {
    d = decide(await herdr.listPanes());
  } catch (e) {
    // fall through to open
  }
  if (d.action === 'close') return herdr.closeBoard(d.pane);
  if (d.action === 'focus') {
    try {
      return await herdr.focusBoard(d.pane);
    } catch (e) {
      // a pane Herdr will not focus by id: open a fresh board instead
    }
  }
  return herdr.openBoard('board', true);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`crew-board: ${e.message}\n`);
    process.exit(1);
  });
}

module.exports = { decide, isBoard };
