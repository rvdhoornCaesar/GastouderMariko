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
const fixedUser = { email: 'mariko@voorbeeld.nl', fixed: true };
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
  const res = await call(h.createChild, { body: { name: ' Noah ', contracts: [{ name: 'Ma-Wo', rate: 8.5 }] } });
  assert.equal(res.status, 201);
  assert.equal(res.jsonBody.name, 'Noah');
  assert.ok(res.jsonBody.contracts[0].id);
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
  await assert.rejects(call(h.createChild, { body: { name: 'A', contracts: [{ name: 'k', rate: -1 }] } }), { status: 400 });
  await assert.rejects(call(h.listEntries, { query: { month: '2026-13' } }), { status: 400 });
});

test('contract verwijderen en kind verwijderen nemen uren mee', async () => {
  const child = (await call(h.createChild, { body: { name: 'Sam', contracts: [{ name: 'A', rate: 9 }, { name: 'B', rate: 10 }] } })).jsonBody;
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
  const res = await call(h.createChild, { body: { name: 'Lisa', contracts: [{ name: 'Standaard', rate: '' }, { name: 'Vast', rate: 9.456 }] } });
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
  const partner = { email: 'partner@voorbeeld.nl', fixed: false };
  await assert.rejects(h.putUsers({ user: partner, repo, env, body: { users: [] } }), { status: 400, message: 'Je kunt jezelf niet verwijderen.' });
  // anderen verwijderen of zichzelf behouden mag wel
  const ok = await h.putUsers({ user: partner, repo, env, body: { users: ['partner@voorbeeld.nl', 'extra@voorbeeld.nl'] } });
  assert.equal(ok.jsonBody.users.length, 2);
  // een vaste gebruiker mag de lijst leegmaken
  assert.deepEqual((await call(h.putUsers, { body: { users: [] } })).jsonBody.users, []);
});

test('vaste uren per maand: startmaand verplicht, periode gecontroleerd', async () => {
  const mk = (k) => call(h.createChild, { body: { name: 'Vast', contracts: [{ name: 'Vast', rate: '', ...k }] } });
  const ok = (await mk({ monthlyHours: '80', from: '2026-01', until: '2026-12' })).jsonBody.contracts[0];
  assert.deepEqual([ok.monthlyHours, ok.from, ok.until], [80, '2026-01', '2026-12']);
  const open = (await mk({ monthlyHours: 40.256, from: '2026-03' })).jsonBody.contracts[0];
  assert.deepEqual([open.monthlyHours, open.until], [40.26, null]);
  const none = (await mk({ monthlyHours: 0, from: '2026-03' })).jsonBody.contracts[0];
  assert.deepEqual([none.monthlyHours, none.from, none.until], [null, null, null]);
  await assert.rejects(mk({ monthlyHours: 80 }), { status: 400 });
  await assert.rejects(mk({ monthlyHours: 80, from: '2026-05', until: '2026-04' }), { status: 400 });
  await assert.rejects(mk({ monthlyHours: 800, from: '2026-05' }), { status: 400 });
  await assert.rejects(mk({ monthlyHours: 80, from: '2026-13' }), { status: 400 });
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
