const { HttpError } = require('./errors');
const { hashToken } = require('./passwords');

// E-mailadressen uit de app-setting ALLOWED_USERS: de vaste gebruikers (beheerders).
// Zij kunnen nooit buitengesloten worden; extra gebruikers worden in de app beheerd (zie repo.getUsers).
function fixedUsers(env = process.env) {
  return (env.ALLOWED_USERS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

const COOKIE = 'gu_session';
const SESSION_DAYS = 7;

// Er zijn twee manieren van inloggen, met elk een eigen set routes (zie functions/api.js):
// - Microsoft, onder /api/ms/...: Static Web Apps dwingt daar inloggen af en zet de header x-ms-client-principal.
// - Lokaal account, onder /api/...: een sessiecookie. Daar negeren we x-ms-client-principal, want die route is openbaar
//   en de header kan dan door iedereen worden meegestuurd.

function parsePrincipal(headers) {
  const raw = headers.get('x-ms-client-principal');
  if (!raw) throw new HttpError(401, 'Niet ingelogd.');
  let principal;
  try {
    principal = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    throw new HttpError(401, 'Ongeldige inloggegevens.');
  }
  if (!principal || !principal.userId || !principal.userDetails) throw new HttpError(401, 'Ongeldige inloggegevens.');
  return { name: String(principal.userDetails), email: String(principal.userDetails).toLowerCase() };
}

// Elk Microsoft-account kan inloggen; alleen vaste en toegevoegde gebruikers mogen erbij.
async function authorizeMicrosoft(headers, repo, env = process.env) {
  const user = parsePrincipal(headers);
  const fixed = fixedUsers(env).includes(user.email);
  if (!fixed && !(await repo.getUsers()).includes(user.email)) throw new HttpError(403, 'Geen toegang.', { user: user.email });
  // admin = mag lokale accounts beheren. role/instanceId: nu één rol en één instantie, maar al wel vastgelegd.
  return { ...user, kind: 'microsoft', fixed, admin: fixed, role: 'beheerder', instanceId: 'main', mustChange: false };
}

function sessionToken(headers) {
  const cookie = headers.get('cookie') || '';
  for (const part of cookie.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

// Sessie via cookie. Wijzigende verzoeken moeten ook de header x-requested-with meesturen (naast SameSite=Strict op het cookie).
async function authorizeSession(headers, method, repo, now = new Date()) {
  const token = sessionToken(headers);
  if (!token) throw new HttpError(401, 'Niet ingelogd.');
  if (!['GET', 'HEAD'].includes(method) && !headers.get('x-requested-with')) throw new HttpError(403, 'Ongeldig verzoek.');
  const hash = hashToken(token);
  const session = await repo.getSession(hash);
  if (!session) throw new HttpError(401, 'Niet ingelogd.');
  if (session.expiresAt <= now.toISOString()) {
    await repo.deleteSession(hash);
    throw new HttpError(401, 'De sessie is verlopen.');
  }
  const account = await repo.getAccount(session.email);
  if (!account) throw new HttpError(401, 'Niet ingelogd.');
  return {
    kind: 'local', email: account.rowKey, name: account.name || account.rowKey, fixed: false, admin: false,
    role: account.role, instanceId: account.instanceId, mustChange: !!account.mustChange, sessionHash: hash,
  };
}

const sessionCookie = (token, now = new Date()) => ({
  name: COOKIE, value: token, httpOnly: true, secure: true, sameSite: 'Strict', path: '/', maxAge: SESSION_DAYS * 24 * 3600,
});
const expiredCookie = () => ({ name: COOKIE, value: '', httpOnly: true, secure: true, sameSite: 'Strict', path: '/', maxAge: 0 });

module.exports = { authorizeMicrosoft, authorizeSession, sessionToken, sessionCookie, expiredCookie, fixedUsers, SESSION_DAYS, COOKIE };
