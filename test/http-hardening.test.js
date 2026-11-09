const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../server');

test('serves the dashboard with security headers without exposing source files', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());

  await new Promise(resolve => server.once('listening', resolve));
  const port = server.address().port;
  const pageResponse = await fetch(`http://127.0.0.1:${port}/`);
  const sourceResponse = await fetch(`http://127.0.0.1:${port}/server.js`);

  assert.equal(pageResponse.status, 200);
  assert.equal(pageResponse.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(pageResponse.headers.get('x-powered-by'), null);
  assert.equal(sourceResponse.status, 404);
});