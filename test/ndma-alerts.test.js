const test = require('node:test');
const assert = require('node:assert/strict');
const { parseNdmaTimestamp, toIstDateKey, getCurrentDayNdmaAlerts } = require('../server');

test('parseNdmaTimestamp keeps IST timestamps on the same calendar day', () => {
  const timestamp = parseNdmaTimestamp('Thu Jul 02 19:31:00 IST 2026');

  assert.notEqual(timestamp, null);
  assert.equal(toIstDateKey(timestamp), '2026-07-02');
});

test('getCurrentDayNdmaAlerts returns the newest alerts first', () => {
  const now = new Date('2026-07-04T18:00:00+05:30').getTime();
  const alerts = [
    {
      effective_start_time: 'Sat Jul 04 16:27:00 IST 2026',
      effective_end_time: 'Sat Jul 04 19:27:00 IST 2026',
      warning_message: 'older alert surat',
    },
    {
      effective_start_time: 'Sat Jul 04 17:15:00 IST 2026',
      effective_end_time: 'Sat Jul 04 20:15:00 IST 2026',
      warning_message: 'newer alert surat',
    },
  ];

  const currentAlerts = getCurrentDayNdmaAlerts(alerts, now);

  assert.equal(currentAlerts[0].warning_message, 'newer alert surat');
  assert.equal(currentAlerts[1].warning_message, 'older alert surat');
});
