'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { runLoadTest } = require('../scripts/load-test');

test('load: 12 panes stay under the p95 limit', () => {
  const result = runLoadTest();
  assert.equal(result.paneCount, 12);
  assert.ok(Number.isFinite(result.pass.p95Ms));
  assert.ok(
    result.pass.p95Ms <= result.p95LimitMs,
    `p95 ${result.pass.p95Ms.toFixed(2)} ms is over ${result.p95LimitMs} ms`,
  );
  for (const row of result.byWidth) {
    assert.ok(
      row.p95Ms <= result.p95LimitMs,
      `width ${row.width} p95 ${row.p95Ms.toFixed(2)} ms is over ${result.p95LimitMs} ms`,
    );
  }
  assert.equal(result.failedP95, false);
});
