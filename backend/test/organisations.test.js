const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { createRepo } = require('../src/repo');

const PORT = 10116;
const CONN = `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;TableEndpoint=http://127.0.0.1:${PORT}/devstoreaccount1;`;
let azurite, dir, repo;

const waitForPort = (port) => new Promise((resolve, reject) => {
  const deadline = Date.now() + 20000;
  (function try_() {
    const s = net.connect(port, '127.0.0.1').once('connect', () => { s.destroy(); resolve(); })
      .once('error', () => { s.destroy(); Date.now() > deadline ? reject(new Error('Azurite start niet')) : setTimeout(try_, 200); });
  })();
});
test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azurite-org-'));
  azurite = spawn(process.execPath, [require.resolve('azurite/dist/src/table/main.js'), '--silent', '--location', dir, '--tablePort', String(PORT), '--skipApiVersionCheck'], { stdio: 'inherit' });
  await waitForPort(PORT);
  repo = createRepo(CONN);
});
test.after(() => { azurite.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

test('organisaties: opslaan, lezen, lijst gesorteerd op naam, ongeldige id geweigerd', async () => {
  assert.equal(await repo.getOrganisation('main'), null);
  await repo.saveOrganisation({ id: 'main', name: 'Gastouder Mariko', createdAt: '2026-11-15' });
  await repo.saveOrganisation({ id: 'abc-123', name: 'Anders', createdAt: '2026-11-16' });
  assert.deepEqual(await repo.getOrganisation('main'), { id: 'main', name: 'Gastouder Mariko', status: 'active', createdAt: '2026-11-15', deletedAt: '', needsAgency: false });
  assert.deepEqual((await repo.listOrganisations()).map((o) => o.id), ['abc-123', 'main']);
  await assert.rejects(repo.saveOrganisation({ id: 'Foute Id', name: 'x' }), /Ongeldige administratie/);
});

test('lidmaatschappen: per organisatie en per e-mailadres, over organisaties heen', async () => {
  await repo.saveMembership({ orgId: 'main', email: 'piet@x.nl', role: 'beheerder', createdAt: 'nu', source: 'test' });
  await repo.saveMembership({ orgId: 'abc-123', email: 'piet@x.nl', role: 'gebruiker' });
  await repo.saveMembership({ orgId: 'main', email: 'els@x.nl', role: 'gebruiker' });
  assert.deepEqual((await repo.listMembersOf('main')).map((m) => [m.email, m.role]), [['els@x.nl', 'gebruiker'], ['piet@x.nl', 'beheerder']]);
  assert.deepEqual((await repo.listMembershipsOf('piet@x.nl')).map((m) => [m.orgId, m.role]).sort(), [['abc-123', 'gebruiker'], ['main', 'beheerder']]);
  assert.deepEqual(await repo.listMembershipsOf('niemand@x.nl'), []);
  assert.equal((await repo.getMembership('main', 'piet@x.nl')).source, 'test');
  assert.equal(await repo.getMembership('abc-123', 'els@x.nl'), null);   // lid van main, niet van abc-123
  await repo.deleteMembership('main', 'piet@x.nl');
  assert.equal(await repo.getMembership('main', 'piet@x.nl'), null);
  assert.equal((await repo.getMembership('abc-123', 'piet@x.nl')).role, 'gebruiker');   // andere organisatie ongemoeid
  await repo.deleteMembership('main', 'bestaat-niet@x.nl');   // geen fout
});

test('een apostrof in een adres werkt (met escapen), tekens die geen sleutel kunnen zijn worden netjes geweigerd', async () => {
  const e = "o'brien@x.nl";
  await repo.saveMembership({ orgId: 'main', email: e, role: 'gebruiker' });
  assert.deepEqual((await repo.listMembershipsOf(e)).map((m) => m.email), [e]);   // het filter escapet de apostrof
  assert.equal((await repo.getMembership('main', e)).email, e);
  await repo.deleteMembership('main', e);
  assert.deepEqual(await repo.listMembershipsOf(e), []);
  for (const bad of ['a/b@x.nl', 'a#b@x.nl', 'a?b@x.nl', 'tab\there@x.nl', '', 'x'.repeat(201)]) {
    assert.deepEqual(await repo.listMembershipsOf(bad), [], bad);
    assert.equal(await repo.getMembership('main', bad), null, bad);
    await assert.rejects(repo.saveMembership({ orgId: 'main', email: bad, role: 'gebruiker' }), /Ongeldig lidmaatschap/, bad);
  }
  assert.deepEqual(await repo.listMembersOf("x' or PartitionKey ne 'x"), []);   // ongeldige organisatie-id: leeg, geen filterinjectie
});
