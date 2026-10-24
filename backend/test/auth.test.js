const test = require('node:test');
const assert = require('node:assert/strict');
const { authorize, fixedUsers } = require('../src/auth');

const headers = (principal) => ({ get: (n) => (n === 'x-ms-client-principal' && principal ? Buffer.from(JSON.stringify(principal)).toString('base64') : null) });
const mariko = { userId: 'abc123', userDetails: 'Mariko@Voorbeeld.nl', identityProvider: 'aad' };
const repoWith = (users) => ({ getUsers: async () => users });

test('geen header → 401', async () => {
  await assert.rejects(authorize(headers(null), repoWith([]), { ALLOWED_USERS: 'x@y.nl' }), { status: 401 });
});

test('niet-toegestane gebruiker → 403', async () => {
  await assert.rejects(authorize(headers(mariko), repoWith(['iemand@anders.nl']), { ALLOWED_USERS: 'ander@voorbeeld.nl' }), { status: 403 });
});

test('niemand toegestaan als beide lijsten leeg zijn', async () => {
  await assert.rejects(authorize(headers(mariko), repoWith([]), {}), { status: 403 });
});

test('vaste gebruiker uit ALLOWED_USERS (hoofdletterongevoelig)', async () => {
  const u = await authorize(headers(mariko), repoWith([]), { ALLOWED_USERS: 'ander@x.nl, mariko@voorbeeld.nl' });
  assert.deepEqual(u, { name: 'Mariko@Voorbeeld.nl', email: 'mariko@voorbeeld.nl', fixed: true });
});

test('toegevoegde gebruiker uit de app', async () => {
  const u = await authorize(headers(mariko), repoWith(['mariko@voorbeeld.nl']), { ALLOWED_USERS: 'ander@x.nl' });
  assert.equal(u.fixed, false);
});

test('fixedUsers leest lijst', () => {
  assert.deepEqual(fixedUsers({ ALLOWED_USERS: ' A@x.nl,,b@x.nl ' }), ['a@x.nl', 'b@x.nl']);
  assert.deepEqual(fixedUsers({}), []);
});
