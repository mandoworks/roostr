'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const codex = require('../src/codex');

const line = (o) => JSON.stringify(o);
const limitsEvent = (used5, used7) => line({
  timestamp: '2026-10-23T10:00:00.000Z',
  type: 'event_msg',
  payload: {
    type: 'token_count',
    rate_limits: {
      primary: { used_percent: used5, window_minutes: 300, resets_at: 1792760000 },
      secondary: { used_percent: used7, window_minutes: 10080, resets_at: 1793200000 },
      plan_type: 'plus',
    },
  },
});

test('parse: the last rate_limits in the file, as a report', () => {
  const text = ['{"cut line', limitsEvent(10, 2), line({ type: 'response_item', payload: { text: 'hello' } }), limitsEvent(34, 5), ''].join('\n');
  assert.deepEqual(codex.parse(text), {
    at: Date.parse('2026-10-23T10:00:00.000Z'),
    limits: [{ source: 'codex', five_hour: { used: 34, resets: 1792760000 }, seven_day: { used: 5, resets: 1793200000 } }],
  });
  assert.equal(codex.parse(line({ type: 'event_msg', payload: { type: 'agent_message' } })), null);
  assert.equal(codex.parse(line({ payload: { rate_limits: { primary: { used_percent: 'x', window_minutes: 300 } } } })), null);
});

test('limits: newest session file under CODEX_HOME, read at most once a minute', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-board-codex-'));
  process.env.CODEX_HOME = home;
  try {
    assert.equal(codex.limits(0), null, 'no sessions folder');
    const old = path.join(home, 'sessions', '2026', '10', '22');
    const day = path.join(home, 'sessions', '2026', '10', '23');
    fs.mkdirSync(old, { recursive: true });
    fs.mkdirSync(day, { recursive: true });
    fs.writeFileSync(path.join(old, 'rollout-a.jsonl'), limitsEvent(90, 9) + '\n');
    fs.writeFileSync(path.join(day, 'rollout-b.jsonl'), limitsEvent(34, 5) + '\n');
    assert.equal(codex.limits(30 * 1000), null, 'cached for a minute');
    const r = codex.limits(61 * 1000);
    assert.equal(r.limits[0].five_hour.used, 34, 'the newest day wins');
  } finally {
    delete process.env.CODEX_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('MAX_TAIL_BYTES caps the read at 64 KiB', () => {
  assert.equal(codex.MAX_TAIL_BYTES, 65536);
});

test('tail and parse: rate limits at the end of a file larger than 64 KiB', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-board-codex-cap-'));
  process.env.CODEX_HOME = home;
  try {
    const day = path.join(home, 'sessions', '2026', '10', '25');
    fs.mkdirSync(day, { recursive: true });
    const dummy = line({ type: 'response_item', payload: { text: 'A'.repeat(500) } }) + '\n';
    const content = dummy.repeat(200) + limitsEvent(77, 11) + '\n';
    assert.ok(Buffer.byteLength(content) > codex.MAX_TAIL_BYTES, 'larger than the cap');
    const file = path.join(day, 'rollout-d.jsonl');
    fs.writeFileSync(file, content);

    const text = codex.tail(file);
    assert.ok(Buffer.byteLength(text) <= codex.MAX_TAIL_BYTES, 'tail is bounded');
    const r = codex.parse(text);
    assert.ok(r);
    assert.equal(r.limits[0].five_hour.used, 77);
    assert.equal(r.limits[0].seven_day.used, 11);
  } finally {
    delete process.env.CODEX_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('tail and parse: rates beyond the 64 KiB cap are not found', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-board-codex-old-'));
  process.env.CODEX_HOME = home;
  try {
    const day = path.join(home, 'sessions', '2026', '10', '26');
    fs.mkdirSync(day, { recursive: true });
    const dummy = line({ type: 'response_item', payload: { text: 'B'.repeat(500) } }) + '\n';
    const content = limitsEvent(88, 12) + '\n' + dummy.repeat(200);
    const file = path.join(day, 'rollout-e.jsonl');
    fs.writeFileSync(file, content);

    assert.equal(codex.parse(codex.tail(file)), null);
  } finally {
    delete process.env.CODEX_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('limits: reads backwards in small chunks from a large session file', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-board-codex-large-'));
  process.env.CODEX_HOME = home;
  try {
    const day = path.join(home, 'sessions', '2026', '10', '24');
    fs.mkdirSync(day, { recursive: true });
    // Write ~50 KB of dummy conversation lines followed by a rate_limits line
    const dummy = line({ type: 'response_item', payload: { text: 'A'.repeat(500) } }) + '\n';
    const content = dummy.repeat(100) + limitsEvent(42, 8) + '\n';
    assert.ok(content.length > 50000, 'large file over 50 KB');
    fs.writeFileSync(path.join(day, 'rollout-c.jsonl'), content);

    const r = codex.limits(200 * 1000);
    assert.ok(r);
    assert.equal(r.limits[0].five_hour.used, 42);
    assert.equal(r.limits[0].seven_day.used, 8);
  } finally {
    delete process.env.CODEX_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
