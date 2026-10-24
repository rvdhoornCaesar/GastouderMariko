const { HttpError } = require('./errors');
const { fixedUsers, sessionToken, sessionCookie, expiredCookie, SESSION_DAYS } = require('./auth');
const P = require('./passwords');
const T = require('./totp');
const perm = require('./permissions');
const v = require('./validation');

const newId = () => Math.random().toString(36).slice(2, 10).padEnd(8, '0');

// Elke handler krijgt de gebruiker, een repository en de request-data, en geeft { status, jsonBody } terug.
// Alle gegevens zijn gedeeld door de toegestane gebruikers van de omgeving.

async function listChildren({ user, repo }) {
  perm.require(user, 'children:read');
  return { status: 200, jsonBody: await repo.listChildren() };
}

async function createChild({ user, repo, body }) {
  perm.require(user, 'children:write');
  const child = { id: newId(), ...v.parseChild(body, newId) };
  await repo.saveChild(child);
  return { status: 201, jsonBody: child };
}

async function updateChild({ user, repo, params, body }) {
  perm.require(user, 'children:write');
  const id = v.parseId(params.id);
  const existing = await repo.getChild(id);
  if (!existing) throw new HttpError(404, 'Kind niet gevonden.');
  const child = { id, ...v.parseChild(body, newId) };

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
  return { status: 200, jsonBody: await repo.listEntriesOfMonth(v.parseMonth(query.month)) };
}

async function createEntry({ user, repo, body }) {
  perm.require(user, 'entries:write');
  const data = v.parseEntry(body);
  const children = await repo.listChildren();
  if (!children.some((c) => c.contracts.some((k) => k.id === data.contractId))) throw new HttpError(400, 'Dat contract bestaat niet.');
  const entry = { id: `${data.date}_${newId()}`, ...data };
  await repo.saveEntry(entry);
  return { status: 201, jsonBody: entry };
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
  return { status: 200, jsonBody: { rates: await repo.getRates(), users: manage ? await repo.getUsers() : [], fixedUsers: manage ? fixedUsers(env) : [], me: user.email, opening, ownChildren: await repo.getOwnChildren(), runtime: manage ? process.version : undefined } };
}

async function putRates({ user, repo, body }) {
  perm.require(user, 'settings:write');
  const rates = v.parseRates(body && body.rates, newId);
  await repo.setRates(rates);
  return { status: 200, jsonBody: { rates } };
}

async function putOwnChildren({ user, repo, body }) {
  perm.require(user, 'settings:write');
  const ownChildren = v.parseOwnChildren(body && body.ownChildren, newId);
  await repo.setOwnChildren(ownChildren);
  return { status: 200, jsonBody: { ownChildren } };
}

async function putOpening({ user, repo, body }) {
  perm.require(user, 'settings:write');
  const opening = v.parseOpening(body);
  await repo.setOpening(opening);
  return { status: 200, jsonBody: { opening } };
}

async function putUsers({ user, repo, env, body }) {
  perm.require(user, 'settings:write');
  const fixed = fixedUsers(env);
  const users = v.parseUsers(body && body.users).filter((e) => !fixed.includes(e));
  if (!user.fixed && !users.includes(user.email)) throw new HttpError(400, 'Je kunt jezelf niet verwijderen.');
  await repo.setUsers(users);
  return { status: 200, jsonBody: { users } };
}

// --- Lokale accounts: inloggen, uitloggen, wachtwoord wijzigen en (voor beheerders) accountbeheer ---
// Wachtwoorden staan nooit leesbaar in de opslag (alleen scrypt-hashes) en sessiesleutels alleen als SHA-256.

const MAX_FAILED = 5;   // na elke 5 mislukte pogingen een blokkade van 15 minuten, steeds twee keer zo lang (max. een dag)
const lockMinutes = (count) => Math.min(15 * 2 ** (Math.floor(count / MAX_FAILED) - 1), 24 * 60);
const throttleKey = (email) => P.hashToken(`login:${email}`);
const toAccount = (e) => ({ email: e.rowKey, name: e.name, role: e.role, instanceId: e.instanceId, passwordHash: e.passwordHash, mustChange: e.mustChange, createdAt: e.createdAt, lastLogin: e.lastLogin,
  totpSecret: e.totpSecret, totpPending: e.totpPending, totpLastStep: e.totpLastStep, recoveryCodes: e.recoveryCodes });
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

async function me({ user }) {
  return { status: 200, jsonBody: { kind: user.kind, email: user.email, name: user.name, role: user.role, permissions: perm.permissionsOf(user.role), assignableRoles: perm.assignableRoles(user.role), mustChange: user.mustChange, totp: !!user.totp } };
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

// Een account mag alleen beheerd worden binnen de eigen instantie, met een rol tot en met die van jezelf, en nooit je eigen account
// (je eigen wachtwoord wijzig je bij Account; zo kun je jezelf ook niet buitensluiten of een hogere rol geven).
const manageable = (user, a) => perm.canManageRole(user, a.role) && a.instanceId === user.instanceId && a.email !== user.email;
async function manageTarget(user, repo, rawEmail) {
  requireAdmin(user);
  const email = v.parseAccountEmail(decodeURIComponent(rawEmail));
  const entity = await repo.getAccount(email);
  if (!entity) throw new HttpError(404, 'Account niet gevonden.');
  if (!manageable(user, toAccount(entity))) throw new HttpError(403, 'Je kunt dit account niet beheren.');
  return entity;
}

async function listAccounts({ user, repo }) {
  requireAdmin(user);
  const list = (await repo.listAccounts()).map(toAccount).filter((a) => a.instanceId === user.instanceId)
    .map((a) => ({ ...publicAccount(a), manageable: manageable(user, a) })).sort((a, b) => a.email.localeCompare(b.email));
  return { status: 200, jsonBody: list };
}

// Het tijdelijke wachtwoord wordt maar één keer getoond; daarna staat er alleen een hash.
async function createAccount({ user, repo, body, now = new Date() }) {
  requireAdmin(user);
  const email = v.parseAccountEmail(body && body.email);
  const role = body && body.role !== undefined ? v.parseRole(body.role) : 'gebruiker';   // standaard de minste rechten
  if (!perm.canManageRole(user, role)) throw new HttpError(403, 'Je kunt geen account met deze rol aanmaken.');
  if (await repo.getAccount(email)) throw new HttpError(409, 'Er bestaat al een account met dit e-mailadres.');
  const tempPassword = P.generateTempPassword();
  const account = { email, name: String((body && body.name) ?? '').trim().slice(0, 100), role, instanceId: user.instanceId, mustChange: true, createdAt: now.toISOString() };
  await repo.saveAccount({ ...account, passwordHash: await P.hashPassword(tempPassword) });
  return { status: 201, jsonBody: { account: publicAccount(account), tempPassword } };
}

async function resetAccount({ user, repo, params }) {
  const entity = await manageTarget(user, repo, params.email);
  const email = entity.rowKey;
  const tempPassword = P.generateTempPassword();
  await repo.saveAccount({ ...toAccount(entity), passwordHash: await P.hashPassword(tempPassword), mustChange: true, totpSecret: '', totpPending: '', totpLastStep: 0, recoveryCodes: '[]' }); // ook 2FA terugzetten: telefoon kwijt is een gewone reden voor een reset
  await repo.deleteSessionsOf(email);
  await repo.clearThrottle(throttleKey(email));
  return { status: 200, jsonBody: { tempPassword } };
}

async function setAccountRole({ user, repo, params, body }) {
  const entity = await manageTarget(user, repo, params.email);
  const role = v.parseRole(body && body.role);
  if (!perm.canManageRole(user, role)) throw new HttpError(403, 'Je kunt deze rol niet toekennen.');
  await repo.saveAccount({ ...toAccount(entity), role });
  await repo.deleteSessionsOf(entity.rowKey);   // rechten veranderen: opnieuw inloggen
  return { status: 200, jsonBody: publicAccount({ ...toAccount(entity), role }) };
}

async function deleteAccount({ user, repo, params }) {
  const entity = await manageTarget(user, repo, params.email);
  await repo.deleteSessionsOf(entity.rowKey);
  await repo.deleteAccount(entity.rowKey);
  await repo.clearThrottle(throttleKey(entity.rowKey));
  return { status: 204 };
}

module.exports = { setAccountRole, login, loginMfa, totpStart, totpEnable, totpDisable, logout, me, changePassword, listAccounts, createAccount, resetAccount, deleteAccount, listChildren, createChild, updateChild, deleteChild, listEntries, createEntry, deleteEntry, getSettings, putRates, putOpening, putOwnChildren, putUsers };
