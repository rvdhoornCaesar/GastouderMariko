const { HttpError } = require('./errors');
const { fixedUsers, sessionToken, sessionCookie, expiredCookie, SESSION_DAYS } = require('./auth');
const P = require('./passwords');
const v = require('./validation');

const newId = () => Math.random().toString(36).slice(2, 10).padEnd(8, '0');

// Elke handler krijgt de gebruiker, een repository en de request-data, en geeft { status, jsonBody } terug.
// Alle gegevens zijn gedeeld door de toegestane gebruikers van de omgeving.

async function listChildren({ repo }) {
  return { status: 200, jsonBody: await repo.listChildren() };
}

async function createChild({ repo, body }) {
  const child = { id: newId(), ...v.parseChild(body, newId) };
  await repo.saveChild(child);
  return { status: 201, jsonBody: child };
}

async function updateChild({ repo, params, body }) {
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

async function deleteChild({ repo, params }) {
  const id = v.parseId(params.id);
  const existing = await repo.getChild(id);
  if (existing) {
    await repo.deleteEntriesOfContracts(existing.contracts.map((k) => k.id));
    await repo.deleteChild(id);
  }
  return { status: 204 };
}

async function listEntries({ repo, query }) {
  return { status: 200, jsonBody: await repo.listEntriesOfMonth(v.parseMonth(query.month)) };
}

async function createEntry({ repo, body }) {
  const data = v.parseEntry(body);
  const children = await repo.listChildren();
  if (!children.some((c) => c.contracts.some((k) => k.id === data.contractId))) throw new HttpError(400, 'Dat contract bestaat niet.');
  const entry = { id: `${data.date}_${newId()}`, ...data };
  await repo.saveEntry(entry);
  return { status: 201, jsonBody: entry };
}

async function deleteEntry({ repo, params }) {
  await repo.deleteEntry(v.parseEntryId(params.id));
  return { status: 204 };
}

// Instellingen: algemene tarieven en toegestane gebruikers.
// "fixedUsers" komen uit de app-setting ALLOWED_USERS en kunnen niet in de app worden verwijderd.
async function getSettings({ user, repo, env }) {
  const opening = (await repo.getOpening()) || v.DEFAULT_OPENING;
  return { status: 200, jsonBody: { rates: await repo.getRates(), users: await repo.getUsers(), fixedUsers: fixedUsers(env), me: user.email, opening, ownChildren: await repo.getOwnChildren(), runtime: process.version } };
}

async function putRates({ repo, body }) {
  const rates = v.parseRates(body && body.rates, newId);
  await repo.setRates(rates);
  return { status: 200, jsonBody: { rates } };
}

async function putOwnChildren({ repo, body }) {
  const ownChildren = v.parseOwnChildren(body && body.ownChildren, newId);
  await repo.setOwnChildren(ownChildren);
  return { status: 200, jsonBody: { ownChildren } };
}

async function putOpening({ repo, body }) {
  const opening = v.parseOpening(body);
  await repo.setOpening(opening);
  return { status: 200, jsonBody: { opening } };
}

async function putUsers({ user, repo, env, body }) {
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
const toAccount = (e) => ({ email: e.rowKey, name: e.name, role: e.role, instanceId: e.instanceId, passwordHash: e.passwordHash, mustChange: e.mustChange, createdAt: e.createdAt, lastLogin: e.lastLogin });
const publicAccount = ({ email, name, role, instanceId, mustChange, createdAt, lastLogin }) => ({ email, name, role, instanceId, mustChange: !!mustChange, createdAt, lastLogin: lastLogin || null });

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

async function login({ repo, body, now = new Date() }) {
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
  await repo.clearThrottle(key);
  const token = P.newToken();
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * 86400000).toISOString();
  await repo.createSession(P.hashToken(token), { email, createdAt: now.toISOString(), expiresAt });
  await repo.saveAccount({ ...toAccount(entity), lastLogin: now.toISOString() });
  try { await repo.purgeExpiredSessions(now.toISOString()); } catch { /* opruimen mag falen */ }
  return { status: 200, jsonBody: { email, name: entity.name || email, mustChange: !!entity.mustChange }, cookies: [sessionCookie(token)] };
}

async function logout({ repo, headers }) {
  const token = sessionToken(headers);
  if (token) await repo.deleteSession(P.hashToken(token));
  return { status: 200, jsonBody: { ok: true }, cookies: [expiredCookie()] };
}

async function me({ user }) {
  return { status: 200, jsonBody: { kind: user.kind, email: user.email, name: user.name, admin: user.admin, role: user.role, mustChange: user.mustChange } };
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

function requireAdmin(user) {
  if (!user.admin) throw new HttpError(403, 'Alleen beheerders mogen lokale accounts beheren.');
}

async function listAccounts({ user, repo }) {
  requireAdmin(user);
  const list = (await repo.listAccounts()).map(toAccount).map(publicAccount).sort((a, b) => a.email.localeCompare(b.email));
  return { status: 200, jsonBody: list };
}

// Het tijdelijke wachtwoord wordt maar één keer getoond; daarna staat er alleen een hash.
async function createAccount({ user, repo, body, now = new Date() }) {
  requireAdmin(user);
  const email = v.parseAccountEmail(body && body.email);
  if (await repo.getAccount(email)) throw new HttpError(409, 'Er bestaat al een account met dit e-mailadres.');
  const tempPassword = P.generateTempPassword();
  const account = { email, name: String((body && body.name) ?? '').trim().slice(0, 100), role: 'beheerder', instanceId: 'main', mustChange: true, createdAt: now.toISOString() };
  await repo.saveAccount({ ...account, passwordHash: await P.hashPassword(tempPassword) });
  return { status: 201, jsonBody: { account: publicAccount(account), tempPassword } };
}

async function resetAccount({ user, repo, params }) {
  requireAdmin(user);
  const email = v.parseAccountEmail(decodeURIComponent(params.email));
  const entity = await repo.getAccount(email);
  if (!entity) throw new HttpError(404, 'Account niet gevonden.');
  const tempPassword = P.generateTempPassword();
  await repo.saveAccount({ ...toAccount(entity), passwordHash: await P.hashPassword(tempPassword), mustChange: true });
  await repo.deleteSessionsOf(email);
  await repo.clearThrottle(throttleKey(email));
  return { status: 200, jsonBody: { tempPassword } };
}

async function deleteAccount({ user, repo, params }) {
  requireAdmin(user);
  const email = v.parseAccountEmail(decodeURIComponent(params.email));
  await repo.deleteSessionsOf(email);
  await repo.deleteAccount(email);
  await repo.clearThrottle(throttleKey(email));
  return { status: 204 };
}

module.exports = { login, logout, me, changePassword, listAccounts, createAccount, resetAccount, deleteAccount, listChildren, createChild, updateChild, deleteChild, listEntries, createEntry, deleteEntry, getSettings, putRates, putOpening, putOwnChildren, putUsers };
