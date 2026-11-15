const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { createRepo } = require('../src/repo');
const { planSeed, seed, ensureSeeded, resetSeedCache, FIRST_ORG } = require('../src/organisations');
const { CODE_ADMINS } = require('../src/admins');

// De overstap naar organisaties vult lidmaatschappen uit de oude gegevens. Hier met een echte Azurite en gegevens zoals die nu bestaan.
const PORT = 10118;
const CONN = `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;TableEndpoint=http://127.0.0.1:${PORT}/devstoreaccount1;`;
const env = { ALLOWED_USERS: 'mariko@voorbeeld.nl, Beheer@Voorbeeld.nl ' };
let azurite, dir, repo;

const waitForPort = (port) => new Promise((resolve, reject) => {
  const deadline = Date.now() + 20000;
  (function try_() {
    const s = net.connect(port, '127.0.0.1').once('connect', () => { s.destroy(); resolve(); })
      .once('error', () => { s.destroy(); Date.now() > deadline ? reject(new Error('Azurite start niet')) : setTimeout(try_, 200); });
  })();
});
test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azurite-seed-'));
  azurite = spawn(process.execPath, [require.resolve('azurite/dist/src/table/main.js'), '--silent', '--location', dir, '--tablePort', String(PORT), '--skipApiVersionCheck'], { stdio: 'inherit' });
  await waitForPort(PORT);
  repo = createRepo(CONN);
  // De situatie van vóór de overstap: lokale accounts met rol, de lijst toegestane gebruikers, kinderen en uren.
  const acc = (email, role, instanceId = 'main') => repo.saveAccount({ email, role, instanceId, passwordHash: 'x', createdAt: '2026-01-01' });
  await acc('admin@voorbeeld.nl', 'admin');
  await acc('beh@voorbeeld.nl', 'beheerder');
  await acc('gebr@voorbeeld.nl', 'gebruiker');
  await acc('vreemd@voorbeeld.nl', 'gebruiker', 'andere');
  await acc('raar@voorbeeld.nl', 'iets-anders');
  await repo.setUsers(['partner@voorbeeld.nl', 'mariko@voorbeeld.nl']);
  await repo.saveChild({ id: 'k1', name: 'Noor', firstName: 'Noor', lastName: '', birthDate: '2024-01-01', parents: ['', ''], contracts: [], holidays: [] });
  await repo.saveEntry({ id: '2026-03-04_aaaa', contractId: 'c1', start: '08:00', end: '17:00', note: 'x' });
});
test.after(() => { azurite.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

const snapshot = async () => JSON.stringify([await repo.listChildren(), await repo.listEntriesOfMonth('2026-03'), await repo.getUsers(), (await repo.listAccounts()).map((a) => [a.rowKey, a.role, a.instanceId])]);

test('plan: wie wordt lid met welke rol, en wat wordt overgeslagen', async () => {
  const plan = await planSeed(repo, env);
  assert.deepEqual(plan.organisation, FIRST_ORG);
  const m = Object.fromEntries(plan.members.map((x) => [x.email, x.role]));
  assert.equal(m['admin@voorbeeld.nl'], 'beheerder');   // admin was een rol; wordt beheerder + platformbeheer
  assert.equal(m['beh@voorbeeld.nl'], 'beheerder');
  assert.equal(m['gebr@voorbeeld.nl'], 'gebruiker');
  assert.equal(m['raar@voorbeeld.nl'], 'gebruiker');   // onbekende rol krijgt de minste rechten
  assert.equal(m['partner@voorbeeld.nl'], 'beheerder');   // toegestane gebruiker (Microsoft)
  assert.equal(m['mariko@voorbeeld.nl'], 'beheerder');
  assert.equal(m['beheer@voorbeeld.nl'], 'beheerder');   // vaste gebruiker uit ALLOWED_USERS, genormaliseerd
  for (const c of CODE_ADMINS) assert.equal(m[c], 'beheerder');
  assert.ok(!('vreemd@voorbeeld.nl' in m));   // hoort bij een andere administratie
  assert.deepEqual(plan.skipped.map((s) => s.email), ['vreemd@voorbeeld.nl']);
  assert.deepEqual(plan.platformFlags, ['admin@voorbeeld.nl']);
});

test('voorbeeldrun schrijft niets', async () => {
  const before = JSON.stringify([await repo.listOrganisations(), await repo.listMembersOf('main')]);
  const res = await seed(repo, env, { dryRun: true });
  assert.equal(res.dryRun, true);
  assert.equal(JSON.stringify([await repo.listOrganisations(), await repo.listMembersOf('main')]), before);
  assert.equal(await repo.getOrganisation('main'), null);
});

test('overstap: lidmaatschappen, vlag voor platformbeheer, organisatie als laatste; de oude gegevens blijven onaangeraakt', async () => {
  const before = await snapshot();
  const res = await seed(repo, env, { now: new Date('2026-11-15T12:00:00Z') });
  assert.equal(res.dryRun, false);
  assert.equal(await snapshot(), before);   // kinderen, uren, accounts en de oude gebruikerslijst: exact gelijk
  assert.deepEqual(await repo.getOrganisation('main'), { id: 'main', name: 'Gastouder Mariko', status: 'active', createdAt: '2026-11-15T12:00:00.000Z', deletedAt: '' });
  const members = Object.fromEntries((await repo.listMembersOf('main')).map((x) => [x.email, x.role]));
  assert.equal(Object.keys(members).length, res.members.length);
  assert.equal(members['gebr@voorbeeld.nl'], 'gebruiker');
  assert.equal(members['partner@voorbeeld.nl'], 'beheerder');
  assert.equal((await repo.getAccount('admin@voorbeeld.nl')).platformAdmin, true);
  assert.equal(!!(await repo.getAccount('beh@voorbeeld.nl')).platformAdmin, false);
});

test('herhalen doet niets: een gewijzigde rol wordt niet teruggezet en er komt niets dubbel', async () => {
  await repo.saveMembership({ orgId: 'main', email: 'gebr@voorbeeld.nl', role: 'beheerder' });   // later in de app aangepast
  await repo.deleteMembership('main', 'partner@voorbeeld.nl');                                    // later verwijderd
  const res = await seed(repo, env);
  assert.equal(res.alreadySeeded, true);
  assert.equal((await repo.getMembership('main', 'gebr@voorbeeld.nl')).role, 'beheerder');
  assert.equal(await repo.getMembership('main', 'partner@voorbeeld.nl'), null);
});

test('stopt het halverwege, dan is de organisatie er nog niet en gaat de volgende keer gewoon verder zonder dubbele of overschreven leden', async () => {
  const fresh = createRepo(CONN).forInstance('main');
  // nieuwe omgeving: de organisatie-markering weghalen, een deel van de lidmaatschappen laten staan met een eigen rol
  const t = require('@azure/data-tables').TableClient.fromConnectionString(CONN, 'organisations', { allowInsecureConnection: true });
  await t.deleteEntity('organisations', 'main');
  await repo.saveMembership({ orgId: 'main', email: 'beh@voorbeeld.nl', role: 'gebruiker' });   // bestond al (van de vorige poging), met een eigen rol
  const res = await seed(fresh, env, { now: new Date('2026-11-16T09:00:00Z') });
  assert.equal(res.alreadySeeded, undefined);
  assert.equal((await repo.getMembership('main', 'beh@voorbeeld.nl')).role, 'gebruiker');   // bestaand lidmaatschap niet overschreven
  assert.ok(await repo.getOrganisation('main'));
  assert.equal((await repo.listMembersOf('main')).filter((m) => m.email === 'admin@voorbeeld.nl').length, 1);
});

test('ensureSeeded onthoudt het resultaat, en probeert het na een fout opnieuw', async () => {
  resetSeedCache();
  const calls = [];
  const spy = { getOrganisation: async (id) => { calls.push(id); return { id }; } };
  await ensureSeeded(spy, env);
  await ensureSeeded(spy, env);
  assert.equal(calls.length, 1);   // één keer gecontroleerd, daarna onthouden
  resetSeedCache();
  let n = 0;
  const failing = { getOrganisation: async () => { n++; if (n === 1) throw new Error('storage even weg'); return { id: 'main' }; } };
  await assert.rejects(ensureSeeded(failing, env), /storage even weg/);
  await ensureSeeded(failing, env);   // tweede keer lukt
  assert.equal(n, 2);
  resetSeedCache();
});
