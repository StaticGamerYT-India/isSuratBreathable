const test = require('node:test');
const assert = require('node:assert/strict');
const { parseNdmaTimestamp, toIstDateKey } = require('../server');

test('parseNdmaTimestamp keeps IST timestamps on the same calendar day', () => {
  const timestamp = parseNdmaTimestamp('Thu Jul 02 19:31:00 IST 2026');

  assert.notEqual(timestamp, null);
  assert.equal(toIstDateKey(timestamp), '2026-07-02');
});
