const test = require('node:test');
const assert = require('node:assert/strict');
const { authorizeMicrosoft, authorizeSession, sessionToken, fixedUsers } = require('../src/auth');

const headers = (principal, extra = {}) => ({ get: (n) => (n === 'x-ms-client-principal' && principal ? Buffer.from(JSON.stringify(principal)).toString('base64') : extra[n] ?? null) });
const mariko = { userId: 'abc123', userDetails: 'Mariko@Voorbeeld.nl', identityProvider: 'aad' };
const repoWith = (users) => ({ getUsers: async () => users });

test('geen header → 401', async () => {
  await assert.rejects(authorizeMicrosoft(headers(null), repoWith([]), { ALLOWED_USERS: 'x@y.nl' }), { status: 401 });
});

test('niet-toegestane gebruiker → 403, met het adres dat de server ziet', async () => {
  await assert.rejects(authorizeMicrosoft(headers(mariko), repoWith(['iemand@anders.nl']), { ALLOWED_USERS: 'ander@voorbeeld.nl' }),
    (e) => e.status === 403 && e.extra.user === 'mariko@voorbeeld.nl');
});

test('niemand toegestaan als beide lijsten leeg zijn', async () => {
  await assert.rejects(authorizeMicrosoft(headers(mariko), repoWith([]), {}), { status: 403 });
});

test('vaste gebruiker uit ALLOWED_USERS is beheerder (hoofdletterongevoelig)', async () => {
  const u = await authorizeMicrosoft(headers(mariko), repoWith([]), { ALLOWED_USERS: 'ander@x.nl, mariko@voorbeeld.nl' });
  assert.equal(u.email, 'mariko@voorbeeld.nl');
  assert.equal(u.fixed, true);
  assert.equal(u.admin, true);
  assert.equal(u.kind, 'microsoft');
});

test('toegevoegde gebruiker uit de app is geen vaste gebruiker en geen admin', async () => {
  const u = await authorizeMicrosoft(headers(mariko), repoWith(['mariko@voorbeeld.nl']), { ALLOWED_USERS: 'ander@x.nl' });
  assert.equal(u.fixed, false);
  assert.equal(u.admin, false);
});

test('fixedUsers leest lijst', () => {
  assert.deepEqual(fixedUsers({ ALLOWED_USERS: ' A@x.nl,,b@x.nl ' }), ['a@x.nl', 'b@x.nl']);
  assert.deepEqual(fixedUsers({}), []);
});

test('sessieroute negeert x-ms-client-principal (kan op een openbare route vervalst zijn)', async () => {
  await assert.rejects(authorizeSession(headers(mariko), 'GET', {}), { status: 401 });
});

test('sessiecookie wordt uit de cookie-header gehaald', () => {
  assert.equal(sessionToken(headers(null, { cookie: 'a=1; gu_session=abc-_123; b=2' })), 'abc-_123');
  assert.equal(sessionToken(headers(null, {})), null);
});

test('wijzigend verzoek zonder x-requested-with → 403', async () => {
  await assert.rejects(authorizeSession(headers(null, { cookie: 'gu_session=x' }), 'POST', {}), { status: 403 });
});
