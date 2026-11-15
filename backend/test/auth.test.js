const test = require('node:test');
const assert = require('node:assert/strict');
const { authorizeMicrosoft, authorizeSession, sessionToken, fixedUsers, CODE_ADMINS } = require('../src/auth');

const headers = (principal, extra = {}) => ({ get: (n) => (n === 'x-ms-client-principal' && principal ? Buffer.from(JSON.stringify(principal)).toString('base64') : extra[n] ?? null) });
const mariko = { userId: 'abc123', userDetails: 'Mariko@Voorbeeld.nl', identityProvider: 'aad' };
// Nep-repo met organisaties en lidmaatschappen. members: { 'adres': [{ org: 'main', role: 'beheerder' }] }
const orgs = { main: { id: 'main', name: 'Gastouder Mariko', status: 'active' }, andere: { id: 'andere', name: 'Andere', status: 'active' }, weg: { id: 'weg', name: 'Weg', status: 'deleted' } };
const repoWith = (members = {}, identities = new Map()) => ({
  listMembershipsOf: async (email) => (members[email] || []).map((m) => ({ orgId: m.org, email, role: m.role })),
  getOrganisation: async (id) => orgs[id] || null,
  getIdentity: async (k) => identities.get(k) || null,
  setIdentity: async (k, e) => { identities.set(k, e); },
});
const lid = (email, role = 'beheerder', org = 'main') => ({ [email]: [{ org, role }] });

test('geen header → 401', async () => {
  await assert.rejects(authorizeMicrosoft(headers(null), repoWith(), { ALLOWED_USERS: 'x@y.nl' }), { status: 401 });
});

test('geen lid van een organisatie → 403, met het adres dat de server ziet', async () => {
  await assert.rejects(authorizeMicrosoft(headers(mariko), repoWith(lid('iemand@anders.nl')), { ALLOWED_USERS: 'ander@voorbeeld.nl' }),
    (e) => e.status === 403 && e.extra.user === 'mariko@voorbeeld.nl');
});

test('niemand heeft toegang zonder lidmaatschap', async () => {
  await assert.rejects(authorizeMicrosoft(headers(mariko), repoWith(), {}), { status: 403 });
});

test('lid van een organisatie: rol en organisatie komen uit het lidmaatschap', async () => {
  const u = await authorizeMicrosoft(headers(mariko), repoWith(lid('mariko@voorbeeld.nl', 'gebruiker')), {});
  assert.equal(u.email, 'mariko@voorbeeld.nl');
  assert.equal(u.kind, 'microsoft');
  assert.equal(u.role, 'gebruiker');
  assert.equal(u.instanceId, 'main');
  assert.deepEqual(u.organisation, { id: 'main', name: 'Gastouder Mariko' });
  assert.equal(u.platformAdmin, false);
  assert.equal(u.fixed, false);
});

test('vaste gebruiker uit ALLOWED_USERS is platformbeheerder (hoofdletterongevoelig), en lid voor de gegevens', async () => {
  const u = await authorizeMicrosoft(headers(mariko), repoWith(lid('mariko@voorbeeld.nl')), { ALLOWED_USERS: 'ander@x.nl, mariko@voorbeeld.nl' });
  assert.equal(u.platformAdmin, true);
  assert.equal(u.fixed, true);
  assert.equal(u.role, 'beheerder');
});

test('platformbeheerder zonder lidmaatschap: wel binnen, maar zonder organisatie en zonder rol (dus geen gegevens)', async () => {
  const u = await authorizeMicrosoft(headers(mariko), repoWith(), { ALLOWED_USERS: 'mariko@voorbeeld.nl' });
  assert.equal(u.platformAdmin, true);
  assert.equal(u.instanceId, null);
  assert.equal(u.role, null);
  assert.deepEqual(u.organisations, []);
});

test('meerdere organisaties: de header kiest, zonder header de eerste op naam, een organisatie waar je geen lid van bent is 403', async () => {
  const members = { 'mariko@voorbeeld.nl': [{ org: 'main', role: 'beheerder' }, { org: 'andere', role: 'gebruiker' }] };
  const repo = repoWith(members);
  assert.deepEqual((await authorizeMicrosoft(headers(mariko), repo, {})).organisations.map((o) => o.id), ['andere', 'main']);   // gesorteerd op naam
  assert.equal((await authorizeMicrosoft(headers(mariko), repo, {})).instanceId, 'andere');
  const gekozen = await authorizeMicrosoft(headers(mariko, { 'x-organisatie': 'main' }), repo, {});
  assert.equal(gekozen.instanceId, 'main');
  assert.equal(gekozen.role, 'beheerder');   // de rol hoort bij de gekozen organisatie
  assert.equal((await authorizeMicrosoft(headers(mariko, { 'x-organisatie': ' ANDERE ' }), repo, {})).role, 'gebruiker');
  for (const x of ['derde', 'weg', 'main; drop', '../main']) {
    await assert.rejects(authorizeMicrosoft(headers(mariko, { 'x-organisatie': x }), repo, {}), (e) => e.status === 403 && e.extra.code === 'organisation_denied', x);
  }
});

test('een organisatie die niet (meer) actief is telt niet mee, ook niet voor een lid', async () => {
  const repo = repoWith({ 'mariko@voorbeeld.nl': [{ org: 'weg', role: 'beheerder' }] });
  await assert.rejects(authorizeMicrosoft(headers(mariko), repo, {}), { status: 403 });
  await assert.rejects(authorizeMicrosoft(headers(mariko, { 'x-organisatie': 'weg' }), repo, {}), { status: 403 });
});

test('een onbekende rol in een lidmaatschap geeft geen toegang', async () => {
  await assert.rejects(authorizeMicrosoft(headers(mariko), repoWith(lid('mariko@voorbeeld.nl', 'admin')), {}), { status: 403 });
});

test('platformbeheerder kan niet naar een organisatie waar hij geen lid van is', async () => {
  await assert.rejects(authorizeMicrosoft(headers(mariko, { 'x-organisatie': 'main' }), repoWith(), { ALLOWED_USERS: 'mariko@voorbeeld.nl' }), (e) => e.status === 403 && e.extra.code === 'organisation_denied');
});

test('fixedUsers leest lijst', () => {
  assert.deepEqual(fixedUsers({ ALLOWED_USERS: ' A@x.nl,,b@x.nl ' }), [...CODE_ADMINS, 'a@x.nl', 'b@x.nl']);
  assert.deepEqual(fixedUsers({}), CODE_ADMINS);
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

test('afgeschermde userDetails: het volledige adres uit de claims wordt gebruikt', async () => {
  const masked = { userId: 'abc', identityProvider: 'aad', userDetails: 'dot*****', claims: [{ typ: 'name', val: 'Dot' }, { typ: 'preferred_username', val: 'Dot@Hotmail.com' }] };
  const u = await authorizeMicrosoft(headers(masked), repoWith(lid('dot@hotmail.com')), {});
  assert.equal(u.email, 'dot@hotmail.com');
  assert.equal(u.role, 'beheerder');
});

test('afgeschermd zonder bruikbare claim: geen toegang, met diagnose zonder adressen', async () => {
  const masked = { userId: 'abc-onbekend', identityProvider: 'aad', userDetails: 'dot*****', claims: [{ typ: 'name', val: 'Dot' }] };
  await assert.rejects(authorizeMicrosoft(headers(masked), repoWith(lid('dot@hotmail.com')), {}),
    (e) => e.status === 403 && e.extra.diag.detailsMasked === true && e.extra.diag.usedClaim === false && JSON.stringify(e.extra.diag).includes('hotmail') === false);
});

test('onzichtbare tekens in ALLOWED_USERS worden genegeerd', async () => {
  assert.deepEqual(fixedUsers({ ALLOWED_USERS: 'a@x.nl,\u200Bb@x.nl\u200B' }), [...CODE_ADMINS, 'a@x.nl', 'b@x.nl']);
});

test('afgeschermd adres zonder claims: het eerder onthouden adres bij hetzelfde userId wordt gebruikt', async () => {
  const repo = repoWith(lid('dot@hotmail.com'));
  const full = { userId: 'uid-dot-1', identityProvider: 'aad', userDetails: 'Dot@Hotmail.com' };
  const masked = { userId: 'uid-dot-1', identityProvider: 'aad', userDetails: 'dot*****' };
  await assert.rejects(authorizeMicrosoft(headers(masked), repo, {}), { status: 403 });          // nog niet bekend
  assert.equal((await authorizeMicrosoft(headers(full), repo, {})).email, 'dot@hotmail.com');       // volledig adres: onthouden
  const u = await authorizeMicrosoft(headers(masked), repo, {});
  assert.equal(u.email, 'dot@hotmail.com');
  assert.equal(u.role, 'beheerder');
});

test('onthouden adres geeft geen toegang meer als het lidmaatschap weg is', async () => {
  const members = lid('x@y.nl');
  const repo = repoWith(members);
  await authorizeMicrosoft(headers({ userId: 'uid-x-2', userDetails: 'x@y.nl' }), repo, {});
  delete members['x@y.nl'];
  await assert.rejects(authorizeMicrosoft(headers({ userId: 'uid-x-2', userDetails: 'x*****' }), repo, {}), { status: 403 });
});

test('vaste beheerder uit de code is platformbeheerder, ook zonder ALLOWED_USERS', async () => {
  const p = { userId: 'uid-code', identityProvider: 'aad', userDetails: CODE_ADMINS[0].toUpperCase() };
  const u = await authorizeMicrosoft(headers(p), repoWith(), {});
  assert.equal(u.email, CODE_ADMINS[0]);
  assert.equal(u.platformAdmin, true);
  assert.equal(u.fixed, true);
});
