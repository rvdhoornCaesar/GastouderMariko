const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { createRepo } = require('../src/repo');
const a = require('../src/admin-handlers');
const h = require('../src/handlers');
const { resolveContext } = require('../src/organisations');

const PORT = 10120;
const CONN = `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;TableEndpoint=http://127.0.0.1:${PORT}/devstoreaccount1;`;
let azurite, dir, base;
const DAY = 86400000;
const platform = { email: 'platform@voorbeeld.nl', kind: 'microsoft', platformAdmin: true, role: null, instanceId: null };   // alleen platformbeheer
const beheerderVan = (org) => ({ email: `beh@${org}.nl`, kind: 'local', role: 'beheerder', instanceId: org });
const gebruikerVan = (org) => ({ email: `geb@${org}.nl`, kind: 'local', role: 'gebruiker', instanceId: org });
const run = (fn, user, extra = {}) => fn({ user, repo: user.instanceId ? base.forInstance(user.instanceId) : base.forInstance(null), env: {}, params: {}, query: {}, ...extra });

const waitForPort = (port) => new Promise((resolve, reject) => {
  const deadline = Date.now() + 20000;
  (function try_() {
    const s = net.connect(port, '127.0.0.1').once('connect', () => { s.destroy(); resolve(); })
      .once('error', () => { s.destroy(); Date.now() > deadline ? reject(new Error('Azurite start niet')) : setTimeout(try_, 200); });
  })();
});
test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azurite-adm-'));
  azurite = spawn(process.execPath, [require.resolve('azurite/dist/src/table/main.js'), '--silent', '--location', dir, '--tablePort', String(PORT), '--skipApiVersionCheck'], { stdio: 'inherit' });
  await waitForPort(PORT);
  base = createRepo(CONN);
});
test.after(() => { azurite.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

test('organisaties beheren mag alleen platformbeheer; een beheerder of gebruiker niet', async () => {
  for (const fn of [a.listOrganisations, a.createOrganisation, a.renameOrganisation, a.addOrganisationManager, a.deleteOrganisation, a.restoreOrganisation, a.purgeOrganisation]) {
    await assert.rejects(run(fn, beheerderVan('main'), { params: { id: 'main' }, body: { name: 'x' } }), { status: 403 });
    await assert.rejects(run(fn, gebruikerVan('main'), { params: { id: 'main' }, body: { name: 'x' } }), { status: 403 });
  }
  assert.equal((await run(a.listOrganisations, platform)).status, 200);
});

let org1, org2;
test('aanmaken: id uit de naam met een willekeurig einde, naam gecontroleerd, eerste beheerder via Microsoft of lokaal', async () => {
  await assert.rejects(run(a.createOrganisation, platform, { body: { name: '   ' } }), { status: 400 });
  await assert.rejects(run(a.createOrganisation, platform, { body: { name: 'x'.repeat(101) } }), { status: 400 });
  await assert.rejects(run(a.createOrganisation, platform, { body: { name: '<script>' } }), { status: 400 });
  const r1 = (await run(a.createOrganisation, platform, { body: { name: 'Gastouder Aardbei & Co!', managerEmail: 'Aardbei@Voorbeeld.nl', login: 'microsoft' } })).jsonBody;
  org1 = r1.organisation.id;
  assert.match(org1, /^gastouder-aardbei-co-[a-z2-9]{4}$/);
  assert.equal(r1.organisation.members, 1);
  assert.equal(r1.organisation.managers, 1);
  assert.equal((await base.getMembership(org1, 'aardbei@voorbeeld.nl')).role, 'beheerder');
  assert.equal(await base.getAccount('aardbei@voorbeeld.nl'), null);   // Microsoft: geen account, geen wachtwoord
  assert.equal(r1.manager.tempPassword, null);

  const r2 = (await run(a.createOrganisation, platform, { body: { name: 'Éénhoorn Opvang', managerEmail: 'een@voorbeeld.nl', login: 'lokaal' } })).jsonBody;
  org2 = r2.organisation.id;
  assert.match(org2, /^eenhoorn-opvang-[a-z2-9]{4}$/);   // diakrieten weg
  assert.match(r2.manager.tempPassword, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
  const acc = await base.getAccount('een@voorbeeld.nl');
  assert.equal(acc.mustChange, true);
  assert.ok(!JSON.stringify(acc).includes(r2.manager.tempPassword));   // nooit leesbaar opgeslagen
  assert.ok(acc.passwordHash.startsWith('scrypt$'));

  assert.equal((await base.getOrganisation(org1)).status, 'active');
  assert.notEqual(org1, (await run(a.createOrganisation, platform, { body: { name: 'Gastouder Aardbei & Co!' } })).jsonBody.organisation.id);   // zelfde naam, andere id
});

test('een naam die niets bruikbaars overlaat geeft toch een geldige id', async () => {
  const r = (await run(a.createOrganisation, platform, { body: { name: '!!!' } })).jsonBody;
  assert.match(r.organisation.id, /^org-[a-z2-9]{4}$/);
  assert.match((await run(a.createOrganisation, platform, { body: { name: 'Ñ'.repeat(60) } })).jsonBody.organisation.id, /^n{24}-[a-z2-9]{4}$/);
});

test('beheerder toevoegen: bestaand account houdt zijn wachtwoord, een gebruiker wordt beheerder, onbekende organisatie is 404', async () => {
  await assert.rejects(run(a.addOrganisationManager, platform, { params: { id: 'bestaat-niet' }, body: { email: 'x@y.nl' } }), { status: 404 });
  await assert.rejects(run(a.addOrganisationManager, platform, { params: { id: org1 }, body: { email: 'geen adres' } }), { status: 400 });
  const res = (await run(a.addOrganisationManager, platform, { params: { id: org1 }, body: { email: 'een@voorbeeld.nl', login: 'lokaal' } })).jsonBody;   // heeft al een account (org2)
  assert.equal(res.existing, true);
  assert.equal(res.tempPassword, null);
  assert.deepEqual((await base.listMembershipsOf('een@voorbeeld.nl')).map((m) => m.orgId).sort(), [org1, org2].sort());
  await base.saveMembership({ orgId: org1, email: 'geb@voorbeeld.nl', role: 'gebruiker' });
  await run(a.addOrganisationManager, platform, { params: { id: org1 }, body: { email: 'geb@voorbeeld.nl' } });
  assert.equal((await base.getMembership(org1, 'geb@voorbeeld.nl')).role, 'beheerder');
});

test('hernoemen', async () => {
  const r = (await run(a.renameOrganisation, platform, { params: { id: org1 }, body: { name: 'Aardbei Opvang' } })).jsonBody;
  assert.equal(r.name, 'Aardbei Opvang');
  assert.equal(r.id, org1);   // de id verandert nooit
  await assert.rejects(run(a.renameOrganisation, platform, { params: { id: org1 }, body: { name: '' } }), { status: 400 });
});

test('verwijderen: leden verliezen direct de toegang, de gegevens blijven en terugzetten kan', async () => {
  const user = beheerderVan(org2);
  await base.forInstance(org2).saveChild({ id: 'k1', name: 'Bram', firstName: 'Bram', lastName: '', birthDate: '2024-01-01', parents: ['', ''], contracts: [], holidays: [] });
  assert.equal((await resolveContext({ repo: base, email: 'een@voorbeeld.nl', requested: org2, platformAdmin: false })).role, 'beheerder');
  const del = (await run(a.deleteOrganisation, platform, { params: { id: org2 }, now: new Date('2026-11-15T10:00:00Z') })).jsonBody;
  assert.equal(del.status, 'deleted');
  assert.equal(del.purgeAfter, '2026-12-15T10:00:00.000Z');
  await assert.rejects(resolveContext({ repo: base, email: 'een@voorbeeld.nl', requested: org2, platformAdmin: false }), { status: 403 });
  assert.equal((await base.forInstance(org2).getChild('k1')).firstName, 'Bram');   // gegevens staan er nog
  await assert.rejects(run(a.deleteOrganisation, platform, { params: { id: org2 } }), { status: 409 });
  await assert.rejects(run(a.addOrganisationManager, platform, { params: { id: org2 }, body: { email: 'x@y.nl' } }), { status: 409 });
  await assert.rejects(run(a.restoreOrganisation, platform, { params: { id: org1 } }), { status: 409 });   // niet verwijderd
  assert.equal((await run(a.restoreOrganisation, platform, { params: { id: org2 } })).jsonBody.status, 'active');
  assert.equal((await resolveContext({ repo: base, email: 'een@voorbeeld.nl', requested: org2, platformAdmin: false })).role, 'beheerder');
  assert.ok(user);
});

test('definitief verwijderen: pas na de bewaartermijn, met bevestiging, en alleen die organisatie', async () => {
  // org2 krijgt gegevens, org1 ook; org1 wordt verwijderd en opgeruimd
  const kid = (name) => ({ id: 'k1', name, firstName: name, lastName: '', birthDate: '2024-01-01', parents: ['', ''], contracts: [{ id: 'c1', start: '2026-01-01', end: '2026-12-31' }], holidays: [] });
  await base.forInstance(org1).saveChild(kid('Van een'));
  await base.forInstance(org1).saveEntry({ id: '2026-03-04_aaaa', contractId: 'c1', start: '08:00', end: '12:00', note: '' });
  await base.forInstance(org1).setRates([{ id: 'r', from: '2026-01-01', to: null, rate: 9 }]);
  await base.forInstance(org2).saveChild(kid('Van twee'));
  await base.forInstance(org2).saveEntry({ id: '2026-03-04_aaaa', contractId: 'c1', start: '08:00', end: '12:00', note: '' });
  await base.saveAccount({ email: 'alleenaardbei@voorbeeld.nl', role: 'gebruiker', instanceId: org1, passwordHash: 'x', createdAt: 'nu' });
  await base.saveMembership({ orgId: org1, email: 'alleenaardbei@voorbeeld.nl', role: 'gebruiker' });

  await assert.rejects(run(a.purgeOrganisation, platform, { params: { id: org1 }, body: { confirm: org1 } }), { status: 409, message: /Verwijder de organisatie eerst/ });
  const t0 = new Date('2026-11-15T10:00:00Z');
  await run(a.deleteOrganisation, platform, { params: { id: org1 }, now: t0 });
  await assert.rejects(run(a.purgeOrganisation, platform, { params: { id: org1 }, body: { confirm: org1 }, now: new Date(t0.getTime() + 29 * DAY) }), { status: 409, message: /pas na 2026-12-15/ });
  const later = new Date(t0.getTime() + 30 * DAY);
  await assert.rejects(run(a.purgeOrganisation, platform, { params: { id: org1 }, body: { confirm: 'verkeerd' }, now: later }), { status: 400 });
  await assert.rejects(run(a.purgeOrganisation, platform, { params: { id: org1 }, body: {}, now: later }), { status: 400 });
  assert.equal((await base.forInstance(org1).listChildren()).length, 1);   // nog niets verwijderd

  const res = (await run(a.purgeOrganisation, platform, { params: { id: org1 }, body: { confirm: org1 }, now: later })).jsonBody;
  assert.equal(res.purged, org1);
  assert.equal(res.children, 1);
  assert.equal(res.entries, 1);
  assert.equal(res.settings, 1);
  assert.equal(await base.getOrganisation(org1), null);
  assert.deepEqual(await base.listMembersOf(org1), []);
  assert.deepEqual(await base.forInstance(org1).listChildren(), []);
  assert.deepEqual(await base.forInstance(org1).listEntriesOfMonth('2026-03'), []);
  assert.equal(await base.getAccount('alleenaardbei@voorbeeld.nl'), null);          // nergens anders lid: account weg
  assert.ok(await base.getAccount('een@voorbeeld.nl'));                             // nog lid van org2: account blijft
  assert.deepEqual((await base.listMembershipsOf('een@voorbeeld.nl')).map((m) => m.orgId), [org2]);
  // de andere organisatie is volledig ongemoeid
  assert.equal((await base.forInstance(org2).listChildren()).filter((c) => c.firstName === 'Van twee').length, 1);
  assert.equal((await base.forInstance(org2).listEntriesOfMonth('2026-03')).length, 1);
  assert.equal((await base.getOrganisation(org2)).status, 'active');
});

test('export: alleen de eigen organisatie, met leden, door een beheerder', async () => {
  await base.forInstance('main').saveChild({ id: 'km', name: 'Hoofd', firstName: 'Hoofd', lastName: '', birthDate: '2024-01-01', parents: ['', ''], contracts: [{ id: 'cm', start: '2026-01-01', end: '2026-12-31' }], holidays: [] });
  await base.forInstance('main').saveEntry({ id: '2026-05-06_zzzz', contractId: 'cm', start: '09:00', end: '10:00', note: 'mei' });
  await base.forInstance('main').saveEntry({ id: '2026-06-06_yyyy', contractId: 'cm', start: '09:00', end: '10:00', note: 'juni' });
  await base.saveOrganisation({ id: 'main', name: 'Gastouder Mariko' });
  await base.saveMembership({ orgId: 'main', email: 'm@voorbeeld.nl', role: 'beheerder' });
  const res = await run(a.exportData, beheerderVan('main'), { now: new Date('2026-11-15T10:00:00Z') });
  assert.match(res.headers['content-disposition'], /attachment; filename="export-main-2026-11-15\.json"/);
  const d = res.jsonBody;
  assert.equal(d.format, 'gastouderuren-export-1');
  assert.deepEqual(d.organisation, { id: 'main', name: 'Gastouder Mariko' });
  assert.deepEqual(d.children.map((c) => c.firstName), ['Hoofd']);          // niets van org2
  assert.deepEqual(d.entries.map((e) => e.note).sort(), ['juni', 'mei']);    // alle maanden
  assert.deepEqual(d.members.map((m) => m.email), ['m@voorbeeld.nl']);
  assert.ok(!JSON.stringify(d).includes('passwordHash'));
  assert.ok(!JSON.stringify(d).includes('Van twee'));
  // gebruiker en platformbeheer zonder lidmaatschap mogen niet exporteren
  await assert.rejects(run(a.exportData, gebruikerVan('main')), { status: 403 });
  await assert.rejects(run(a.exportData, platform), { status: 403 });
});

test('platformbeheerder zonder lidmaatschap kan geen gegevens van een organisatie lezen of wijzigen', async () => {
  for (const fn of [h.listChildren, h.getSettings, h.listAccounts]) await assert.rejects(run(fn, platform), { status: 403 });
  await assert.rejects(run(h.createChild, platform, { body: { firstName: 'X', contracts: [] } }), { status: 403 });
});
