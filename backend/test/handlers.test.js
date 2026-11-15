const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { createRepo } = require('../src/repo');
const h = require('../src/handlers');
const { CODE_ADMINS } = require('../src/auth');

// Draait tegen een echte Azurite (lokale Table Storage-emulator).
let azurite, repo, dir;
const env = { ALLOWED_USERS: 'mariko@voorbeeld.nl' };
const fixedUser = { email: 'mariko@voorbeeld.nl', fixed: true, platformAdmin: true, role: 'beheerder', instanceId: 'main' };
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
  await repo.saveOrganisation({ id: 'main', name: 'Gastouder Mariko', createdAt: '2026-01-01' });
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

test('uren: bewerken (ook van datum) en meerdere tegelijk toevoegen', async () => {
  const [child] = (await call(h.listChildren)).jsonBody;
  const contractId = child.contracts[0].id;
  const base = { contractId, start: '08:00', end: '12:00', note: '' };
  const batch = (await call(h.createEntries, { body: { entries: [{ ...base, date: '2027-05-03' }, { ...base, date: '2027-05-04', start: '09:00' }] } })).jsonBody.entries;
  assert.equal(batch.length, 2);
  assert.equal((await call(h.listEntries, { query: { month: '2027-05' } })).jsonBody.length, 2);
  // bewerken: tijd en opmerking, zelfde id
  const upd = (await call(h.updateEntry, { params: { id: batch[0].id }, body: { ...base, date: '2027-05-03', end: '13:30', note: 'langer' } })).jsonBody;
  assert.equal(upd.id, batch[0].id);
  assert.equal(upd.end, '13:30');
  assert.equal(upd.note, 'langer');
  // bewerken met andere datum: nieuw id, oude weg
  const moved = (await call(h.updateEntry, { params: { id: batch[1].id }, body: { ...base, date: '2027-06-01' } })).jsonBody;
  assert.notEqual(moved.id, batch[1].id);
  assert.ok(moved.id.startsWith('2027-06-01_'));
  const mei = (await call(h.listEntries, { query: { month: '2027-05' } })).jsonBody;
  assert.deepEqual(mei.map((e) => e.id), [batch[0].id]);
  assert.equal((await call(h.listEntries, { query: { month: '2027-06' } })).jsonBody.length, 1);
  // fouten
  await assert.rejects(call(h.updateEntry, { params: { id: '2027-05-09_zzzzzz' }, body: { ...base, date: '2027-05-09' } }), { status: 404 });
  await assert.rejects(call(h.updateEntry, { params: { id: batch[0].id }, body: { ...base, date: '2027-05-03', end: '07:00' } }), { status: 400 });
  await assert.rejects(call(h.updateEntry, { params: { id: batch[0].id }, body: { ...base, date: '2027-05-03', contractId: 'bestaatniet' } }), { status: 400 });
  await assert.rejects(call(h.createEntries, { body: { entries: [] } }), { status: 400 });
  await assert.rejects(call(h.createEntries, { body: { entries: [{ ...base, date: '2027-05-05' }, { ...base, date: 'kapot' }] } }), { status: 400 });
  assert.equal((await call(h.listEntries, { query: { month: '2027-05' } })).jsonBody.length, 1);   // niets half opgeslagen
  for (const e of [batch[0], moved]) await call(h.deleteEntry, { params: { id: e.id } });
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
  assert.deepEqual(settings.fixedUsers, [...CODE_ADMINS, 'mariko@voorbeeld.nl']);
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
  const partner = { email: 'partner@voorbeeld.nl', fixed: false, role: 'beheerder', instanceId: 'main' };
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

test('vakantie van de gastouder: opslaan, sorteren, validatie, leeg maken', async () => {
  const res = await call(h.putVacations, { body: { vacations: [{ from: '2026-12-24', to: '2027-01-02', note: ' Kerst ' }, { from: '2026-07-01', to: '2026-07-14' }] } });
  assert.deepEqual(res.jsonBody.vacations.map((x) => [x.from, x.to, x.note]), [['2026-07-01', '2026-07-14', ''], ['2026-12-24', '2027-01-02', 'Kerst']]);
  assert.ok(res.jsonBody.vacations.every((x) => x.id));
  assert.deepEqual((await call(h.getSettings)).jsonBody.vacations, res.jsonBody.vacations);
  const bad = (list) => assert.rejects(call(h.putVacations, { body: { vacations: list } }), { status: 400 });
  await bad([{ from: '2026-07-10', to: '2026-07-01' }]);
  await bad([{ from: '2026-07-10' }]);
  await bad([{ from: '2026-02-30', to: '2026-03-01' }]);
  await assert.rejects(call(h.putVacations, { body: {} }), { status: 400 });
  assert.deepEqual((await call(h.putVacations, { body: { vacations: [] } })).jsonBody.vacations, []);
});

test('begindatum gastouder: instellen, wissen, validatie; uren ervoor worden genegeerd', async () => {
  assert.equal((await call(h.getSettings)).jsonBody.startDate, null);
  const [child] = (await call(h.listChildren)).jsonBody;
  const contractIdForStartTest = child.contracts[0].id;
  await call(h.createEntry, { body: { date: '2027-03-02', contractId: contractIdForStartTest, start: '08:00', end: '12:00' } });
  await call(h.createEntry, { body: { date: '2027-03-20', contractId: contractIdForStartTest, start: '08:00', end: '12:00' } });
  assert.equal((await call(h.listEntries, { query: { month: '2027-03' } })).jsonBody.length, 2);
  assert.equal((await call(h.putStartDate, { body: { startDate: '2027-03-10' } })).jsonBody.startDate, '2027-03-10');
  assert.equal((await call(h.getSettings)).jsonBody.startDate, '2027-03-10');
  assert.deepEqual((await call(h.listEntries, { query: { month: '2027-03' } })).jsonBody.map((e) => e.date), ['2027-03-20']);
  assert.equal((await call(h.listEntries, { query: { month: '2027-02' } })).jsonBody.length, 0);
  await assert.rejects(call(h.createEntry, { body: { date: '2027-03-09', contractId: contractIdForStartTest, start: '08:00', end: '09:00' } }), { status: 400 });
  await call(h.createEntry, { body: { date: '2027-03-10', contractId: contractIdForStartTest, start: '08:00', end: '09:00' } });
  await assert.rejects(call(h.putStartDate, { body: { startDate: '2027-02-30' } }), { status: 400 });
  await assert.rejects(call(h.putStartDate, { body: {} }), { status: 400 });
  assert.equal((await call(h.putStartDate, { body: { startDate: null } })).jsonBody.startDate, null);
  assert.equal((await call(h.listEntries, { query: { month: '2027-03' } })).jsonBody.length, 3);   // de ingevulde uren bleven bewaard
});

// --- Lokale accounts ---
const admin = { email: 'mariko@voorbeeld.nl', kind: 'microsoft', fixed: true, platformAdmin: true, role: 'beheerder', instanceId: 'main' };   // beheerder van main en platformbeheerder
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

test('accountbeheer is niet voor gebruikers', async () => {
  await assert.rejects(h.listAccounts({ user: { ...admin, role: 'gebruiker' }, repo }), { status: 403 });
  await assert.rejects(h.createAccount({ user: { kind: 'local', role: 'gebruiker', instanceId: 'main' }, repo, body: { email: 'x@y.nl' } }), { status: 403 });
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
const asRole = (role) => ({ email: 'rol@voorbeeld.nl', kind: 'local', role, instanceId: 'main' });

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
    [h.putRates, { body: { rates: [] } }], [h.putOpening, { body: {} }], [h.putOwnChildren, { body: { ownChildren: [] } }], [h.putVacations, { body: { vacations: [] } }], [h.putStartDate, { body: { startDate: null } }], [h.putUsers, { body: { users: [] } }]]) {
    await assert.rejects(call2(fn, extra), { status: 403 });
  }
});

test('beheerder ziet de gebruikerslijsten en technische info', async () => {
  const u = asRole('beheerder');
  const s = (await h.getSettings({ user: u, repo, env })).jsonBody;
  assert.deepEqual(s.fixedUsers, [...CODE_ADMINS, 'mariko@voorbeeld.nl']);
  assert.ok(s.runtime);
});

test('account aanmaken met rol (standaard gebruiker) en rol wijzigen', async () => {
  const a = (await h.createAccount({ user: admin, repo, body: { email: 'rol1@voorbeeld.nl' } })).jsonBody;
  assert.equal(a.account.role, 'gebruiker');
  assert.equal(a.existing, false);
  const b = (await h.createAccount({ user: admin, repo, body: { email: 'rol2@voorbeeld.nl', role: 'beheerder' } })).jsonBody;
  assert.equal(b.account.role, 'beheerder');
  await assert.rejects(h.createAccount({ user: admin, repo, body: { email: 'rol3@voorbeeld.nl', role: 'god' } }), { status: 400 });
  await assert.rejects(h.createAccount({ user: admin, repo, body: { email: 'rol3@voorbeeld.nl', role: 'admin' } }), { status: 400 });   // admin is geen rol in een organisatie

  const login = await h.login({ repo, env: tenv, body: { email: 'rol1@voorbeeld.nl', password: a.tempPassword } });
  const sess = await authorizeSession(hdr(cookieOf(login)), 'GET', repo);
  assert.equal(sess.role, 'gebruiker');
  assert.equal(sess.instanceId, 'main');
  await assert.rejects(h.setAccountRole({ user: { ...admin, role: 'gebruiker' }, repo, params: { email: 'rol1@voorbeeld.nl' }, body: { role: 'beheerder' } }), { status: 403 });
  const r = await h.setAccountRole({ user: admin, repo, params: { email: 'rol1%40voorbeeld.nl' }, body: { role: 'beheerder' } });
  assert.equal(r.jsonBody.role, 'beheerder');
  assert.equal((await authorizeSession(hdr(cookieOf(login)), 'GET', repo)).role, 'beheerder');   // geldt meteen, zonder opnieuw inloggen
  await assert.rejects(h.setAccountRole({ user: admin, repo, params: { email: 'rol1@voorbeeld.nl' }, body: { role: 'x' } }), { status: 400 });
  await assert.rejects(h.setAccountRole({ user: admin, repo, params: { email: 'nietbestaand@voorbeeld.nl' }, body: { role: 'gebruiker' } }), { status: 404 });
});

test('me geeft rol en rechten', async () => {
  const r = (await h.me({ user: { ...asRole('gebruiker'), name: 'x', mustChange: false } })).jsonBody;
  assert.equal(r.role, 'gebruiker');
  assert.ok(r.permissions.includes('entries:write'));
  assert.ok(!r.permissions.includes('settings:write'));
});

// --- Beheerder beheert lokale accounts, binnen de eigen organisatie ---
const beheerder = { email: 'beh@voorbeeld.nl', kind: 'local', role: 'beheerder', instanceId: 'main' };

test('beheerder maakt gebruikers en beheerders aan, geen andere rollen', async () => {
  const g = await h.createAccount({ user: beheerder, repo, body: { email: 'bg1@voorbeeld.nl', role: 'gebruiker' } });
  assert.equal(g.status, 201);
  assert.equal((await h.createAccount({ user: beheerder, repo, body: { email: 'bg2@voorbeeld.nl', role: 'beheerder' } })).status, 201);
  await assert.rejects(h.createAccount({ user: beheerder, repo, body: { email: 'bg3@voorbeeld.nl', role: 'admin' } }), { status: 400 });
  assert.equal(await repo.getAccount('bg3@voorbeeld.nl'), null);
  assert.equal((await repo.getMembership('main', 'bg1@voorbeeld.nl')).role, 'gebruiker');
  assert.equal((await repo.getAccount('bg1@voorbeeld.nl')).instanceId, 'main');
  await assert.rejects(h.createAccount({ user: beheerder, repo, body: { email: 'bg1@voorbeeld.nl' } }), { status: 409 });   // al lid
});

test('een beheerder beheert zijn eigen lidmaatschap niet', async () => {
  await h.createAccount({ user: admin, repo, body: { email: beheerder.email, role: 'beheerder' } });
  const p = { email: beheerder.email };
  await assert.rejects(h.setAccountRole({ user: beheerder, repo, params: p, body: { role: 'gebruiker' } }), { status: 403 });
  await assert.rejects(h.deleteAccount({ user: beheerder, repo, params: p }), { status: 403 });
  await assert.rejects(h.resetAccount({ user: beheerder, repo, params: p }), { status: 403 });
  assert.equal((await repo.getMembership('main', beheerder.email)).role, 'beheerder');
  // een andere beheerder beheren mag wel
  await h.createAccount({ user: beheerder, repo, body: { email: 'bg4@voorbeeld.nl', role: 'beheerder' } });
  assert.equal((await h.setAccountRole({ user: beheerder, repo, params: { email: 'bg4@voorbeeld.nl' }, body: { role: 'gebruiker' } })).status, 200);
  assert.equal((await h.resetAccount({ user: beheerder, repo, params: { email: 'bg4@voorbeeld.nl' } })).status, 200);
});

test('de lijst toont alleen de leden van de eigen organisatie, met wat beheerbaar is', async () => {
  await repo.saveOrganisation({ id: 'andere', name: 'Andere organisatie', createdAt: '2026-01-01' });
  await repo.saveAccount({ email: 'vreemd@voorbeeld.nl', role: 'gebruiker', instanceId: 'andere', passwordHash: 'x', createdAt: '2026-01-01' });
  await repo.saveMembership({ orgId: 'andere', email: 'vreemd@voorbeeld.nl', role: 'gebruiker' });
  const list = (await h.listAccounts({ user: beheerder, repo })).jsonBody;
  assert.ok(!list.some((a) => a.email === 'vreemd@voorbeeld.nl'));
  assert.equal(list.find((a) => a.email === beheerder.email).manageable, false);
  assert.equal(list.find((a) => a.email === 'bg1@voorbeeld.nl').manageable, true);
  assert.ok(list.every((a) => !('passwordHash' in a)));
  // een account van een andere organisatie is in deze organisatie niet te beheren
  for (const fn of [h.resetAccount, h.deleteAccount, h.setAccountRole]) {
    await assert.rejects(fn({ user: beheerder, repo, params: { email: 'vreemd@voorbeeld.nl' }, body: { role: 'beheerder' } }), { status: 404 });
  }
  assert.ok(await repo.getAccount('vreemd@voorbeeld.nl'));
});

test('iemand die al een account heeft wordt alleen lid: geen tijdelijk wachtwoord, eigen wachtwoord blijft', async () => {
  await repo.saveAccount({ email: 'elders@voorbeeld.nl', role: 'gebruiker', instanceId: 'andere', passwordHash: await P.hashPassword(PW), createdAt: '2026-01-01' });
  await repo.saveMembership({ orgId: 'andere', email: 'elders@voorbeeld.nl', role: 'gebruiker' });
  const add = (await h.createAccount({ user: beheerder, repo, body: { email: 'elders@voorbeeld.nl', role: 'gebruiker' } })).jsonBody;
  assert.equal(add.existing, true);
  assert.equal(add.tempPassword, null);
  assert.equal((await h.login({ repo, env: tenv, body: { email: 'elders@voorbeeld.nl', password: PW } })).status, 200);   // eigen wachtwoord werkt nog
  assert.deepEqual((await repo.listMembershipsOf('elders@voorbeeld.nl')).map((m) => m.orgId).sort(), ['andere', 'main']);
});

test('een wachtwoord resetten kan alleen als het account nergens anders lid is', async () => {
  // elders@ is lid van main en andere: de beheerder van main mag niet resetten (anders neemt hij het account over)
  await assert.rejects(h.resetAccount({ user: beheerder, repo, params: { email: 'elders@voorbeeld.nl' } }), { status: 403, message: /ook bij een andere organisatie/ });
  assert.equal((await h.login({ repo, env: tenv, body: { email: 'elders@voorbeeld.nl', password: PW } })).status, 200);   // ongewijzigd
});

test('verwijderen haalt het lidmaatschap weg; het account pas als er geen lidmaatschap meer is', async () => {
  assert.equal((await h.deleteAccount({ user: beheerder, repo, params: { email: 'elders@voorbeeld.nl' } })).status, 204);
  assert.equal(await repo.getMembership('main', 'elders@voorbeeld.nl'), null);
  assert.ok(await repo.getAccount('elders@voorbeeld.nl'));   // nog lid van andere
  const sess = await authorizeSession(hdr(cookieOf(await h.login({ repo, env: tenv, body: { email: 'elders@voorbeeld.nl', password: PW } }))), 'GET', repo, new Date(), env);
  assert.equal(sess.instanceId, 'andere');   // hij komt nu alleen nog in zijn andere organisatie
  assert.equal((await h.deleteAccount({ user: beheerder, repo, params: { email: 'bg1@voorbeeld.nl' } })).status, 204);
  assert.equal(await repo.getAccount('bg1@voorbeeld.nl'), null);   // geen lidmaatschap meer: account weg
});


// --- Gastouder ziek melden ---
test('ziek melden: toevoegen, dubbel is niets, gesorteerd, weer weghalen', async () => {
  await repo.setSickDays([]);
  await repo.setStartDate(null);
  assert.deepEqual((await call(h.putSickDay, { body: { date: '2026-03-12' } })).jsonBody.sickDays, ['2026-03-12']);
  assert.deepEqual((await call(h.putSickDay, { body: { date: '2026-03-05', sick: true } })).jsonBody.sickDays, ['2026-03-05', '2026-03-12']);
  assert.deepEqual((await call(h.putSickDay, { body: { date: '2026-03-05' } })).jsonBody.sickDays, ['2026-03-05', '2026-03-12']);   // al ziek gemeld
  assert.deepEqual(await repo.getSickDays(), ['2026-03-05', '2026-03-12']);
  assert.deepEqual((await call(h.getSettings)).jsonBody.sickDays, ['2026-03-05', '2026-03-12']);
  assert.deepEqual((await call(h.putSickDay, { body: { date: '2026-03-05', sick: false } })).jsonBody.sickDays, ['2026-03-12']);
  assert.deepEqual((await call(h.putSickDay, { body: { date: '2026-03-31', sick: false } })).jsonBody.sickDays, ['2026-03-12']);   // was niet ziek: niets te doen
  await call(h.putSickDay, { body: { date: '2026-03-12', sick: false } });
  assert.deepEqual(await repo.getSickDays(), []);
});

test('ziek melden: validatie, begindatum en maximum', async () => {
  for (const body of [undefined, {}, { date: '' }, { date: '12-03-2026' }, { date: '2026-02-30' }, { date: '2026-03-12', sick: 'ja' }]) {
    await assert.rejects(call(h.putSickDay, { body }), { status: 400 }, JSON.stringify(body));
  }
  await repo.setStartDate('2026-02-01');
  await assert.rejects(call(h.putSickDay, { body: { date: '2026-01-31' } }), { status: 400, message: /begindatum/ });
  assert.equal((await call(h.putSickDay, { body: { date: '2026-02-01' } })).status, 200);
  await call(h.putSickDay, { body: { date: '2026-02-01', sick: false } });
  assert.equal((await call(h.putSickDay, { body: { date: '2026-01-31', sick: false } })).status, 200);   // weghalen mag altijd
  await repo.setStartDate(null);
  await repo.setSickDays(Array.from({ length: 1000 }, (_, i) => new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10)));
  await assert.rejects(call(h.putSickDay, { body: { date: '2030-01-01' } }), { status: 400, message: /maximaal 1000/ });
  assert.equal((await call(h.putSickDay, { body: { date: '2020-01-01', sick: false } })).jsonBody.sickDays.length, 999);
  await repo.setSickDays([]);
});

test('ziek melden mag elke gebruiker die uren invult; platformbeheer zonder lidmaatschap niet', async () => {
  const u = { email: 'rol@voorbeeld.nl', kind: 'local', role: 'gebruiker', instanceId: 'main' };
  assert.equal((await h.putSickDay({ user: u, repo, env, params: {}, query: {}, body: { date: '2026-04-01' } })).status, 200);
  assert.deepEqual((await h.getSettings({ user: u, repo, env })).jsonBody.sickDays, ['2026-04-01']);   // ook zichtbaar voor een gebruiker
  const platform = { email: 'p@voorbeeld.nl', kind: 'microsoft', platformAdmin: true, role: null, instanceId: null };
  await assert.rejects(h.putSickDay({ user: platform, repo, env, body: { date: '2026-04-02' } }), { status: 403 });
  await repo.setSickDays([]);
});

test('gastouderbureaus: platformbeheer maakt de lijst, de gastouder kiest, het contract verwijst', async () => {
  const admin = require('../src/admin-handlers');
  const plain = { email: 'mw@voorbeeld.nl', kind: 'local', role: 'beheerder', instanceId: 'main' };   // beheerder, maar geen platformbeheerder
  await assert.rejects(admin.createAgency({ user: plain, repo, env, params: {}, body: { name: 'X' } }), (e) => e.status === 403);
  const a = (await call(admin.createAgency, { body: { name: 'Bureau Zon' } })).jsonBody;
  const b = (await call(admin.createAgency, { body: { name: 'Bureau Maan' } })).jsonBody;
  await assert.rejects(call(admin.createAgency, { body: { name: 'bureau zon' } }), (e) => e.status === 409);   // dubbel
  await assert.rejects(call(admin.createAgency, { body: { name: '  ' } }), (e) => e.status === 400);
  assert.deepEqual((await call(h.getSettings)).jsonBody.agencies.map((x) => x.name), ['Bureau Maan', 'Bureau Zon']);
  // aansluiten: alleen bestaande bureaus
  await assert.rejects(call(h.putAgencyIds, { body: { agencyIds: ['bestaatniet1'] } }), (e) => e.status === 400);
  await assert.rejects(call(h.putAgencyIds, { body: { agencyIds: 'zon' } }), (e) => e.status === 400);
  assert.deepEqual((await call(h.putAgencyIds, { body: { agencyIds: [a.id, a.id] } })).jsonBody.agencyIds, [a.id]);
  // een contract mag alleen verwijzen naar een bureau waarbij je bent aangesloten
  await assert.rejects(call(h.createChild, { body: { firstName: 'Bureaukind', contracts: [K({ agencyId: b.id })] } }), (e) => e.status === 400);
  const kid = (await call(h.createChild, { body: { firstName: 'Bureaukind', contracts: [K({ agencyId: a.id }), K({})] } })).jsonBody;
  assert.equal(kid.contracts[0].agencyId, a.id);
  assert.equal(kid.contracts[1].agencyId, null);
  // niet-actief: niet meer te kiezen, maar de bestaande verwijzing blijft geldig
  await call(admin.updateAgency, { params: { id: a.id }, body: { active: false } });
  assert.equal((await call(h.putAgencyIds, { body: { agencyIds: [a.id] } })).status, 200);   // blijven staan mag
  await assert.rejects(call(h.putAgencyIds, { body: { agencyIds: [a.id, b.id, 'nietactief1'] } }), (e) => e.status === 400);
  assert.equal((await call(h.updateChild, { params: { id: kid.id }, body: { firstName: 'Bureaukind', contracts: kid.contracts } })).jsonBody.contracts[0].agencyId, a.id);
  // hernoemen en weer activeren
  const renamed = (await call(admin.updateAgency, { params: { id: a.id }, body: { name: 'Bureau Zonnig', active: true } })).jsonBody;
  assert.deepEqual([renamed.name, renamed.active], ['Bureau Zonnig', true]);
  await assert.rejects(call(admin.updateAgency, { params: { id: a.id }, body: { name: 'Bureau Maan' } }), (e) => e.status === 409);
  await assert.rejects(call(admin.updateAgency, { params: { id: 'bestaatniet1' }, body: { active: false } }), (e) => e.status === 404);
});

test('import van de Excel-planning: alleen platformbeheer, voorbeeld zonder opslaan, daarna toevoegen en niet dubbel', async () => {
  const admin = require('../src/admin-handlers');
  const { xlsx, serial, time } = require('./xlsx-helper');
  const file = xlsx({
    Kinderen: { B2: 'Kinderen', C2: 'Geboortedatum', F2: 'Achternaam', G2: 'Contract nummer', H2: 'Vaste tijden',
      B3: 'Vrij', B4: 'Imp', C4: serial('2022-03-22'), F4: 'Eerste', G4: '2024.00160', H4: '08:30-17:00', B5: 'Tweede', F5: 'Kind', B6: 'Zonder', C6: 7, D6: { f: 'IF(1,2)', v: 3 } },
    2025: { A1: serial('2025-01-01'),
      B4: serial('2025-01-06'), E4: serial('2025-01-07'), B5: 'Imp', C5: time('08:30'), D5: time('17:00'), B6: 'Tweede', C6: time('09:00'), D6: time('12:15'),
      B7: 'Onbekend', C7: time('09:00'), D7: time('10:00'), B8: 'Week', C8: 3, E5: 'Vrij', E6: 'Imp', F6: time('10:00'), G6: time('09:00'),
      B12: serial('2025-01-13'), B13: 'Imp', C13: time('10:00'), D13: time('11:00'), E12: serial('2024-12-31'), E13: 'Imp', F13: time('08:00'), G13: time('09:00') },
    'Over de jaren': { A1: 'x' },
  });
  const user = fixedUser, plain = { ...fixedUser, platformAdmin: false };
  const b64 = file.toString('base64');
  await assert.rejects(admin.importPlanning({ user: plain, repo, env, params: {}, body: { file: b64 } }), (e) => e.status === 403);
  await assert.rejects(call(admin.importPlanning, { body: { file: Buffer.from('geen zip').toString('base64') } }), (e) => e.status === 400);
  await assert.rejects(call(admin.importPlanning, { body: {} }), (e) => e.status === 400);

  const before = (await repo.listChildren()).length;
  const preview = (await call(admin.importPlanning, { body: { file: b64 } })).jsonBody;
  assert.equal(preview.applied, false);
  assert.equal(preview.year, 2025);
  assert.deepEqual(preview.children.map((c) => [c.name, c.child, c.entries]), [['Imp Eerste', 'nieuw', 2], ['Tweede Kind', 'nieuw', 1], ['Zonder', 'nieuw', 0]]);
  assert.equal(preview.entries.minutes, 8.5 * 60 + 3.25 * 60 + 60);   // 08:30–17:00, 09:00–12:15 en 10:00–11:00
  assert.equal(preview.entries.outside, 1);                       // 31-12-2024 valt buiten het jaar
  assert.ok(preview.warnings.some((w) => /Onbekend/.test(w)) && preview.warnings.some((w) => /eindtijd/.test(w)));
  assert.equal((await repo.listChildren()).length, before);       // voorbeeld slaat niets op

  const done = (await call(admin.importPlanning, { body: { file: b64, apply: true } })).jsonBody;
  assert.equal(done.applied, true);
  const kids = await repo.listChildren(), imp = kids.find((c) => c.name === 'Imp Eerste');
  assert.equal(kids.length, before + 3);
  assert.equal(imp.birthDate, '2022-03-22');
  assert.equal(imp.contracts.length, 1);
  assert.deepEqual([imp.contracts[0].start, imp.contracts[0].end, imp.contracts[0].number, imp.contracts[0].rate, imp.contracts[0].schedule], ['2025-01-01', '2025-12-31', '2024.00160', null, null]);
  assert.equal(kids.find((c) => c.name === 'Zonder').birthDate, null);   // een getal is geen geboortedatum
  const entries = (await repo.listAllEntries()).filter((e) => e.contractId === imp.contracts[0].id).map((e) => `${e.date} ${e.start}-${e.end}`).sort();
  assert.deepEqual(entries, ['2025-01-06 08:30-17:00', '2025-01-13 10:00-11:00']);

  // nog een keer: niets erbij
  const again = (await call(admin.importPlanning, { body: { file: b64, apply: true } })).jsonBody;
  assert.deepEqual(again.children.map((c) => [c.child, c.contract, c.entries, c.duplicates]), [['bestaat al', 'bestaand', 0, 2], ['bestaat al', 'bestaand', 0, 1], ['bestaat al', 'bestaand', 0, 0]]);
  assert.equal((await repo.listChildren()).length, before + 3);
  assert.equal((await repo.listAllEntries()).filter((e) => e.contractId === imp.contracts[0].id).length, 2);
});

test('instellingen bevatten de datum van de eerste registratie', async () => {
  const all = await repo.listAllEntries();
  const first = all.map((e) => e.date).sort()[0] || null;
  assert.equal((await call(h.getSettings)).jsonBody.firstEntry, first);
  assert.ok(first, 'er zijn registraties in deze testreeks');
});

test('foto van een kind: klein JPEG, optioneel, blijft staan als je niets meestuurt', async () => {
  const jpeg = 'data:image/jpeg;base64,' + Buffer.from('kleine foto').toString('base64');
  await assert.rejects(call(h.createChild, { body: { firstName: 'Foto', photo: 'data:text/html;base64,PHNjcmlwdD4=' } }), (e) => e.status === 400);
  await assert.rejects(call(h.createChild, { body: { firstName: 'Foto', photo: 'https://voorbeeld.nl/x.jpg' } }), (e) => e.status === 400);
  await assert.rejects(call(h.createChild, { body: { firstName: 'Foto', photo: 'data:image/jpeg;base64,' + 'A'.repeat(30000) } }), (e) => e.status === 400);
  const kid = (await call(h.createChild, { body: { firstName: 'Foto', photo: jpeg, contracts: [K({})] } })).jsonBody;
  assert.equal(kid.photo, jpeg);
  assert.equal((await call(h.listChildren)).jsonBody.find((c) => c.id === kid.id).photo, jpeg);
  // zonder photo in het verzoek blijft de foto; met null gaat hij weg
  assert.equal((await call(h.updateChild, { params: { id: kid.id }, body: { firstName: 'Foto', contracts: kid.contracts } })).jsonBody.photo, jpeg);
  assert.equal((await call(h.updateChild, { params: { id: kid.id }, body: { firstName: 'Foto', contracts: kid.contracts, photo: null } })).jsonBody.photo, null);
  assert.equal((await call(h.createChild, { body: { firstName: 'Zonderfoto' } })).jsonBody.photo, null);
});
