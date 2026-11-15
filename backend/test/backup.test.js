const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { TableClient } = require('@azure/data-tables');
const { backup, restore, listBackups, checksum, normalizeRow } = require('../scripts/backup');

// Draait tegen een echte Azurite (poort 10113, los van de andere tests die ook Azurite starten).
const PORT = 10113;
const CONN = `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;TableEndpoint=http://127.0.0.1:${PORT}/devstoreaccount1;`;
let azurite, dir;
const tc = (name) => TableClient.fromConnectionString(CONN, name, { allowInsecureConnection: true });
const rowsOf = async (name) => { const out = []; for await (const r of tc(name).listEntities()) out.push(normalizeRow(r)); return out.sort((a, b) => (a.partitionKey + a.rowKey).localeCompare(b.partitionKey + b.rowKey)); };
const put = async (name, rows) => { const t = tc(name); await t.createTable(); for (const r of rows) await t.upsertEntity(r, 'Replace'); };

const waitForPort = (port) => new Promise((resolve, reject) => {
  const deadline = Date.now() + 20000;
  (function try_() {
    const s = net.connect(port, '127.0.0.1').once('connect', () => { s.destroy(); resolve(); })
      .once('error', () => { s.destroy(); Date.now() > deadline ? reject(new Error('Azurite start niet')) : setTimeout(try_, 200); });
  })();
});

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azurite-bak-'));
  azurite = spawn(process.execPath, [require.resolve('azurite/dist/src/table/main.js'), '--silent', '--location', dir, '--tablePort', String(PORT), '--skipApiVersionCheck'], { stdio: 'inherit' });
  await waitForPort(PORT);
  await put('children', [{ partitionKey: 'main', rowKey: 'k1', name: 'Noor', contracts: '[{"id":"c1"}]' }, { partitionKey: 'main', rowKey: 'k2', name: 'Sam', contracts: '[]' }]);
  await put('entries', [{ partitionKey: 'main', rowKey: '2026-11-02_a', contractId: 'c1', start: '08:00', end: '17:00', note: 'één dag, met ë en "quotes"' }]);
  await put('settings', [{ partitionKey: 'main', rowKey: 'rates', value: '[{"rate":8.5}]' }]);
  await put('accounts', [{ partitionKey: 'accounts', rowKey: 'a@b.nl', role: 'beheerder', instanceId: 'main', mustChange: false, totpLastStep: 59000000 }]);
  await put('sessions', [{ partitionKey: 'sessions', rowKey: 'abc', email: 'a@b.nl' }]);
  await put('throttle', [{ partitionKey: 'throttle', rowKey: 'abc', count: 3 }]);
});
test.after(() => { azurite.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

test('controlesom: onafhankelijk van etag, tijdstempel en volgorde van eigenschappen', () => {
  const a = normalizeRow({ b: 1, a: 'x', etag: 'W/1', timestamp: '2026-01-01', partitionKey: 'p', rowKey: 'r' });
  const b = normalizeRow({ partitionKey: 'p', a: 'x', rowKey: 'r', b: 1, etag: 'W/2' });
  assert.equal(checksum([a]), checksum([b]));
  assert.notEqual(checksum([a]), checksum([{ ...a, b: 2 }]));
});

let first;
test('back-up kopieert alle tabellen, behalve sessies en inlogpogingen, en controleert de kopie', async () => {
  first = await backup({ conn: CONN, now: new Date('2026-11-15T09:30:12Z'), label: 'eerste' });
  assert.equal(first.id, '20261115t093012');
  assert.deepEqual(first.tables.map((t) => [t.name, t.rows]), [['accounts', 1], ['children', 2], ['entries', 1], ['settings', 1]]);
  assert.deepEqual(await rowsOf('bak20261115t093012children'), await rowsOf('children'));
  assert.deepEqual(await rowsOf('bak20261115t093012entries'), await rowsOf('entries'));   // ook speciale tekens en getallen blijven heel
  assert.deepEqual(await rowsOf('bak20261115t093012accounts'), await rowsOf('accounts'));
  const list = await listBackups(CONN);
  assert.equal(list.length, 1);
  assert.equal(list[0].label, 'eerste');
});

test('een tweede back-up neemt de eerste niet mee en laat de bron ongemoeid', async () => {
  const before = await rowsOf('children');
  const second = await backup({ conn: CONN, now: new Date('2026-11-15T10:00:00Z') });
  assert.ok(!second.tables.some((t) => t.name.startsWith('bak')));
  assert.deepEqual(await rowsOf('children'), before);
  assert.equal((await listBackups(CONN)).length, 2);
});

test('herstel: proefrun verandert niets', async () => {
  await tc('children').deleteEntity('main', 'k2');
  await tc('children').upsertEntity({ partitionKey: 'main', rowKey: 'k1', name: 'Noor (per ongeluk gewijzigd)', contracts: '[]' }, 'Replace');
  await tc('children').upsertEntity({ partitionKey: 'main', rowKey: 'k9', name: 'Nieuw', contracts: '[]' }, 'Replace');
  const before = await rowsOf('children');
  const res = await restore({ conn: CONN, id: first.id });
  assert.equal(res.applied, false);
  assert.deepEqual(res.summary.find((s) => s.name === 'children'), { name: 'children', add: 1, change: 1, same: 0, extra: 1, remove: 0 });
  assert.deepEqual(await rowsOf('children'), before);
});

test('herstel met apply: zet terug, laat nieuwere rijen staan en maakt eerst een veiligheidsback-up', async () => {
  const res = await restore({ conn: CONN, id: first.id, apply: true, now: new Date('2026-11-15T11:00:00Z') });
  assert.equal(res.applied, true);
  const names = (await rowsOf('children')).map((r) => `${r.rowKey}:${r.name}`);
  assert.deepEqual(names, ['k1:Noor', 'k2:Sam', 'k9:Nieuw']);   // k9 is nieuwer dan de back-up en blijft zonder replace
  const safety = (await listBackups(CONN)).find((b) => b.id === res.safetyBackup);
  assert.match(safety.label, /voor herstel van/);
  const safetyChildren = await rowsOf(`bak${res.safetyBackup}children`);
  assert.deepEqual(safetyChildren.map((r) => r.rowKey), ['k1', 'k9']);   // de stand van vóór het herstel, dus terug te draaien
});

test('herstel met replace verwijdert wat niet in de back-up staat', async () => {
  const res = await restore({ conn: CONN, id: first.id, apply: true, replace: true, now: new Date('2026-11-15T12:00:00Z') });
  assert.equal(res.applied, true);
  assert.deepEqual((await rowsOf('children')).map((r) => r.rowKey), ['k1', 'k2']);
});

test('een beschadigde back-up wordt niet teruggezet', async () => {
  await tc(`bak${first.id}children`).upsertEntity({ partitionKey: 'main', rowKey: 'k1', name: 'Gemanipuleerd', contracts: '[]' }, 'Replace');
  await assert.rejects(restore({ conn: CONN, id: first.id, apply: true, now: new Date('2026-11-15T13:00:00Z') }), /beschadigd/);
  assert.deepEqual((await rowsOf('children')).map((r) => r.name), ['Noor', 'Sam']);   // niets veranderd
  await assert.rejects(restore({ conn: CONN, id: '20000101t000000' }), /niet gevonden/);
});
