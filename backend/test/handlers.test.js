const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { createRepo } = require('../src/repo');
const h = require('../src/handlers');

// Draait tegen een echte Azurite (lokale Table Storage-emulator).
let azurite, repo, dir;
const env = { ALLOWED_USERS: 'mariko@voorbeeld.nl' };
const fixedUser = { email: 'mariko@voorbeeld.nl', fixed: true, role: 'admin' };
const K = (k) => ({ start: '2026-01-01', end: '2026-12-31', ...k });
const call = (fn, extra = {}) => fn({ user: fixedUser, repo, env, params: {}, query: {}, ...extra });

const waitForPort = (port) => new Promise((resolve, reject) => {
  const deadline = Date.now() + 20000;
  (function try_() {
    const s = net.connect(port, '127.0.0.1').once('connect', () => { s.destroy(); resolve(); })
      .once('error', () => { s.destroy(); Date.now() > deadline ? reject(new Error('Azurite start niet')) : setTimeout(try_, 200); });
  })();
})

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azurite-'));
  azurite = spawn(process.execPath, [require.resolve('azurite/dist/src/table/main.js'), '--silent', '--location', dir, '--tablePort', '10112', '--skipApiVersionCheck'], { stdio: 'inherit' });
  await waitForPort(10112);
  repo = createRepo(`DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;TableEndpoint=http://127.0.0.1:10112/devstoreaccount1;`);
});
test.after(() => { azurite.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

test('kind + contracten aanmaken en teruglezen', async () => {
  const res = await call(h.createChild, { body: { name: ' Noah ', contracts: [K({ rate: 8.5, number: ' 123 ' })] } });
  assert.equal(res.status, 201);
  assert.equal(res.jsonBody.name, 'Noah');
  assert.ok(res.jsonBody.contracts[0].id);
  assert.equal(res.jsonBody.contracts[0].number, '123');
  assert.equal(res.jsonBody.firstName, 'Noah');
  const list = await call(h.listChildren);
  assert.equal(list.jsonBody.length, 1);
  assert.equal(list.jsonBody[0].contracts[0].rate, 8.5);
});

test('uren: toevoegen, per maand ophalen, verwijderen', async () => {
  const [child] = (await call(h.listChildren)).jsonBody;
  const contractId = child.contracts[0].id;
  const body = { date: '2026-10-21', contractId, start: '08:00', end: '17:00', note: 'x' };
  const created = (await call(h.createEntry, { body })).jsonBody;
  await call(h.createEntry, { body: { ...body, date: '2026-11-01' } });
  await call(h.createEntry, { body: { ...body, date: '2026-09-30' } });

  const okt = (await call(h.listEntries, { query: { month: '2026-10' } })).jsonBody;
  assert.equal(okt.length, 1);
  assert.deepEqual(okt[0], created);

  assert.equal((await call(h.deleteEntry, { params: { id: created.id } })).status, 204);
  assert.equal((await call(h.listEntries, { query: { month: '2026-10' } })).jsonBody.length, 0);
});

test('validatie', async () => {
  const [child] = (await call(h.listChildren)).jsonBody;
  const ok = { date: '2026-10-21', contractId: child.contracts[0].id, start: '08:00', end: '17:00' };
  for (const bad of [
    { ...ok, date: '2026-02-30' }, { ...ok, start: '9:00' }, { ...ok, end: '07:00' },
    { ...ok, contractId: 'bestaatniet' }, { ...ok, end: '08:00' },
  ]) await assert.rejects(call(h.createEntry, { body: bad }), { status: 400 });
  await assert.rejects(call(h.createChild, { body: { name: '  ' } }), { status: 400 });
  await assert.rejects(call(h.createChild, { body: { name: 'A', contracts: [K({ rate: -1 })] } }), { status: 400 });
  await assert.rejects(call(h.listEntries, { query: { month: '2026-13' } }), { status: 400 });
});

test('contract verwijderen en kind verwijderen nemen uren mee', async () => {
  const child = (await call(h.createChild, { body: { name: 'Sam', contracts: [K({ rate: 9 }), K({ rate: 10 })] } })).jsonBody;
  const [a, b] = child.contracts;
  const base = { date: '2026-12-01', start: '08:00', end: '12:00' };
  await call(h.createEntry, { body: { ...base, contractId: a.id } });
  await call(h.createEntry, { body: { ...base, contractId: b.id } });

  await call(h.updateChild, { params: { id: child.id }, body: { name: 'Sam', contracts: [b] } });
  let left = (await call(h.listEntries, { query: { month: '2026-12' } })).jsonBody;
  assert.deepEqual(left.map((e) => e.contractId), [b.id]);

  await call(h.deleteChild, { params: { id: child.id } });
  left = (await call(h.listEntries, { query: { month: '2026-12' } })).jsonBody;
  assert.equal(left.length, 0);
  await assert.rejects(call(h.updateChild, { params: { id: child.id }, body: { name: 'x' } }), { status: 404 });
});

test('contract zonder tarief gebruikt het algemene tarief (rate = null)', async () => {
  const res = await call(h.createChild, { body: { name: 'Lisa', contracts: [K({ rate: '' }), K({ rate: 9.456 })] } });
  assert.deepEqual(res.jsonBody.contracts.map((k) => k.rate), [null, 9.46]);
  await call(h.deleteChild, { params: { id: res.jsonBody.id } });
});

test('algemene tarieven: opslaan, sorteren, open einddatum', async () => {
  const body = { rates: [{ from: '2027-01-01', to: null, rate: 9 }, { from: '2026-01-01', to: '2026-12-31', rate: '8.5' }] };
  const res = await call(h.putRates, { body });
  assert.deepEqual(res.jsonBody.rates.map((r) => [r.from, r.to, r.rate]), [['2026-01-01', '2026-12-31', 8.5], ['2027-01-01', null, 9]]);
  const settings = (await call(h.getSettings)).jsonBody;
  assert.equal(settings.rates.length, 2);
  assert.deepEqual(settings.fixedUsers, ['mariko@voorbeeld.nl']);
  assert.equal(settings.me, 'mariko@voorbeeld.nl');
});

test('algemene tarieven: validatie en overlap', async () => {
  const r = (from, to, rate = 8) => ({ from, to, rate });
  for (const rates of [
    [r('2026-02-30', null)], [r('2026-05-01', '2026-04-01')], [r('2026-01-01', '2026-12-31', -1)],
    [r('2026-01-01', '2026-06-30'), r('2026-06-30', null)],   // overlap op 30 juni
    [r('2026-01-01', null), r('2027-01-01', null)],           // eerste is open einde
  ]) await assert.rejects(call(h.putRates, { body: { rates } }), { status: 400 });
  await assert.rejects(call(h.putRates, { body: {} }), { status: 400 });
});

test('gebruikers: toevoegen, normaliseren, vaste gebruikers niet dubbel', async () => {
  const res = await call(h.putUsers, { body: { users: [' Partner@Voorbeeld.nl ', 'partner@voorbeeld.nl', 'mariko@voorbeeld.nl'] } });
  assert.deepEqual(res.jsonBody.users, ['partner@voorbeeld.nl']);
  assert.deepEqual(await repo.getUsers(), ['partner@voorbeeld.nl']);
  await assert.rejects(call(h.putUsers, { body: { users: ['geen-adres'] } }), { status: 400 });
});

test('gebruikers: een toegevoegde gebruiker kan zichzelf niet verwijderen', async () => {
  const partner = { email: 'partner@voorbeeld.nl', fixed: false, role: 'beheerder' };
  await assert.rejects(h.putUsers({ user: partner, repo, env, body: { users: [] } }), { status: 400, message: 'Je kunt jezelf niet verwijderen.' });
  // anderen verwijderen of zichzelf behouden mag wel
  const ok = await h.putUsers({ user: partner, repo, env, body: { users: ['partner@voorbeeld.nl', 'extra@voorbeeld.nl'] } });
  assert.equal(ok.jsonBody.users.length, 2);
  // een vaste gebruiker mag de lijst leegmaken
  assert.deepEqual((await call(h.putUsers, { body: { users: [] } })).jsonBody.users, []);
});

test('contract: periode verplicht, vaste uren en vaste tijden', async () => {
  const mk = (k) => call(h.createChild, { body: { name: 'Vast', contracts: [{ rate: '', ...k }] } });
  const ok = (await mk({ start: '2026-01-01', end: '2026-12-31', monthlyHours: '80' })).jsonBody.contracts[0];
  assert.deepEqual([ok.monthlyHours, ok.start, ok.end, ok.schedule], [80, '2026-01-01', '2026-12-31', null]);
  const rounded = (await mk({ start: '2026-03-01', end: '2026-03-31', monthlyHours: 40.256 })).jsonBody.contracts[0];
  assert.equal(rounded.monthlyHours, 40.26);
  const none = (await mk({ start: '2026-03-01', end: '2026-03-31', monthlyHours: 0 })).jsonBody.contracts[0];
  assert.equal(none.monthlyHours, null);
  // start en einde zijn verplicht en moeten kloppen
  await assert.rejects(mk({}), { status: 400 });
  await assert.rejects(mk({ start: '2026-01-01' }), { status: 400 });
  await assert.rejects(mk({ end: '2026-01-01' }), { status: 400 });
  await assert.rejects(mk({ start: '2026-05-02', end: '2026-05-01' }), { status: 400 });
  await assert.rejects(mk({ start: '2026-02-30', end: '2026-03-01' }), { status: 400 });
  await assert.rejects(mk({ start: '2026-01-01', end: '2026-12-31', monthlyHours: 800 }), { status: 400 });
  // vaste tijden: alleen geopende dagen tellen; alles gesloten = geen vaste tijden
  const closed = { open: false, from: null, to: null };
  const mon = { open: true, from: '08:00', to: '17:00' };
  const withTimes = (await mk({ start: '2026-01-01', end: '2026-12-31', schedule: [mon, closed, closed, closed, closed, closed, closed] })).jsonBody.contracts[0];
  assert.deepEqual(withTimes.schedule[0], mon);
  const allClosed = (await mk({ start: '2026-01-01', end: '2026-12-31', schedule: Array(7).fill(closed) })).jsonBody.contracts[0];
  assert.equal(allClosed.schedule, null);
  await assert.rejects(mk({ start: '2026-01-01', end: '2026-12-31', schedule: [{ open: true, from: '17:00', to: '08:00' }, ...Array(6).fill(closed)] }), { status: 400 });
  await assert.rejects(mk({ start: '2026-01-01', end: '2026-12-31', schedule: [mon] }), { status: 400 });
});

test('kind: gegevens, ouders, vakanties', async () => {
  const body = {
    firstName: ' Emma ', lastName: 'de Vries', birthDate: '2022-03-04', parents: [' Anna ', 'Piet', 'derde'],
    contracts: [K({})],
    holidays: [{ from: '2026-08-01', to: '2026-08-15' }, { from: '2026-02-14', to: '2026-02-22' }],
  };
  const c = (await call(h.createChild, { body })).jsonBody;
  assert.deepEqual([c.firstName, c.lastName, c.name, c.birthDate], ['Emma', 'de Vries', 'Emma de Vries', '2022-03-04']);
  assert.deepEqual(c.parents, ['Anna', 'Piet']);
  assert.deepEqual(c.holidays.map((x) => [x.from, x.to]), [['2026-02-14', '2026-02-22'], ['2026-08-01', '2026-08-15']]);
  // opslaan en teruglezen
  const again = (await call(h.listChildren)).jsonBody.find((x) => x.id === c.id);
  assert.deepEqual(again, c);
  // optionele velden mogen leeg
  const min = (await call(h.createChild, { body: { firstName: 'Lars' } })).jsonBody;
  assert.deepEqual([min.name, min.birthDate, min.parents, min.holidays, min.contracts], ['Lars', null, ['', ''], [], []]);
  // validatie
  const bad = (b) => assert.rejects(call(h.createChild, { body: b }), { status: 400 });
  await bad({ firstName: ' ' });
  await bad({ firstName: 'A', birthDate: '2022-02-30' });
  await bad({ firstName: 'A', birthDate: '2999-01-01' });
  await bad({ firstName: 'A', holidays: [{ from: '2026-08-15', to: '2026-08-01' }] });
  await bad({ firstName: 'A', holidays: [{ from: '2026-08-15' }] });
  await call(h.deleteChild, { params: { id: c.id } });
  await call(h.deleteChild, { params: { id: min.id } });
});

test('openingstijden: standaard, opslaan en validatie', async () => {
  let s = (await call(h.getSettings)).jsonBody.opening;
  assert.equal(s.factor, 1);
  assert.equal(s.days.length, 7);
  const days = s.days.map((d, i) => (i === 5 ? { open: true, from: '08:00', to: '12:00' } : d));
  const res = await call(h.putOpening, { body: { days, factor: '2' } });
  assert.equal(res.jsonBody.opening.factor, 2);
  s = (await call(h.getSettings)).jsonBody.opening;
  assert.deepEqual(s.days[5], { open: true, from: '08:00', to: '12:00' });
  assert.deepEqual(s.days[6], { open: false, from: null, to: null });
  const bad = (b) => assert.rejects(call(h.putOpening, { body: b }), { status: 400 });
  await bad({ days, factor: -1 });
  await bad({ days, factor: 11 });
  await bad({ days, factor: 'abc' });
  await bad({ days: days.slice(0, 6), factor: 2 });
  await bad({ days: days.map((d, i) => (i === 0 ? { open: true, from: '18:00', to: '07:00' } : d)), factor: 2 });
  await bad({ days: days.map((d, i) => (i === 0 ? { open: true, from: '7:00', to: '18:00' } : d)), factor: 2 });
});

test('contract: alleen de periode is verplicht; naam, nummer, uren en tijden zijn optioneel; vakanties doorbetalen staat standaard uit', async () => {
  const mk = (k) => call(h.createChild, { body: { firstName: 'Opt', contracts: [k] } });
  const min = (await mk({ start: '2026-01-01', end: '2026-12-31' })).jsonBody;
  const c = min.contracts[0];
  assert.deepEqual([c.number, c.rate, c.monthlyHours, c.schedule, c.paidHolidays], ['', null, null, null, false]);
  assert.equal('name' in c, false);   // een oude contractnaam wordt niet meer bewaard
  const named = (await mk({ name: 'oud', start: '2026-01-01', end: '2026-12-31' })).jsonBody.contracts[0];
  assert.equal('name' in named, false);
  // doorbetalen: alleen een echte true telt
  const paid = (await mk({ start: '2026-01-01', end: '2026-12-31', paidHolidays: true })).jsonBody.contracts[0];
  const notPaid = (await mk({ start: '2026-01-01', end: '2026-12-31', paidHolidays: 'ja' })).jsonBody.contracts[0];
  assert.deepEqual([paid.paidHolidays, notPaid.paidHolidays], [true, false]);
  // foutmeldingen noemen het contractnummer in de lijst
  await assert.rejects(call(h.createChild, { body: { firstName: 'X', contracts: [{ start: '2026-01-01', end: '2026-12-31' }, { start: '2026-01-01' }] } }),
    (e) => e.status === 400 && e.message.startsWith('Contract 2:'));
  await call(h.deleteChild, { params: { id: min.id } });
});

test('eigen kinderen: opslaan, sorteren op geboortedatum, validatie', async () => {
  const res = await call(h.putOwnChildren, { body: { ownChildren: [{ firstName: ' Sam ', birthDate: '2021-05-06' }, { firstName: 'Noor', birthDate: '2016-01-02' }] } });
  assert.deepEqual(res.jsonBody.ownChildren.map((c) => [c.firstName, c.birthDate]), [['Noor', '2016-01-02'], ['Sam', '2021-05-06']]);
  assert.ok(res.jsonBody.ownChildren.every((c) => c.id));
  assert.deepEqual((await call(h.getSettings)).jsonBody.ownChildren, res.jsonBody.ownChildren);
  const bad = (list) => assert.rejects(call(h.putOwnChildren, { body: { ownChildren: list } }), { status: 400 });
  await bad([{ firstName: ' ', birthDate: '2021-05-06' }]);
  await bad([{ firstName: 'A' }]);
  await bad([{ firstName: 'A', birthDate: '2021-02-30' }]);
  await bad([{ firstName: 'A', birthDate: '2999-01-01' }]);
  await assert.rejects(call(h.putOwnChildren, { body: {} }), { status: 400 });
  // leeg maken mag
  assert.deepEqual((await call(h.putOwnChildren, { body: { ownChildren: [] } })).jsonBody.ownChildren, []);
});

// --- Lokale accounts ---
const admin = { email: 'mariko@voorbeeld.nl', kind: 'microsoft', fixed: true, role: 'admin' };
const PW = 'koekjes-tomaat-fiets-42';
const hdr = (cookie) => ({ get: (n) => (n === 'cookie' ? cookie : null) });
const cookieOf = (res) => `${res.cookies[0].name}=${res.cookies[0].value}`;
const { authorizeSession } = require('../src/auth');
const P = require('../src/passwords');

async function newAccount(email) {
  const r = await h.createAccount({ user: admin, repo, body: { email, name: 'Test' } });
  return r.jsonBody;
}

test('account aanmaken: tijdelijk wachtwoord wordt niet leesbaar opgeslagen', async () => {
  const { tempPassword, account } = await newAccount('Lokaal1@Voorbeeld.nl');
  assert.equal(account.email, 'lokaal1@voorbeeld.nl');
  assert.equal(account.mustChange, true);
  const stored = await repo.getAccount('lokaal1@voorbeeld.nl');
  assert.ok(stored.passwordHash.startsWith('scrypt$'));
  assert.ok(!JSON.stringify(stored).includes(tempPassword));
  await assert.rejects(h.createAccount({ user: admin, repo, body: { email: 'lokaal1@voorbeeld.nl' } }), { status: 409 });
});

test('accountbeheer is alleen voor beheerders', async () => {
  await assert.rejects(h.listAccounts({ user: { ...admin, role: 'beheerder' }, repo }), { status: 403 });
  await assert.rejects(h.createAccount({ user: { kind: 'local', role: 'beheerder' }, repo, body: { email: 'x@y.nl' } }), { status: 403 });
});

test('inloggen, sessie, wachtwoord wijzigen en uitloggen', async () => {
  const { tempPassword } = await newAccount('lokaal2@voorbeeld.nl');
  const res = await h.login({ repo, body: { email: 'lokaal2@voorbeeld.nl', password: tempPassword } });
  assert.equal(res.jsonBody.mustChange, true);
  assert.equal(res.cookies[0].httpOnly, true);
  assert.equal(res.cookies[0].sameSite, 'Strict');
  const token = res.cookies[0].value;
  // Alleen de hash van de sessiesleutel staat in de opslag
  assert.ok(await repo.getSession(P.hashToken(token)));
  assert.equal(await repo.getSession(token), undefined ?? null);
  const user = await authorizeSession(hdr(cookieOf(res)), 'GET', repo);
  assert.equal(user.kind, 'local');
  assert.equal(user.mustChange, true);

  await assert.rejects(h.changePassword({ user, repo, body: { current: 'fout', next: PW } }), { status: 400 });
  await assert.rejects(h.changePassword({ user, repo, body: { current: tempPassword, next: 'kort' } }), { status: 400 });
  await h.changePassword({ user, repo, body: { current: tempPassword, next: PW } });
  assert.equal((await repo.getAccount('lokaal2@voorbeeld.nl')).mustChange, false);
  await assert.rejects(h.login({ repo, body: { email: 'lokaal2@voorbeeld.nl', password: tempPassword } }), { status: 401 });

  const second = await h.login({ repo, body: { email: 'lokaal2@voorbeeld.nl', password: PW } });
  const out = await h.logout({ repo, headers: hdr(cookieOf(second)) });
  assert.equal(out.cookies[0].maxAge, 0);
  await assert.rejects(authorizeSession(hdr(cookieOf(second)), 'GET', repo), { status: 401 });
});

test('wachtwoord wijzigen beëindigt andere sessies', async () => {
  const { tempPassword } = await newAccount('lokaal3@voorbeeld.nl');
  const a = await h.login({ repo, body: { email: 'lokaal3@voorbeeld.nl', password: tempPassword } });
  const b = await h.login({ repo, body: { email: 'lokaal3@voorbeeld.nl', password: tempPassword } });
  const user = await authorizeSession(hdr(cookieOf(a)), 'GET', repo);
  await h.changePassword({ user, repo, body: { current: tempPassword, next: PW } });
  await authorizeSession(hdr(cookieOf(a)), 'GET', repo);
  await assert.rejects(authorizeSession(hdr(cookieOf(b)), 'GET', repo), { status: 401 });
});

test('verlopen sessie wordt geweigerd', async () => {
  const { tempPassword } = await newAccount('lokaal4@voorbeeld.nl');
  const res = await h.login({ repo, body: { email: 'lokaal4@voorbeeld.nl', password: tempPassword } });
  const later = new Date(Date.now() + 8 * 86400000);
  await assert.rejects(authorizeSession(hdr(cookieOf(res)), 'GET', repo, later), { status: 401 });
});

test('blokkade na vijf mislukte pogingen, ook voor onbekende adressen', async () => {
  const { tempPassword } = await newAccount('lokaal5@voorbeeld.nl');
  for (let i = 0; i < 5; i++) await assert.rejects(h.login({ repo, body: { email: 'lokaal5@voorbeeld.nl', password: 'fout' } }), { status: 401 });
  await assert.rejects(h.login({ repo, body: { email: 'lokaal5@voorbeeld.nl', password: tempPassword } }), { status: 429 });
  const later = new Date(Date.now() + 16 * 60000);
  assert.equal((await h.login({ repo, body: { email: 'lokaal5@voorbeeld.nl', password: tempPassword }, now: later })).status, 200);
  for (let i = 0; i < 5; i++) await assert.rejects(h.login({ repo, body: { email: 'bestaat-niet@voorbeeld.nl', password: 'fout' } }), { status: 401 });
  await assert.rejects(h.login({ repo, body: { email: 'bestaat-niet@voorbeeld.nl', password: 'fout' } }), { status: 429 });
});

test('reset geeft nieuw tijdelijk wachtwoord en beëindigt sessies; verwijderen ruimt op', async () => {
  const { tempPassword } = await newAccount('lokaal6@voorbeeld.nl');
  const res = await h.login({ repo, body: { email: 'lokaal6@voorbeeld.nl', password: tempPassword } });
  const r = await h.resetAccount({ user: admin, repo, params: { email: 'lokaal6%40voorbeeld.nl' } });
  assert.notEqual(r.jsonBody.tempPassword, tempPassword);
  assert.equal((await repo.getAccount('lokaal6@voorbeeld.nl')).mustChange, true);
  await assert.rejects(authorizeSession(hdr(cookieOf(res)), 'GET', repo), { status: 401 });
  await h.login({ repo, body: { email: 'lokaal6@voorbeeld.nl', password: r.jsonBody.tempPassword } });
  assert.equal((await h.deleteAccount({ user: admin, repo, params: { email: 'lokaal6@voorbeeld.nl' } })).status, 204);
  await assert.rejects(h.login({ repo, body: { email: 'lokaal6@voorbeeld.nl', password: r.jsonBody.tempPassword } }), { status: 401 });
  const list = (await h.listAccounts({ user: admin, repo })).jsonBody;
  assert.ok(list.every((a) => !('passwordHash' in a)));
});

// --- Tweestapsverificatie ---
const T = require('../src/totp');
const tenv = { TOTP_KEY: 'test-sleutel' };

async function localUser(email) {
  const { tempPassword } = await newAccount(email);
  const login = await h.login({ repo, env: tenv, body: { email, password: tempPassword } });
  const user = await authorizeSession(hdr(cookieOf(login)), 'GET', repo);
  await h.changePassword({ user, repo, body: { current: tempPassword, next: PW } });
  return { user, email };
}

test('2FA instellen: geheim versleuteld, herstelcodes alleen als hash', async () => {
  const { user, email } = await localUser('mfa1@voorbeeld.nl');
  await assert.rejects(h.totpStart({ user, repo, env: tenv, body: { password: 'fout' } }), { status: 400 });
  const start = (await h.totpStart({ user, repo, env: tenv, body: { password: PW } })).jsonBody;
  assert.match(start.uri, /^otpauth:\/\/totp\//);
  await assert.rejects(h.totpEnable({ user, repo, env: tenv, body: { code: '000000' } }), { status: 400 });
  const now = new Date();
  const code = T.code(start.secret, Math.floor(now.getTime() / 30000));
  const { recoveryCodes } = (await h.totpEnable({ user, repo, env: tenv, body: { code }, now })).jsonBody;
  assert.equal(recoveryCodes.length, 8);
  const stored = await repo.getAccount(email);
  const dump = JSON.stringify(stored);
  assert.ok(!dump.includes(start.secret));
  for (const c of recoveryCodes) assert.ok(!dump.includes(c));
  assert.equal(T.decrypt(stored.totpSecret, tenv), start.secret);
  await assert.rejects(h.totpStart({ user, repo, env: tenv, body: { password: PW } }), { status: 409 });
});

test('inloggen met 2FA: zonder code geen sessie, code één keer bruikbaar, herstelcode eenmalig', async () => {
  const { user, email } = await localUser('mfa2@voorbeeld.nl');
  const start = (await h.totpStart({ user, repo, env: tenv, body: { password: PW } })).jsonBody;
  const t0 = new Date();
  const step = Math.floor(t0.getTime() / 30000);
  const { recoveryCodes } = (await h.totpEnable({ user, repo, env: tenv, body: { code: T.code(start.secret, step) }, now: t0 })).jsonBody;

  const first = await h.login({ repo, env: tenv, body: { email, password: PW }, now: t0 });
  assert.equal(first.jsonBody.mfaRequired, true);
  assert.equal(first.cookies, undefined);
  const ticket = first.jsonBody.ticket;
  await assert.rejects(h.loginMfa({ repo, env: tenv, body: { ticket: 'troep', code: '123456' } }), { status: 401 });
  await assert.rejects(h.loginMfa({ repo, env: tenv, body: { ticket, code: '000000' }, now: t0 }), { status: 401 });
  // De code waarmee 2FA is ingesteld is al gebruikt en werkt niet nog eens; de volgende tijdstap wel.
  await assert.rejects(h.loginMfa({ repo, env: tenv, body: { ticket, code: T.code(start.secret, step) }, now: t0 }), { status: 401 });
  const t1 = new Date(t0.getTime() + 30000);
  const ok = await h.loginMfa({ repo, env: tenv, body: { ticket, code: T.code(start.secret, step + 1) }, now: t1 });
  assert.equal(ok.status, 200);
  assert.ok(ok.cookies[0].value);
  await assert.rejects(h.loginMfa({ repo, env: tenv, body: { ticket, code: T.code(start.secret, step + 1) }, now: t1 }), { status: 401 });

  // herstelcode: werkt één keer
  const again = (await h.login({ repo, env: tenv, body: { email, password: PW }, now: t1 })).jsonBody.ticket;
  const rec = await h.loginMfa({ repo, env: tenv, body: { ticket: again, code: recoveryCodes[0].toUpperCase() }, now: t1 });
  assert.equal(rec.jsonBody.recoveryCodesLeft, 7);
  const again2 = (await h.login({ repo, env: tenv, body: { email, password: PW }, now: t1 })).jsonBody.ticket;
  await assert.rejects(h.loginMfa({ repo, env: tenv, body: { ticket: again2, code: recoveryCodes[0] }, now: t1 }), { status: 401 });
});

test('2FA: te veel foute codes blokkeren; verlopen ticket werkt niet', async () => {
  const { user, email } = await localUser('mfa3@voorbeeld.nl');
  const start = (await h.totpStart({ user, repo, env: tenv, body: { password: PW } })).jsonBody;
  const t0 = new Date();
  await h.totpEnable({ user, repo, env: tenv, body: { code: T.code(start.secret, Math.floor(t0.getTime() / 30000)) }, now: t0 });
  const ticket = (await h.login({ repo, env: tenv, body: { email, password: PW }, now: t0 })).jsonBody.ticket;
  for (let i = 0; i < 5; i++) await assert.rejects(h.loginMfa({ repo, env: tenv, body: { ticket, code: '000000' }, now: t0 }), { status: 401 });
  await assert.rejects(h.loginMfa({ repo, env: tenv, body: { ticket, code: '000000' }, now: t0 }), { status: 429 });
  await assert.rejects(h.loginMfa({ repo, env: tenv, body: { ticket, code: '000000' }, now: new Date(t0.getTime() + 6 * 60000) }), { status: 401 });
});

test('2FA uitzetten vraagt wachtwoord en code; reset door beheerder zet 2FA ook uit', async () => {
  const { user, email } = await localUser('mfa4@voorbeeld.nl');
  const start = (await h.totpStart({ user, repo, env: tenv, body: { password: PW } })).jsonBody;
  const t0 = new Date();
  const step = Math.floor(t0.getTime() / 30000);
  await h.totpEnable({ user, repo, env: tenv, body: { code: T.code(start.secret, step) }, now: t0 });
  await assert.rejects(h.totpDisable({ user, repo, env: tenv, body: { password: PW, code: '000000' }, now: t0 }), { status: 400 });
  await h.totpDisable({ user, repo, env: tenv, body: { password: PW, code: T.code(start.secret, step + 1) }, now: new Date(t0.getTime() + 30000) });
  assert.equal((await repo.getAccount(email)).totpSecret, '');
  // opnieuw aanzetten en dan resetten
  const s2 = (await h.totpStart({ user, repo, env: tenv, body: { password: PW } })).jsonBody;
  await h.totpEnable({ user, repo, env: tenv, body: { code: T.code(s2.secret, step + 2) }, now: new Date(t0.getTime() + 60000) });
  assert.ok((await repo.getAccount(email)).totpSecret);
  await h.resetAccount({ user: admin, repo, params: { email } });
  assert.equal((await repo.getAccount(email)).totpSecret, '');
});

// --- Rollen ---
const asRole = (role) => ({ email: 'rol@voorbeeld.nl', kind: 'local', role });

test('gebruiker: uren en lezen mag, wijzigen van kinderen en instellingen niet', async () => {
  const u = asRole('gebruiker');
  const call2 = (fn, extra = {}) => fn({ user: u, repo, env, params: {}, query: {}, ...extra });
  assert.equal((await call2(h.listChildren)).status, 200);
  assert.equal((await call2(h.listEntries, { query: { month: '2026-01' } })).status, 200);
  const s = (await call2(h.getSettings)).jsonBody;
  assert.deepEqual(s.users, []);
  assert.deepEqual(s.fixedUsers, []);
  assert.equal(s.runtime, undefined);
  for (const [fn, extra] of [[h.createChild, { body: { firstName: 'X', contracts: [K()] } }], [h.updateChild, { params: { id: 'x' }, body: {} }], [h.deleteChild, { params: { id: 'x' } }],
    [h.putRates, { body: { rates: [] } }], [h.putOpening, { body: {} }], [h.putOwnChildren, { body: { ownChildren: [] } }], [h.putUsers, { body: { users: [] } }]]) {
    await assert.rejects(call2(fn, extra), { status: 403 });
  }
});

test('beheerder ziet de gebruikerslijsten, maar beheert geen accounts', async () => {
  const u = asRole('beheerder');
  const s = (await h.getSettings({ user: u, repo, env })).jsonBody;
  assert.deepEqual(s.fixedUsers, ['mariko@voorbeeld.nl']);
  assert.ok(s.runtime);
  await assert.rejects(h.listAccounts({ user: u, repo }), { status: 403 });
});

test('account aanmaken met rol (standaard gebruiker) en rol wijzigen', async () => {
  const a = (await h.createAccount({ user: admin, repo, body: { email: 'rol1@voorbeeld.nl' } })).jsonBody;
  assert.equal(a.account.role, 'gebruiker');
  const b = (await h.createAccount({ user: admin, repo, body: { email: 'rol2@voorbeeld.nl', role: 'beheerder' } })).jsonBody;
  assert.equal(b.account.role, 'beheerder');
  await assert.rejects(h.createAccount({ user: admin, repo, body: { email: 'rol3@voorbeeld.nl', role: 'god' } }), { status: 400 });

  const login = await h.login({ repo, env: tenv, body: { email: 'rol1@voorbeeld.nl', password: a.tempPassword } });
  const sess = await authorizeSession(hdr(cookieOf(login)), 'GET', repo);
  assert.equal(sess.role, 'gebruiker');
  await assert.rejects(h.setAccountRole({ user: { ...admin, role: 'beheerder' }, repo, params: { email: 'rol1@voorbeeld.nl' }, body: { role: 'admin' } }), { status: 403 });
  const r = await h.setAccountRole({ user: admin, repo, params: { email: 'rol1%40voorbeeld.nl' }, body: { role: 'beheerder' } });
  assert.equal(r.jsonBody.role, 'beheerder');
  await assert.rejects(authorizeSession(hdr(cookieOf(login)), 'GET', repo), { status: 401 });   // sessies beëindigd
  await assert.rejects(h.setAccountRole({ user: admin, repo, params: { email: 'rol1@voorbeeld.nl' }, body: { role: 'x' } }), { status: 400 });
  await assert.rejects(h.setAccountRole({ user: admin, repo, params: { email: 'nietbestaand@voorbeeld.nl' }, body: { role: 'gebruiker' } }), { status: 404 });
});

test('me geeft rol en rechten', async () => {
  const r = (await h.me({ user: { ...asRole('gebruiker'), name: 'x', mustChange: false } })).jsonBody;
  assert.equal(r.role, 'gebruiker');
  assert.ok(r.permissions.includes('entries:write'));
  assert.ok(!r.permissions.includes('settings:write'));
});
