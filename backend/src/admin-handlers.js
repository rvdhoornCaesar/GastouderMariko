const crypto = require('node:crypto');
const { HttpError } = require('./errors');
const v = require('./validation');
const perm = require('./permissions');
const P = require('./passwords');
const { parsePlanning, runImport } = require('./import-planning');

// Platformbeheer: organisaties aanmaken en beheren. Wie platformbeheerder is ziet hier alleen organisaties (naam, aantallen), nooit de
// gegevens erin: daarvoor moet je lid zijn. Verwijderen gaat in twee stappen: eerst "verwijderd" (leden raken direct hun toegang kwijt, de
// gegevens blijven staan en het is terug te zetten), pas na de bewaartermijn kan het definitief.
const RETENTION_DAYS = 30;
const DAY = 86400000;
const FIRST = 'main';

const slug = (name) => name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/g, '') || 'org';
const suffix = () => Array.from(crypto.randomBytes(4), (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
async function newOrgId(repo, name) {
  for (let i = 0; i < 10; i++) {
    const id = `${slug(name)}-${suffix()}`;
    if (!(await repo.getOrganisation(id))) return id;
  }
  throw new HttpError(500, 'Kon geen vrije id voor de organisatie maken.');
}

const view = async (repo, o) => {
  const members = await repo.listMembersOf(o.id);
  const purgeAfter = o.status === 'deleted' && o.deletedAt ? new Date(new Date(o.deletedAt).getTime() + RETENTION_DAYS * DAY).toISOString() : null;
  return { id: o.id, name: o.name, status: o.status, createdAt: o.createdAt, deletedAt: o.deletedAt || null, purgeAfter,
    members: members.length, managers: members.filter((m) => m.role === 'beheerder').length };
};
const requirePlatform = (user) => perm.require(user, 'orgs:manage');
async function organisationOf(repo, rawId) {
  const o = await repo.getOrganisation(String(rawId || '').toLowerCase());
  if (!o) throw new HttpError(404, 'Organisatie niet gevonden.');
  return o;
}

// Een beheerder toevoegen aan een organisatie. 'lokaal' maakt zo nodig een account met een tijdelijk wachtwoord (één keer te tonen); heeft het
// adres al een account, dan wordt alleen het lidmaatschap toegevoegd en houdt de persoon zijn eigen wachtwoord. 'microsoft' voegt alleen het
// lidmaatschap toe: de persoon logt in met zijn Microsoft-account.
async function addManager(repo, org, emailRaw, login, now) {
  const email = v.parseAccountEmail(emailRaw);
  let tempPassword = null, existing = !!(await repo.getAccount(email));
  if (login === 'lokaal' && !existing) {
    tempPassword = P.generateTempPassword();
    await repo.saveAccount({ email, name: '', role: 'beheerder', instanceId: org.id, mustChange: true, createdAt: now.toISOString(), passwordHash: await P.hashPassword(tempPassword) });
    existing = false;
  }
  const member = await repo.getMembership(org.id, email);
  await repo.saveMembership({ orgId: org.id, email, role: 'beheerder', createdAt: member ? member.createdAt : now.toISOString(), source: 'platformbeheer' });
  return { email, tempPassword, existing, login, alreadyMember: !!member };
}
const parseLogin = (v_) => (v_ === 'lokaal' ? 'lokaal' : 'microsoft');

const mine = async (repo) => { const ids = new Set(await repo.getAgencyIds()); return (await repo.listAgencies()).filter((x) => ids.has(x.id)); };
// Gastouderbureaus (gedeelde lijst). Nooit verwijderen: een niet-actief bureau is niet meer te kiezen, maar bestaande contracten houden hun verwijzing.
async function createAgency({ user, repo, body }) {
  requirePlatform(user);
  const name = v.parseAgencyName(body && body.name);
  if ((await repo.listAgencies()).some((a) => a.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, 'Dit gastouderbureau staat al in de lijst.');
  const agency = { id: crypto.randomBytes(6).toString('hex'), name, active: true, types: body && body.types !== undefined ? v.parseTypes(body.types, 'soorten opvang van dit bureau') : ['gastouder'] };
  await repo.saveAgency(agency);
  return { status: 201, jsonBody: agency };
}

async function updateAgency({ user, repo, params, body }) {
  requirePlatform(user);
  const list = await repo.listAgencies(), a = list.find((x) => x.id === String(params.id || ''));
  if (!a) throw new HttpError(404, 'Gastouderbureau niet gevonden.');
  const next = { ...a };
  if (body && body.name !== undefined) next.name = v.parseAgencyName(body.name);
  if (body && body.types !== undefined) next.types = v.parseTypes(body.types, 'soorten opvang van dit bureau');
  if (body && body.active !== undefined) {
    if (typeof body.active !== 'boolean') throw new HttpError(400, 'Ongeldige waarde voor actief.');
    next.active = body.active;
  }
  if (list.some((x) => x.id !== a.id && x.name.toLowerCase() === next.name.toLowerCase())) throw new HttpError(409, 'Dit gastouderbureau staat al in de lijst.');
  await repo.saveAgency(next);
  return { status: 200, jsonBody: next };
}

// Eenmalige import van historische gegevens uit het Excel-planningsbestand (zie import-planning.js). Werkt in de organisatie waarin je nu zit
// (je moet er lid-beheerder van zijn). Zonder apply: alleen een voorbeeld, er wordt niets opgeslagen.
async function importPlanning({ user, repo, body }) {
  perm.require(user, 'import:run');
  perm.require(user, 'children:write');
  perm.require(user, 'entries:write');
  if (!body || typeof body.file !== 'string' || !body.file.length || body.file.length > 34 * 1024 * 1024) throw new HttpError(400, 'Kies een Excel-bestand (.xlsx) van maximaal 25 MB.');
  const parsed = parsePlanning(Buffer.from(body.file, 'base64'));
  return { status: 200, jsonBody: await runImport({ repo, parsed, apply: body.apply === true, selected: body.years, until: body.until }) };
}

async function listOrganisations({ user, repo }) {
  requirePlatform(user);
  const out = [];
  for (const o of await repo.listOrganisations()) out.push(await view(repo, o));
  return { status: 200, jsonBody: { organisations: out, retentionDays: RETENTION_DAYS } };
}

async function createOrganisation({ user, repo, body, now = new Date() }) {
  requirePlatform(user);
  const name = v.parseOrgName(body && body.name);
  const id = await newOrgId(repo, name);
  await repo.saveOrganisation({ id, name, status: 'active', createdAt: now.toISOString(), needsAgency: true });   // eerst een gastouderbureau kiezen voordat er kinderen bij kunnen
  let manager = null;
  if (body && body.managerEmail) manager = await addManager(repo, { id }, body.managerEmail, parseLogin(body.login), now);
  return { status: 201, jsonBody: { organisation: await view(repo, await repo.getOrganisation(id)), manager } };
}

async function renameOrganisation({ user, repo, params, body }) {
  requirePlatform(user);
  const o = await organisationOf(repo, params.id);
  await repo.saveOrganisation({ ...o, name: v.parseOrgName(body && body.name) });
  return { status: 200, jsonBody: await view(repo, await repo.getOrganisation(o.id)) };
}

async function addOrganisationManager({ user, repo, params, body, now = new Date() }) {
  requirePlatform(user);
  const o = await organisationOf(repo, params.id);
  if (o.status !== 'active') throw new HttpError(409, 'Deze organisatie is verwijderd. Zet hem eerst terug.');
  return { status: 201, jsonBody: await addManager(repo, o, body && body.email, parseLogin(body && body.login), now) };
}

async function deleteOrganisation({ user, repo, params, now = new Date() }) {
  requirePlatform(user);
  const o = await organisationOf(repo, params.id);
  if (o.status === 'deleted') throw new HttpError(409, 'Deze organisatie is al verwijderd.');
  await repo.saveOrganisation({ ...o, status: 'deleted', deletedAt: now.toISOString() });   // leden verliezen direct hun toegang; de gegevens blijven staan
  return { status: 200, jsonBody: await view(repo, await repo.getOrganisation(o.id)) };
}

async function restoreOrganisation({ user, repo, params }) {
  requirePlatform(user);
  const o = await organisationOf(repo, params.id);
  if (o.status !== 'deleted') throw new HttpError(409, 'Deze organisatie is niet verwijderd.');
  await repo.saveOrganisation({ ...o, status: 'active', deletedAt: '' });
  return { status: 200, jsonBody: await view(repo, await repo.getOrganisation(o.id)) };
}

// Definitief verwijderen: alleen als de organisatie al verwijderd is en de bewaartermijn voorbij is, en met de id als bevestiging. Onomkeerbaar
// (behalve via een eerdere back-up). Personen die daarna nergens meer lid zijn verliezen ook hun account.
async function purgeOrganisation({ user, repo, params, body, now = new Date() }) {
  requirePlatform(user);
  const o = await organisationOf(repo, params.id);
  if (o.status !== 'deleted') throw new HttpError(409, 'Verwijder de organisatie eerst; definitief verwijderen kan pas na de bewaartermijn.');
  const after = new Date(new Date(o.deletedAt).getTime() + RETENTION_DAYS * DAY);
  if (!(now >= after)) throw new HttpError(409, `Definitief verwijderen kan pas na ${after.toISOString().slice(0, 10)} (${RETENTION_DAYS} dagen na verwijderen).`);
  if (!body || String(body.confirm || '') !== o.id) throw new HttpError(400, 'Typ de id van de organisatie ter bevestiging.');
  const data = await repo.forInstance(o.id).purgeInstanceData();
  const members = await repo.listMembersOf(o.id);
  let accounts = 0;
  for (const m of members) {
    await repo.deleteMembership(o.id, m.email);
    if (!(await repo.listMembershipsOf(m.email)).length && (await repo.getAccount(m.email))) {
      await repo.deleteSessionsOf(m.email);
      await repo.deleteAccount(m.email);
      accounts++;
    }
  }
  await repo.deleteOrganisation(o.id);
  return { status: 200, jsonBody: { purged: o.id, ...data, members: members.length, accounts } };
}

// Export van de eigen organisatie voor een beheerder: alles wat er in staat, als JSON. Platformbeheer heeft dit bewust niet.
async function exportData({ user, repo, now = new Date() }) {
  perm.require(user, 'data:export');
  const org = await repo.getOrganisation(user.instanceId);
  const members = (await repo.listMembersOf(user.instanceId)).map((m) => ({ email: m.email, role: m.role, createdAt: m.createdAt }));
  const payload = {
    format: 'gastouderuren-export-1', exportedAt: now.toISOString(), organisation: { id: user.instanceId, name: org ? org.name : user.instanceId },
    children: await repo.listChildren(), entries: await repo.listAllEntries(),
    settings: { rates: await repo.getRates(), opening: await repo.getOpening(), startDate: await repo.getStartDate(), vacations: await repo.getVacations(), sickDays: await repo.getSickDays(), agencyIds: await repo.getAgencyIds(), agencyLinks: await repo.getAgencyLinks(), monthStatus: await repo.listMonthStatuses(), holidays: await repo.getHolidays(), careTypes: await repo.getCareTypes(), agencyRates: await repo.getAgencyRates(), agencies: await mine(repo), ownChildren: await repo.getOwnChildren() },
    members,
  };
  return { status: 200, jsonBody: payload, headers: { 'content-disposition': `attachment; filename="export-${user.instanceId}-${now.toISOString().slice(0, 10)}.json"` } };
}

module.exports = { importPlanning, createAgency, updateAgency, RETENTION_DAYS, listOrganisations, createOrganisation, renameOrganisation, addOrganisationManager, deleteOrganisation, restoreOrganisation, purgeOrganisation, exportData };
