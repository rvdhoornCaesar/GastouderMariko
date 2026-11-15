const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { TableClient } = require('@azure/data-tables');
const { createRepo } = require('../src/repo');
const h = require('../src/handlers');

// Twee (en drie) administraties naast elkaar in dezelfde tabellen: niets van de een mag bij de ander.
const PORT = 10115;
const CONN = `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;TableEndpoint=http://127.0.0.1:${PORT}/devstoreaccount1;`;
let azurite, dir, base, A, B, C;
const env = { ALLOWED_USERS: '' };
const beheerder = (instanceId) => ({ email: `beheerder@${instanceId}.nl`, kind: 'local', role: 'beheerder', instanceId });
const call = (fn, user, extra = {}, repo) => fn({ user, repo: repo || base.forInstance(user.instanceId), env, params: {}, query: {}, ...extra });
const K = (k) => ({ start: '2026-01-01', end: '2026-12-31', ...k });

const waitForPort = (port) => new Promise((resolve, reject) => {
  const deadline = Date.now() + 20000;
  (function try_() {
    const s = net.connect(port, '127.0.0.1').once('connect', () => { s.destroy(); resolve(); })
      .once('error', () => { s.destroy(); Date.now() > deadline ? reject(new Error('Azurite start niet')) : setTimeout(try_, 200); });
  })();
});

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azurite-iso-'));
  azurite = spawn(process.execPath, [require.resolve('azurite/dist/src/table/main.js'), '--silent', '--location', dir, '--tablePort', String(PORT), '--skipApiVersionCheck'], { stdio: 'inherit' });
  await waitForPort(PORT);
  base = createRepo(CONN);
  A = base.forInstance('main'); B = base.forInstance('andere'); C = base.forInstance('derde-1');
});
test.after(() => { azurite.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

test('een administratie-id moet veilig zijn om als sleutel en in een filter te gebruiken', () => {
  for (const bad of ['', 'Main', 'a b', "x' or PartitionKey ne 'x", '../main', 'a/b', 'a#b', 'a?b', '-a', 'x'.repeat(41), null, undefined, 7]) {
    assert.throws(() => base.forInstance(bad), /Ongeldige administratie/, String(bad));
  }
  assert.equal(createRepo(CONN).instanceId, 'main');   // zonder id: de eerste administratie, zoals voorheen
  assert.equal(base.forInstance('abc-123').instanceId, 'abc-123');
});

test('kinderen: zelfde id in twee administraties botst niet, lezen en verwijderen blijven binnen de eigen administratie', async () => {
  const kind = (name) => ({ id: 'k1', name, firstName: name, lastName: '', birthDate: '2024-01-01', parents: ['', ''], contracts: [{ id: 'c1', start: '2026-01-01', end: '2026-12-31' }], holidays: [] });
  await A.saveChild(kind('Noor'));
  await B.saveChild(kind('Bram'));
  assert.equal((await A.getChild('k1')).firstName, 'Noor');
  assert.equal((await B.getChild('k1')).firstName, 'Bram');
  assert.deepEqual((await A.listChildren()).map((c) => c.firstName), ['Noor']);
  assert.deepEqual((await C.listChildren()), []);
  assert.equal(await C.getChild('k1'), null);
  await B.deleteChild('k1');
  assert.equal(await B.getChild('k1'), null);
  assert.equal((await A.getChild('k1')).firstName, 'Noor');   // niet mee verwijderd
});

test('uren: lijsten per maand, verwijderen en verwijderen per contract blijven binnen de eigen administratie', async () => {
  const e = (note) => ({ id: '2026-03-04_aaaa', contractId: 'c1', start: '08:00', end: '17:00', note });
  await A.saveEntry(e('van A'));
  await B.saveEntry(e('van B'));
  assert.deepEqual((await A.listEntriesOfMonth('2026-03')).map((x) => x.note), ['van A']);
  assert.deepEqual((await B.listEntriesOfMonth('2026-03')).map((x) => x.note), ['van B']);
  assert.deepEqual(await C.listEntriesOfMonth('2026-03'), []);
  await B.deleteEntriesOfContracts(['c1']);   // zelfde contract-id, andere administratie
  assert.deepEqual(await B.listEntriesOfMonth('2026-03'), []);
  assert.equal((await A.getEntry('2026-03-04_aaaa')).note, 'van A');
  await C.deleteEntry('2026-03-04_aaaa').catch(() => {});   // bestaat bij C niet: mag A niet raken
  assert.equal((await A.getEntry('2026-03-04_aaaa')).note, 'van A');
});

test('instellingen: elke administratie heeft eigen tarieven, openingstijden, gebruikers, begindatum, vakanties en eigen kinderen', async () => {
  await A.setRates([{ id: 'r1', from: '2026-01-01', to: null, rate: 8.5 }]);
  await A.setUsers(['a@a.nl']);
  await A.setStartDate('2026-02-01');
  await A.setVacations([{ id: 'v1', from: '2026-07-01', to: '2026-07-14' }]);
  await A.setOwnChildren([{ id: 'o1', firstName: 'Eigen', birthDate: '2020-01-01' }]);
  await A.setOpening({ days: [], factor: 1.5 });
  await B.setRates([{ id: 'r9', from: '2026-01-01', to: null, rate: 11 }]);
  assert.equal((await A.getRates())[0].rate, 8.5);
  assert.equal((await B.getRates())[0].rate, 11);
  // wat B niet heeft ingesteld, erft hij niet van A
  assert.deepEqual(await B.getUsers(), []);
  assert.equal(await B.getStartDate(), null);
  assert.deepEqual(await B.getVacations(), []);
  assert.deepEqual(await B.getOwnChildren(), []);
  assert.equal(await B.getOpening(), null);
  assert.deepEqual(await C.getRates(), []);
  assert.equal((await A.getStartDate()), '2026-02-01');
});

test('een rij van een andere administratie komt nooit door een lijst, ook niet als hij zomaar in de tabel staat', async () => {
  const t = (n) => TableClient.fromConnectionString(CONN, n, { allowInsecureConnection: true });
  await t('children').upsertEntity({ partitionKey: 'derde-1', rowKey: 'k77', name: 'Vreemd', contracts: '[]' }, 'Replace');
  await t('entries').upsertEntity({ partitionKey: 'derde-1', rowKey: '2026-03-05_zzzz', contractId: 'c1', start: '08:00', end: '09:00', note: 'vreemd' }, 'Replace');
  assert.ok(!(await A.listChildren()).some((c) => c.id === 'k77'));
  assert.ok(!(await A.listEntriesOfMonth('2026-03')).some((x) => x.note === 'vreemd'));
  assert.equal(await A.getChild('k77'), null);
  assert.equal((await C.getChild('k77')).firstName, 'Vreemd');
});

test('accounts, sessies en identiteiten zijn bewust globaal: elke gebonden repo ziet dezelfde', async () => {
  await A.saveAccount({ email: 'iemand@x.nl', role: 'gebruiker', instanceId: 'main', passwordHash: 'x', createdAt: '2026-01-01' });
  assert.equal((await B.getAccount('iemand@x.nl')).instanceId, 'main');   // het account zelf zegt bij welke administratie hij hoort
  await A.setIdentity('k', 'iemand@x.nl');
  assert.equal(await C.getIdentity('k'), 'iemand@x.nl');
});

test('handlers: een beheerder werkt alleen in zijn eigen administratie', async () => {
  const ua = beheerder('main'), ub = beheerder('andere');
  const kindA = (await call(h.createChild, ua, { body: { firstName: 'Lotte', contracts: [K({ number: 'A1' })] } })).jsonBody;
  assert.deepEqual((await call(h.listChildren, ub)).jsonBody.map((c) => c.firstName), []);   // B ziet het kind van A niet

  // een contract van A bestaat niet voor B
  await assert.rejects(call(h.createEntry, ub, { body: { contractId: kindA.contracts[0].id, date: '2026-04-10', start: '08:00', end: '12:00' } }), { status: 400 });
  // B kan het kind van A niet wijzigen of verwijderen
  await assert.rejects(call(h.updateChild, ub, { params: { id: kindA.id }, body: { firstName: 'Gekaapt', contracts: [K()] } }), { status: 404 });
  assert.equal((await call(h.deleteChild, ub, { params: { id: kindA.id } })).status, 204);   // idempotent, maar zonder effect op A
  assert.equal((await call(h.listChildren, ua)).jsonBody[0].firstName, 'Lotte');

  // uren van A zijn voor B onzichtbaar en niet te verwijderen
  const urenA = (await call(h.createEntry, ua, { body: { contractId: kindA.contracts[0].id, date: '2026-04-10', start: '08:00', end: '12:00' } })).jsonBody;
  assert.deepEqual((await call(h.listEntries, ub, { query: { month: '2026-04' } })).jsonBody, []);
  await call(h.deleteEntry, ub, { params: { id: urenA.id } }).catch(() => {});
  assert.equal((await call(h.listEntries, ua, { query: { month: '2026-04' } })).jsonBody.length, 1);

  // instellingen: tarief van A wijzigt niets bij B
  await call(h.putRates, ua, { body: { rates: [{ from: '2026-01-01', rate: 9 }] } });
  assert.deepEqual((await call(h.getSettings, ub)).jsonBody.rates.map((r) => r.rate), [11]);   // het eigen tarief van B (11) blijft ongemoeid
  assert.equal((await call(h.getSettings, ua)).jsonBody.rates[0].rate, 9);
});

test('een gebruiker zonder geldige administratie krijgt geen repo', () => {
  assert.throws(() => base.forInstance(undefined), /Ongeldige administratie/);
});
