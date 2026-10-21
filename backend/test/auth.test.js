const test = require('node:test');
const assert = require('node:assert/strict');
const { getUser } = require('../src/auth');

const headers = (principal) => ({ get: (n) => (n === 'x-ms-client-principal' && principal ? Buffer.from(JSON.stringify(principal)).toString('base64') : null) });
const mariko = { userId: 'abc123', userDetails: 'Mariko@Voorbeeld.nl', identityProvider: 'aad' };

test('geen header → 401', () => {
  assert.throws(() => getUser(headers(null), { ALLOWED_USERS: 'x@y.nl' }), { status: 401 });
});

test('niet-toegestane gebruiker → 403', () => {
  assert.throws(() => getUser(headers(mariko), { ALLOWED_USERS: 'ander@voorbeeld.nl' }), { status: 403 });
});

test('lege ALLOWED_USERS laat niemand toe', () => {
  assert.throws(() => getUser(headers(mariko), {}), { status: 403 });
});

test('toegestane gebruiker (hoofdletterongevoelig)', () => {
  assert.deepEqual(getUser(headers(mariko), { ALLOWED_USERS: 'ander@x.nl, mariko@voorbeeld.nl' }), { id: 'abc123', name: 'Mariko@Voorbeeld.nl' });
});
