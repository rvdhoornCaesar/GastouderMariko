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
const user = { id: 'u1', name: 'mariko@voorbeeld.nl' };
const call = (fn, extra = {}) => fn({ user, repo, params: {}, query: {}, ...extra });

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

test('uren: toevoegen, per maand ophalen, andere gebruiker ziet niets, verwijderen', async () => {
  const [child] = (await call(h.listChildren)).jsonBody;
  const contractId = child.contracts[0].id;
  const body = { date: '2026-10-21', contractId, start: '08:00', end: '17:00', note: 'x' };
  const created = (await call(h.createEntry, { body })).jsonBody;
  await call(h.createEntry, { body: { ...body, date: '2026-11-01' } });
  await call(h.createEntry, { body: { ...body, date: '2026-09-30' } });

  const okt = (await call(h.listEntries, { query: { month: '2026-10' } })).jsonBody;
  assert.equal(okt.length, 1);
  assert.deepEqual(okt[0], created);

  const other = await h.listEntries({ user: { id: 'u2' }, repo, query: { month: '2026-10' } });
  assert.equal(other.jsonBody.length, 0);

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
