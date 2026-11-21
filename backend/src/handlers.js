const { HttpError } = require('./errors');
const { fixedUsers, sessionToken, sessionCookie, expiredCookie, SESSION_DAYS } = require('./auth');
const P = require('./passwords');
const T = require('./totp');
const perm = require('./permissions');
const { LIMIT, selfOverlap } = require('./agency-links');
const { careInfo, warningsOf, typesOf } = require('./care-types');
const v = require('./validation');

const newId = () => Math.random().toString(36).slice(2, 10).padEnd(8, '0');

// Elke handler krijgt de gebruiker, een repository en de request-data, en geeft { status, jsonBody } terug.
// Alle gegevens zijn gedeeld door de toegestane gebruikers van de omgeving.

async function listChildren({ user, repo }) {
  perm.require(user, 'children:read');
  return { status: 200, jsonBody: await repo.listChildren() };
}

// Een contract mag alleen naar een gastouderbureau verwijzen waarbij deze gastouder is aangesloten (Instellingen); een bestaande verwijzing mag blijven.
// Het gastouderbureau en de soort opvang (gastouder of bso) van een contract: alleen wat voor deze gastouder beschikbaar is. Wat al bij een bestaand
// contract stond mag blijven, ook als het inmiddels niet meer beschikbaar is.
async function careState(repo) {
  const links = await repo.getAgencyLinks(), agencies = await repo.listAgencies();
  return { links, agencies, ...careInfo(links, agencies, await repo.getCareTypes()) };
}
async function checkAgencies(repo, contracts, existing) {
  const state = await careState(repo);
  const before = new Map((existing ? existing.contracts : []).map((k) => [k.id, k]));
  const byId = new Map(state.agencies.map((a) => [a.id, a]));
  const linked = new Set(state.links.map((l) => l.agencyId));
  for (const k of contracts) {
    const old = before.get(k.id);
    if (k.agencyId && !linked.has(k.agencyId) && !(old && old.agencyId === k.agencyId)) throw new HttpError(400, 'Kies een gastouderbureau waarbij de gastouder is aangesloten (zie Instellingen).');
    if (!(old && (old.type || 'gastouder') === k.type) && !state.enabledTypes.includes(k.type)) throw new HttpError(400, `Opvang van het type ${k.type} is niet beschikbaar: geen van je gastouderbureaus doet dat, of je hebt het uitgezet bij Instellingen.`);
    if (k.agencyId && !(old && old.agencyId === k.agencyId && (old.type || 'gastouder') === k.type) && !typesOf(byId.get(k.agencyId)).includes(k.type)) throw new HttpError(400, `Dit gastouderbureau doet geen ${k.type}. Kies een ander bureau of een andere soort opvang.`);
  }
}

async function createChild({ user, repo, body }) {
  perm.require(user, 'children:write');
  if (await agencyRequired(repo, user)) throw new HttpError(400, 'Kies eerst je gastouderbureau(s) bij Instellingen; daarna kun je kinderen toevoegen.');
  const child = { id: newId(), ...v.parseChild(body, newId) };
  child.photo = child.photo ?? null;
  await checkAgencies(repo, child.contracts, null);
  await repo.saveChild(child);
  return { status: 201, jsonBody: child };
}

async function updateChild({ user, repo, params, body }) {
  perm.require(user, 'children:write');
  const id = v.parseId(params.id);
  const existing = await repo.getChild(id);
  if (!existing) throw new HttpError(404, 'Kind niet gevonden.');
  const child = { id, ...v.parseChild(body, newId) };
  if (child.photo === undefined) child.photo = existing.photo || null;   // niet meegestuurd: de foto blijft
  await checkAgencies(repo, child.contracts, existing);

  // Verwijderde contracten nemen hun uren mee.
  const kept = new Set(child.contracts.map((k) => k.id));
  const removed = existing.contracts.map((k) => k.id).filter((cid) => !kept.has(cid));
  if (removed.length) await repo.deleteEntriesOfContracts(removed);

  await repo.saveChild(child);
  return { status: 200, jsonBody: child };
}

async function deleteChild({ user, repo, params }) {
  perm.require(user, 'children:write');
  const id = v.parseId(params.id);
  const existing = await repo.getChild(id);
  if (existing) {
    await repo.deleteEntriesOfContracts(existing.contracts.map((k) => k.id));
    await repo.deleteChild(id);
  }
  return { status: 204 };
}

async function listEntries({ user, repo, query }) {
  perm.require(user, 'entries:read');
  const startDate = await repo.getStartDate();   // uren van vóór de begindatum van de gastouder worden genegeerd
  const entries = await repo.listEntriesOfMonth(v.parseMonth(query.month));
  return { status: 200, jsonBody: startDate ? entries.filter((e) => e.date >= startDate) : entries };
}

async function createEntry({ user, repo, body }) {
  perm.require(user, 'entries:write');
  const data = v.parseEntry(body);
  const children = await repo.listChildren();
  if (!children.some((c) => c.contracts.some((k) => k.id === data.contractId))) throw new HttpError(400, 'Dat contract bestaat niet.');
  const startDate = await repo.getStartDate();
  if (startDate && data.date < startDate) throw new HttpError(400, 'Vóór de begindatum van de gastouder kun je geen uren invullen.');
  const entry = { id: `${data.date}_${newId()}`, ...data };
  await repo.saveEntry(entry);
  return { status: 201, jsonBody: entry };
}

// Meerdere registraties tegelijk (bijvoorbeeld geplande uren van een maand overnemen). Eerst alles controleren, dan opslaan.
async function createEntries({ user, repo, body }) {
  perm.require(user, 'entries:write');
  const list = body && body.entries;
  if (!Array.isArray(list) || !list.length || list.length > 100) throw new HttpError(400, 'Geef 1 tot 100 registraties op.');
  const items = list.map((e) => v.parseEntry(e));
  const children = await repo.listChildren();
  const contractIds = new Set(children.flatMap((c) => c.contracts.map((k) => k.id)));
  const startDate = await repo.getStartDate();
  for (const e of items) {
    if (!contractIds.has(e.contractId)) throw new HttpError(400, 'Dat contract bestaat niet.');
    if (startDate && e.date < startDate) throw new HttpError(400, 'Vóór de begindatum van de gastouder kun je geen uren invullen.');
  }
  const saved = [];
  for (const data of items) {
    const entry = { id: `${data.date}_${newId()}`, ...data };
    await repo.saveEntry(entry);
    saved.push(entry);
  }
  return { status: 201, jsonBody: { entries: saved } };
}

// Registratie bewerken. Verandert de datum, dan krijgt de registratie een nieuw id (het id begint met de datum).
async function updateEntry({ user, repo, params, body }) {
  perm.require(user, 'entries:write');
  const id = v.parseEntryId(params.id);
  if (!(await repo.getEntry(id))) throw new HttpError(404, 'Niet gevonden.');
  const data = v.parseEntry(body);
  const children = await repo.listChildren();
  if (!children.some((c) => c.contracts.some((k) => k.id === data.contractId))) throw new HttpError(400, 'Dat contract bestaat niet.');
  const startDate = await repo.getStartDate();
  if (startDate && data.date < startDate) throw new HttpError(400, 'Vóór de begindatum van de gastouder kun je geen uren invullen.');
  const entry = { id: data.date === id.slice(0, 10) ? id : `${data.date}_${newId()}`, ...data };
  await repo.saveEntry(entry);
  if (entry.id !== id) await repo.deleteEntry(id);
  return { status: 200, jsonBody: entry };
}

async function deleteEntry({ user, repo, params }) {
  perm.require(user, 'entries:write');
  await repo.deleteEntry(v.parseEntryId(params.id));
  return { status: 204 };
}

// Instellingen: algemene tarieven en toegestane gebruikers.
// "fixedUsers" komen uit de app-setting ALLOWED_USERS en kunnen niet in de app worden verwijderd.
async function getSettings({ user, repo, env }) {
  perm.require(user, 'settings:read');
  const opening = (await repo.getOpening()) || v.DEFAULT_OPENING;
  const manage = perm.can(user, 'settings:write');   // wie mag toegang regelen, ziet de gebruikerslijsten en de technische info
  return { status: 200, jsonBody: { rates: await repo.getRates(), users: manage ? await msMembers(repo, user.instanceId, env) : [], fixedUsers: manage ? fixedUsers(env) : [], me: user.email, opening, ownChildren: await repo.getOwnChildren(), vacations: await repo.getVacations(), sickDays: await repo.getSickDays(), ...(await careSettings(repo, user)), monthStatus: await monthStatusMap(repo), holidays: await holidaySettings(repo), startDate: await repo.getStartDate(), firstEntry: await repo.firstEntryDate(), runtime: manage ? process.version : undefined } };
}

// Nieuwe organisaties moeten eerst een gastouderbureau kiezen (onboarding) voordat er kinderen bij kunnen. Bestaande organisaties zijn daarvan vrijgesteld.
async function agencyRequired(repo, user) {
  const org = user && user.instanceId ? await repo.getOrganisation(user.instanceId) : null;
  return !!(org && org.needsAgency && !(await repo.getAgencyLinks()).length);
}

// Algemene tarieven per soort opvang: alleen voor soorten die beschikbaar zijn (een bestaand tarief mag blijven).
async function putRates({ user, repo, body }) {
  perm.require(user, 'settings:write');
  const rates = v.parseRates(body && body.rates, newId);
  const { enabledTypes } = await careState(repo);
  const old = new Map((await repo.getRates()).map((r) => [r.id, r]));
  const bad = rates.find((r) => !enabledTypes.includes(r.type) && !(old.get(r.id) && (old.get(r.id).type || 'gastouder') === r.type));
  if (bad) throw new HttpError(400, `Opvang van het type ${bad.type} is niet beschikbaar: geen van je gastouderbureaus doet dat, of je hebt het uitgezet bij Instellingen.`);
  await repo.setRates(rates);
  return { status: 200, jsonBody: { rates } };
}

// Soorten opvang die de gastouder doet (aanvinken); alleen soorten die minstens één van haar gastouderbureaus doet.
async function putCareTypes({ user, repo, body }) {
  perm.require(user, 'settings:write');
  const types = v.parseTypes(body && body.careTypes);
  const state = await careState(repo);
  if (types.some((t) => !state.availableTypes.includes(t))) throw new HttpError(400, 'Geen van je gastouderbureaus doet die soort opvang.');
  await repo.setCareTypes(types);
  return { status: 200, jsonBody: await careSettings(repo) };
}

// Tarieven per gastouderbureau (en soort): alleen voor bureaus waarbij de gastouder is aangesloten, soorten die dat bureau doet en die beschikbaar zijn.
async function putAgencyRates({ user, repo, body }) {
  perm.require(user, 'settings:write');
  const rates = v.parseAgencyRates(body && body.agencyRates, newId);
  const state = await careState(repo), byId = new Map(state.agencies.map((a) => [a.id, a])), linked = new Set(state.links.map((l) => l.agencyId));
  const old = new Map((await repo.getAgencyRates()).map((r) => [r.id, r]));
  for (const r of rates) {
    const unchanged = old.get(r.id) && old.get(r.id).agencyId === r.agencyId && old.get(r.id).type === r.type;
    if (!linked.has(r.agencyId) && !unchanged) throw new HttpError(400, 'Kies een gastouderbureau waarbij de gastouder is aangesloten.');
    if (!typesOf(byId.get(r.agencyId)).includes(r.type) && !unchanged) throw new HttpError(400, `Dit gastouderbureau doet geen ${r.type}.`);
    if (!state.enabledTypes.includes(r.type) && !unchanged) throw new HttpError(400, `Opvang van het type ${r.type} is niet beschikbaar.`);
  }
  await repo.setAgencyRates(rates);
  return { status: 200, jsonBody: { agencyRates: rates } };
}

// Alles over soorten opvang en aansluitingen voor in de instellingen.
async function careSettings(repo, user) {
  const s = await careState(repo);
  return { agencies: s.agencies, agencyIds: await repo.getAgencyIds(), agencyLinks: s.links, agencyWarnings: warningsOf(s.links, s.agencies), agencyLimit: LIMIT,
    careTypes: s.careTypes, availableTypes: s.availableTypes, enabledTypes: s.enabledTypes, agencyRates: await repo.getAgencyRates(), agencyRequired: await agencyRequired(repo, user) };
}

// Bij welke gastouderbureaus is deze gastouder aangesloten? Alleen bureaus uit de gedeelde lijst; een niet-actief bureau kan alleen blijven staan.
// Per aansluiting een periode (van en t/m, leeg = open). De uitkomst bevat ook de periodes waarin er meer dan het maximum aan bureaus tegelijk is
// (een waarschuwing, geen weigering: er zijn uitzonderingen, zie agency-links.js).
async function putAgencyLinks({ user, repo, body }) {
  perm.require(user, 'settings:write');
  const links = body && body.links !== undefined ? v.parseAgencyLinks(body.links) : v.parseAgencyIds(body && body.agencyIds).map((agencyId) => ({ agencyId, from: null, to: null }));
  const known = new Map((await repo.listAgencies()).map((a) => [a.id, a]));
  const overlap = selfOverlap(links);
  if (overlap) {
    const nl = (d) => (d ? d.split('-').reverse().join('-') : null), span = (p) => `${p.from ? `vanaf ${nl(p.from)}` : 'sinds het begin'} ${p.to ? `t/m ${nl(p.to)}` : '(doorlopend)'}`;
    throw new HttpError(400, `${(known.get(overlap.agencyId) || {}).name || 'Dit bureau'} heeft overlappende periodes (${span(overlap.a)} en ${span(overlap.b)}). Eén bureau kan niet twee keer tegelijk worden aangesloten; pas de datums aan of verwijder een aansluiting.`);
  }
  const current = new Set((await repo.getAgencyLinks()).map((l) => l.agencyId));
  if (links.some((l) => !known.has(l.agencyId) || (!known.get(l.agencyId).active && !current.has(l.agencyId)))) throw new HttpError(400, 'Dat gastouderbureau bestaat niet of is niet meer actief.');
  await repo.setAgencyLinks(links);
  const agencyIds = [...new Set(links.map((l) => l.agencyId))];
  await repo.setAgencyIds(agencyIds);   // contracten mogen kiezen uit alle bureaus waarbij de gastouder (ooit) is aangesloten
  return { status: 200, jsonBody: await careSettings(repo, user) };
}

async function putOwnChildren({ user, repo, body }) {
  perm.require(user, 'settings:write');
  const ownChildren = v.parseOwnChildren(body && body.ownChildren, newId);
  await repo.setOwnChildren(ownChildren);
  return { status: 200, jsonBody: { ownChildren } };
}

// Status van de uren van een kind in een maand (geen status, uren ingediend, betaald), ter voorbereiding op een koppeling met de software van het bureau.
// Dat mag iedereen die uren invult. De status verandert niets aan de uren zelf; de app waarschuwt alleen als je uren wijzigt van een maand die al is ingediend.
async function putMonthStatus({ user, repo, body, now = new Date() }) {
  perm.require(user, 'entries:write');
  const s = v.parseMonthStatus(body);
  if (!(await repo.getChild(s.childId))) throw new HttpError(404, 'Kind niet gevonden.');
  await repo.setMonthStatus(s.childId, s.month, s.status, user.email, now.toISOString());
  return { status: 200, jsonBody: { monthStatus: await monthStatusMap(repo) } };
}
const monthStatusMap = async (repo) => Object.fromEntries((await repo.listMonthStatuses()).map((r) => [`${r.childId}|${r.month}`, { status: r.status, by: r.by, at: r.at }]));

// Feestdagen die als gesloten gelden, met uitzonderingen per datum (open ondanks de feestdag). Zonder eigen keuze geldt de standaardlijst.
const holidaySettings = async (repo) => (await repo.getHolidays()) || { closed: v.HOLIDAYS_DEFAULT, openDates: [] };
async function putHolidays({ user, repo, body }) {
  perm.require(user, 'settings:write');
  const h = v.parseHolidaySettings(body);
  await repo.setHolidays(h);
  return { status: 200, jsonBody: { holidays: h } };
}

// De gastouder ziek melden voor één dag (of dat ongedaan maken). Dat mag iedereen die uren invult, dus ook een gebruiker.
const MAX_SICK_DAYS = 1000;   // de lijst staat in één rij (maximaal 32.000 tekens)
async function putSickDay({ user, repo, body }) {
  perm.require(user, 'entries:write');
  const { date, sick } = v.parseSickDay(body);
  const startDate = await repo.getStartDate();
  if (sick && startDate && date < startDate) throw new HttpError(400, 'Vóór de begindatum van de gastouder kun je niet ziek melden.');
  const current = await repo.getSickDays();
  const set = new Set(current);
  if (sick) set.add(date); else set.delete(date);
  if (set.size > MAX_SICK_DAYS) throw new HttpError(400, `Er kunnen maximaal ${MAX_SICK_DAYS} ziekmeldingen worden bewaard.`);
  const sickDays = [...set].sort();
  if (sickDays.length !== current.length || sickDays.some((d, i) => d !== current[i])) await repo.setSickDays(sickDays);
  return { status: 200, jsonBody: { sickDays } };
}

async function putStartDate({ user, repo, body }) {
  perm.require(user, 'settings:write');
  const startDate = v.parseStartDate(body && body.startDate);
  await repo.setStartDate(startDate);
  return { status: 200, jsonBody: { startDate } };
}

async function putVacations({ user, repo, body }) {
  perm.require(user, 'settings:write');
  const vacations = v.parseVacations(body && body.vacations, newId);
  await repo.setVacations(vacations);
  return { status: 200, jsonBody: { vacations } };
}

async function putOpening({ user, repo, body }) {
  perm.require(user, 'settings:write');
  const opening = v.parseOpening(body);
  await repo.setOpening(opening);
  return { status: 200, jsonBody: { opening } };
}

// Microsoft-gebruikers van een organisatie: leden zonder lokaal account (die staan bij Lokale accounts) en niet de vaste beheerders.
async function msMembers(repo, orgId, env) {
  const fixed = fixedUsers(env), out = [];
  for (const m of await repo.listMembersOf(orgId)) if (!fixed.includes(m.email) && !(await repo.getAccount(m.email))) out.push(m.email);
  return out;
}

async function putUsers({ user, repo, env, body, now = new Date() }) {
  perm.require(user, 'settings:write');
  const fixed = fixedUsers(env);
  const users = v.parseUsers(body && body.users).filter((e) => !fixed.includes(e));
  if (!user.fixed && !users.includes(user.email) && !(await repo.getAccount(user.email))) throw new HttpError(400, 'Je kunt jezelf niet verwijderen.');
  const current = await msMembers(repo, user.instanceId, env);
  for (const email of users) {
    if (!(await repo.getMembership(user.instanceId, email))) await repo.saveMembership({ orgId: user.instanceId, email, role: 'beheerder', createdAt: now.toISOString(), source: 'toegestane gebruiker' });
  }
  for (const email of current) if (!users.includes(email)) await repo.deleteMembership(user.instanceId, email);
  await repo.setUsers(users);   // ook in de oude lijst, zodat terugdraaien naar de vorige versie dezelfde toegang geeft
  return { status: 200, jsonBody: { users } };
}

// --- Lokale accounts: inloggen, uitloggen, wachtwoord wijzigen en (voor beheerders) accountbeheer ---
// Wachtwoorden staan nooit leesbaar in de opslag (alleen scrypt-hashes) en sessiesleutels alleen als SHA-256.

const MAX_FAILED = 5;   // na elke 5 mislukte pogingen een blokkade van 15 minuten, steeds twee keer zo lang (max. een dag)
const lockMinutes = (count) => Math.min(15 * 2 ** (Math.floor(count / MAX_FAILED) - 1), 24 * 60);
const throttleKey = (email) => P.hashToken(`login:${email}`);
const toAccount = (e) => ({ email: e.rowKey, name: e.name, role: e.role, instanceId: e.instanceId, passwordHash: e.passwordHash, mustChange: e.mustChange, createdAt: e.createdAt, lastLogin: e.lastLogin,
  totpSecret: e.totpSecret, totpPending: e.totpPending, totpLastStep: e.totpLastStep, recoveryCodes: e.recoveryCodes, platformAdmin: e.platformAdmin });
const publicAccount = ({ email, name, role, instanceId, mustChange, createdAt, lastLogin, totpSecret }) => ({ email, name, role, instanceId, mustChange: !!mustChange, totp: !!totpSecret, createdAt, lastLogin: lastLogin || null });

async function checkThrottle(repo, key, now) {
  const t = await repo.getThrottle(key);
  if (t && t.lockedUntil && t.lockedUntil > now.toISOString()) throw new HttpError(429, 'Te veel mislukte pogingen. Probeer het later opnieuw.');
  return t;
}
async function recordFailure(repo, key, t, now) {
  const count = (t ? Number(t.count) : 0) + 1;
  const lockedUntil = count % MAX_FAILED === 0 ? new Date(now.getTime() + lockMinutes(count) * 60000).toISOString() : '';
  await repo.setThrottle(key, { count, lockedUntil });
}

async function login({ repo, body, env, now = new Date() }) {
  const raw = String((body && body.email) ?? '').trim().toLowerCase().slice(0, 200);
  const password = typeof (body && body.password) === 'string' ? body.password.slice(0, 1024) : '';
  let email = '';
  try { email = v.parseAccountEmail(raw); } catch { /* geen geldig adres: telt als onbekend account */ }
  const key = throttleKey(raw);
  const throttle = await checkThrottle(repo, key, now);
  const entity = email ? await repo.getAccount(email) : null;
  // Ook bij een onbekend adres rekenen we een hash uit, zodat de duur niet verraadt of een account bestaat.
  const ok = entity ? await P.verifyPassword(password, entity.passwordHash) : (await P.verifyPassword(password, await P.dummyHash()), false);
  if (!ok) {
    await recordFailure(repo, key, throttle, now);
    throw new HttpError(401, 'E-mailadres of wachtwoord klopt niet.');
  }
  if (entity.totpSecret) {
    // Wachtwoord klopt, maar er is nog een code nodig. De teller wordt pas na de tweede stap gewist.
    return { status: 200, jsonBody: { mfaRequired: true, ticket: T.makeTicket(email, now, env) } };
  }
  await repo.clearThrottle(key);
  return startSession(repo, entity, now);
}

async function startSession(repo, entity, now) {
  const email = entity.rowKey;
  const token = P.newToken();
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * 86400000).toISOString();
  await repo.createSession(P.hashToken(token), { email, createdAt: now.toISOString(), expiresAt });
  await repo.saveAccount({ ...toAccount(entity), lastLogin: now.toISOString() });
  try { await repo.purgeExpiredSessions(now.toISOString()); } catch { /* opruimen mag falen */ }
  return { status: 200, jsonBody: { email, name: entity.name || email, mustChange: !!entity.mustChange }, cookies: [sessionCookie(token)] };
}

// Controleert een code uit de authenticator-app of een herstelcode. Geeft de bij te werken velden terug, of null.
function checkSecondFactor(entity, input, now, env) {
  const secret = T.decrypt(entity.totpSecret, env);
  const step = T.verify(secret, input, now, entity.totpLastStep);
  if (step) return { totpLastStep: step };
  const hash = T.hashRecovery(input);
  const codes = JSON.parse(entity.recoveryCodes || '[]');
  if (T.normalizeRecovery(input).length === 10 && codes.includes(hash)) return { recoveryCodes: JSON.stringify(codes.filter((c) => c !== hash)), usedRecovery: true };
  return null;
}

async function loginMfa({ repo, body, env, now = new Date() }) {
  const email = T.readTicket(body && body.ticket, now, env);
  if (!email) throw new HttpError(401, 'Inloggen is verlopen. Log opnieuw in.');
  const key = throttleKey(email);
  const throttle = await checkThrottle(repo, key, now);
  const entity = await repo.getAccount(email);
  const patch = entity && entity.totpSecret ? checkSecondFactor(entity, body && body.code, now, env) : null;
  if (!patch) {
    await recordFailure(repo, key, throttle, now);
    throw new HttpError(401, 'De code klopt niet.');
  }
  const { usedRecovery, ...fields } = patch;
  const updated = { ...entity, ...fields };
  await repo.saveAccount({ ...toAccount(updated), ...fields });
  await repo.clearThrottle(key);
  const res = await startSession(repo, updated, now);
  if (usedRecovery) res.jsonBody.recoveryCodesLeft = JSON.parse(updated.recoveryCodes).length;
  return res;
}

// Tweestapsverificatie instellen: eerst geheim aanmaken (wachtwoord nodig), dan met een eerste code bevestigen.
async function confirmPassword(user, repo, password, now) {
  if (user.kind !== 'local') throw new HttpError(400, 'Alleen lokale accounts hebben tweestapsverificatie in deze app.');
  const key = throttleKey(user.email);
  const throttle = await checkThrottle(repo, key, now);
  const entity = await repo.getAccount(user.email);
  if (!(await P.verifyPassword(typeof password === 'string' ? password : '', entity.passwordHash))) {
    await recordFailure(repo, key, throttle, now);
    throw new HttpError(400, 'Het wachtwoord klopt niet.');
  }
  return entity;
}

async function totpStart({ user, repo, env, body, now = new Date() }) {
  const entity = await confirmPassword(user, repo, body && body.password, now);
  if (entity.totpSecret) throw new HttpError(409, 'Tweestapsverificatie staat al aan.');
  const secret = T.newSecret();
  await repo.saveAccount({ ...toAccount(entity), totpPending: T.encrypt(secret, env) });
  return { status: 200, jsonBody: { secret, uri: T.otpauthUri(secret, user.email) } };
}

async function totpEnable({ user, repo, env, body, now = new Date() }) {
  if (user.kind !== 'local') throw new HttpError(400, 'Alleen lokale accounts hebben tweestapsverificatie in deze app.');
  const key = throttleKey(user.email);
  const throttle = await checkThrottle(repo, key, now);
  const entity = await repo.getAccount(user.email);
  if (!entity.totpPending) throw new HttpError(400, 'Begin opnieuw met instellen.');
  const secret = T.decrypt(entity.totpPending, env);
  const step = T.verify(secret, body && body.code, now, 0);
  if (!step) {
    await recordFailure(repo, key, throttle, now);
    throw new HttpError(400, 'De code klopt niet. Controleer de klok van je telefoon en probeer het opnieuw.');
  }
  const recoveryCodes = Array.from({ length: 8 }, () => T.newRecoveryCode());
  await repo.saveAccount({ ...toAccount(entity), totpSecret: T.encrypt(secret, env), totpPending: '', totpLastStep: step, recoveryCodes: JSON.stringify(recoveryCodes.map(T.hashRecovery)) });
  await repo.clearThrottle(key);
  return { status: 200, jsonBody: { recoveryCodes } };
}

async function totpDisable({ user, repo, env, body, now = new Date() }) {
  const entity = await confirmPassword(user, repo, body && body.password, now);
  if (!entity.totpSecret) throw new HttpError(400, 'Tweestapsverificatie staat niet aan.');
  if (!checkSecondFactor(entity, body && body.code, now, env)) {
    const key = throttleKey(user.email);
    await recordFailure(repo, key, await repo.getThrottle(key), now);
    throw new HttpError(400, 'De code klopt niet.');
  }
  await repo.saveAccount({ ...toAccount(entity), totpSecret: '', totpPending: '', totpLastStep: 0, recoveryCodes: '[]' });
  return { status: 200, jsonBody: { ok: true } };
}

async function logout({ repo, headers }) {
  const token = sessionToken(headers);
  if (token) await repo.deleteSession(P.hashToken(token));
  return { status: 200, jsonBody: { ok: true }, cookies: [expiredCookie()] };
}

const THEMES = ['light', 'dark', 'auto'];
// Voorkeuren van de ingelogde persoon (nu het thema: licht, donker of automatisch naar het besturingssysteem; standaard automatisch).
async function putPrefs({ user, repo, body }) {
  const theme = body && body.theme;
  if (!THEMES.includes(theme)) throw new HttpError(400, 'Kies een thema: licht, donker of automatisch.');
  await repo.setUserPrefs(user.email, { theme });
  return { status: 200, jsonBody: { prefs: { theme } } };
}

async function me({ user, repo }) {
  const prefs = repo ? await repo.getUserPrefs(user.email) : {};
  return { status: 200, jsonBody: { prefs: { theme: THEMES.includes(prefs.theme) ? prefs.theme : 'auto' }, kind: user.kind, email: user.email, name: user.name, role: user.role, platformAdmin: !!user.platformAdmin,
    organisation: user.organisation, organisations: user.organisations || [],
    permissions: perm.permissionsFor(user), assignableRoles: perm.assignableRoles(user.role), mustChange: user.mustChange, totp: !!user.totp } };
}

async function changePassword({ user, repo, body, now = new Date() }) {
  if (user.kind !== 'local') throw new HttpError(400, 'Alleen lokale accounts hebben een wachtwoord in deze app.');
  const key = throttleKey(user.email);
  const throttle = await checkThrottle(repo, key, now);   // dezelfde teller als bij inloggen: ook hier kun je niet eindeloos gokken
  const entity = await repo.getAccount(user.email);
  const current = typeof (body && body.current) === 'string' ? body.current : '';
  if (!(await P.verifyPassword(current, entity.passwordHash))) {
    await recordFailure(repo, key, throttle, now);
    throw new HttpError(400, 'Het huidige wachtwoord klopt niet.');
  }
  const next = body.next;
  const problem = P.validatePassword(next, { email: user.email });
  if (problem) throw new HttpError(400, problem);
  if (next === current) throw new HttpError(400, 'Kies een ander wachtwoord dan het huidige.');
  await repo.saveAccount({ ...toAccount(entity), passwordHash: await P.hashPassword(next), mustChange: false });
  await repo.deleteSessionsOf(user.email, user.sessionHash);   // andere sessies (andere apparaten) vervallen
  await repo.clearThrottle(key);
  return { status: 200, jsonBody: { ok: true } };
}

const requireAdmin = (user) => perm.require(user, 'accounts:manage');

// Accounts beheren = de leden van de eigen organisatie die een lokaal account hebben. Je beheert alleen leden met een rol tot en met die van
// jezelf en nooit je eigen lidmaatschap (je eigen wachtwoord wijzig je bij Account; zo kun je jezelf ook niet buitensluiten of verheffen).
// Een account is van de persoon en kan in meerdere organisaties een lidmaatschap hebben; de rol hoort bij het lidmaatschap.
const manageable = (user, m) => perm.canManageRole(user, m.role) && m.email !== user.email;
async function manageTarget(user, repo, rawEmail) {
  requireAdmin(user);
  const email = v.parseAccountEmail(decodeURIComponent(rawEmail));
  const member = await repo.getMembership(user.instanceId, email), entity = await repo.getAccount(email);
  if (!member || !entity) throw new HttpError(404, 'Account niet gevonden.');
  if (!manageable(user, member)) throw new HttpError(403, 'Je kunt dit account niet beheren.');
  return { member, entity };
}
const memberAccount = (m, entity, instanceId) => ({ ...publicAccount(toAccount(entity)), role: m.role, instanceId });

async function listAccounts({ user, repo }) {
  requireAdmin(user);
  const list = [];
  for (const m of await repo.listMembersOf(user.instanceId)) {
    const entity = await repo.getAccount(m.email);
    if (entity) list.push({ ...memberAccount(m, entity, user.instanceId), manageable: manageable(user, m) });
  }
  return { status: 200, jsonBody: list };
}

// Het tijdelijke wachtwoord wordt maar één keer getoond; daarna staat er alleen een hash. Bestaat het adres al (de persoon zit in een andere
// organisatie), dan wordt alleen het lidmaatschap toegevoegd: de persoon houdt zijn eigen wachtwoord en er komt geen tijdelijk wachtwoord.
async function createAccount({ user, repo, body, now = new Date() }) {
  requireAdmin(user);
  const email = v.parseAccountEmail(body && body.email);
  const role = body && body.role !== undefined ? v.parseRole(body.role) : 'gebruiker';   // standaard de minste rechten
  if (!perm.canManageRole(user, role)) throw new HttpError(403, 'Je kunt geen account met deze rol aanmaken.');
  if (await repo.getMembership(user.instanceId, email)) throw new HttpError(409, 'Dit e-mailadres is al lid van deze organisatie.');
  let entity = await repo.getAccount(email), tempPassword = null;
  if (!entity) {
    tempPassword = P.generateTempPassword();
    // role en instanceId in het account zelf zijn alleen nog voor terugdraaien naar de vorige versie; de lidmaatschappen gelden.
    await repo.saveAccount({ email, name: String((body && body.name) ?? '').trim().slice(0, 100), role, instanceId: user.instanceId, mustChange: true, createdAt: now.toISOString(), passwordHash: await P.hashPassword(tempPassword) });
    entity = await repo.getAccount(email);
  }
  await repo.saveMembership({ orgId: user.instanceId, email, role, createdAt: now.toISOString(), source: 'accountbeheer' });
  return { status: 201, jsonBody: { account: memberAccount({ role }, entity, user.instanceId), tempPassword, existing: tempPassword === null } };
}

// Alleen als dit account nergens anders lid is. Anders zou een beheerder van de ene organisatie via een nieuw wachtwoord in een andere
// organisatie kunnen komen. De persoon wijzigt dan zelf zijn wachtwoord.
async function resetAccount({ user, repo, params }) {
  const { entity } = await manageTarget(user, repo, params.email);
  const email = entity.rowKey;
  if ((await repo.listMembershipsOf(email)).some((m) => m.orgId !== user.instanceId)) {
    throw new HttpError(403, 'Dit account hoort ook bij een andere organisatie; alleen de gebruiker zelf kan het wachtwoord wijzigen.');
  }
  const tempPassword = P.generateTempPassword();
  await repo.saveAccount({ ...toAccount(entity), passwordHash: await P.hashPassword(tempPassword), mustChange: true, totpSecret: '', totpPending: '', totpLastStep: 0, recoveryCodes: '[]' }); // ook 2FA terugzetten: telefoon kwijt is een gewone reden voor een reset
  await repo.deleteSessionsOf(email);
  await repo.clearThrottle(throttleKey(email));
  return { status: 200, jsonBody: { tempPassword } };
}

async function setAccountRole({ user, repo, params, body }) {
  const { member, entity } = await manageTarget(user, repo, params.email);
  const role = v.parseRole(body && body.role);
  if (!perm.canManageRole(user, role)) throw new HttpError(403, 'Je kunt deze rol niet toekennen.');
  await repo.saveMembership({ orgId: user.instanceId, email: member.email, role, createdAt: member.createdAt, source: member.source });
  return { status: 200, jsonBody: memberAccount({ role }, entity, user.instanceId) };   // de rol geldt bij het eerstvolgende verzoek
}

// Verwijdert het lidmaatschap. Het account zelf verdwijnt pas als de persoon nergens meer lid is.
async function deleteAccount({ user, repo, params }) {
  const { entity } = await manageTarget(user, repo, params.email);
  const email = entity.rowKey;
  await repo.deleteMembership(user.instanceId, email);
  if (!(await repo.listMembershipsOf(email)).length) {
    await repo.deleteSessionsOf(email);
    await repo.deleteAccount(email);
    await repo.clearThrottle(throttleKey(email));
  }
  return { status: 204 };
}

module.exports = { setAccountRole, login, loginMfa, totpStart, totpEnable, totpDisable, logout, me, changePassword, listAccounts, createAccount, resetAccount, deleteAccount, listChildren, createChild, updateChild, deleteChild, listEntries, createEntry, createEntries, updateEntry, deleteEntry, getSettings, putRates, putVacations, putStartDate, putOpening, putOwnChildren, putUsers, putSickDay, putHolidays, putPrefs, putMonthStatus, putAgencyLinks, putCareTypes, putAgencyRates };
