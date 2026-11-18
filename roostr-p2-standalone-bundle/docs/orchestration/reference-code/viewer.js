'use strict';
// Reference implementation for src/board/viewer.js (Zero external dependencies, Node >= 22)
const fs = require('node:fs');
const { spawn } = require('node:child_process');

class LogTailViewer {
  constructor(maxLines = 500) {
    this.maxLines = maxLines;
    this.workerId = null;
    this.logPath = null;
    this.offset = 0;
    this.partial = '';
    this.lines = [];
    this.watcher = null;
  }

  open(workerId, logPath, onUpdate) {
    if (this.workerId === workerId && this.logPath === logPath) return;
    this.close();
    this.workerId = workerId;
    this.logPath = logPath;
    this.offset = 0;
    this.partial = '';
    this.lines = [];
    this._readNewBytes();
    try {
      this.watcher = fs.watch(logPath, () => {
        if (this._readNewBytes() && typeof onUpdate === 'function') onUpdate();
      });
      this.watcher.on('error', () => {});
    } catch {}
  }

  _readNewBytes() {
    if (!this.logPath) return false;
    let st;
    try {
      st = fs.statSync(this.logPath);
    } catch {
      return false;
    }
    if (st.size < this.offset) {
      this.offset = 0;
      this.partial = '';
      this.lines = [];
    }
    if (st.size === this.offset) return false;
    const len = Math.min(st.size - this.offset, 64 * 1024);
    const start = st.size - len;
    const buf = Buffer.allocUnsafe(len);
    let fd;
    try {
      fd = fs.openSync(this.logPath, 'r');
      const bytes = fs.readSync(fd, buf, 0, len, start);
      this.offset = start + bytes;
      const chunk = this.partial + buf.subarray(0, bytes).toString('utf8');
      const parts = chunk.split(/\r?\n/);
      this.partial = parts.pop() || '';
      for (const line of parts) {
        this.lines.push(line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, ''));
      }
      if (this.lines.length > this.maxLines) {
        this.lines.splice(0, this.lines.length - this.maxLines);
      }
      return true;
    } catch {
      return false;
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    }
  }

  visibleLines(height) {
    this._readNewBytes();
    const all = this.partial ? [...this.lines, this.partial] : this.lines;
    return all.slice(-Math.max(1, height));
  }

  close() {
    if (this.watcher) {
      try { this.watcher.close(); } catch {}
      this.watcher = null;
    }
    this.workerId = null;
    this.logPath = null;
  }
}

function buildResumeArgv(worker) {
  const tool = String(worker.tool || 'opencode').toLowerCase();
  const sid = worker.sessionId || worker.session;
  if (!sid) return null;
  if (tool === 'claude') return ['claude', ['--resume', String(sid)]];
  if (tool === 'kilo') return ['kilo', ['--session', String(sid)]];
  if (tool === 'agy') return ['agy', ['--session', String(sid)]];
  return ['opencode', ['--session', String(sid)]];
}

function attachInteractiveSession(worker, { onBeforeSpawn, onAfterExit } = {}) {
  const spec = buildResumeArgv(worker);
  if (!spec) return Promise.resolve({ ok: false, reason: 'No resumable sessionId on worker' });
  const [bin, args] = spec;
  if (typeof onBeforeSpawn === 'function') onBeforeSpawn();
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: worker.cwd || process.cwd(),
      stdio: 'inherit'
    });
    child.on('exit', (code, signal) => {
      if (typeof onAfterExit === 'function') onAfterExit();
      resolve({ ok: true, code, signal });
    });
    child.on('error', (err) => {
      if (typeof onAfterExit === 'function') onAfterExit();
      resolve({ ok: false, reason: err.message });
    });
  });
}

module.exports = { LogTailViewer, buildResumeArgv, attachInteractiveSession };
