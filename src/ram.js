'use strict';
// Memory per agent pane: the resident size of the pane's shell and everything
// under it (the agent, its MCP servers, its tools). One `ps` call covers every
// pane; it runs through execFile with a fixed argv, never a shell.

const { execFile } = require('child_process');

// pid -> { ppid, rss } in KiB, from `ps -A -o pid=,ppid=,rss=` output.
function parsePs(text) {
  const table = new Map();
  for (const line of String(text).split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) table.set(Number(m[1]), { ppid: Number(m[2]), rss: Number(m[3]) });
  }
  return table;
}

// The summed RSS (KiB) of `pid` and all its descendants, or null when the pid
// is not running.
function treeRss(table, pid) {
  if (!table.has(pid)) return null;
  const kids = new Map();
  for (const [p, { ppid }] of table) {
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(p);
  }
  let total = 0;
  const todo = [pid];
  const seen = new Set();
  while (todo.length) {
    const p = todo.pop();
    if (seen.has(p)) continue;
    seen.add(p);
    total += table.get(p).rss;
    for (const k of kids.get(p) || []) todo.push(k);
  }
  return total;
}

function processTable() {
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pid=,ppid=,rss='], { timeout: 4000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? new Map() : parsePs(stdout));
    });
  });
}

module.exports = { parsePs, treeRss, processTable };
