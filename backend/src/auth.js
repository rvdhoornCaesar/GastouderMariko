const { HttpError } = require('./errors');
const { hashToken } = require('./passwords');

// E-mailadressen uit de app-setting ALLOWED_USERS: de vaste gebruikers (beheerders).
// Zij kunnen nooit buitengesloten worden; extra gebruikers worden in de app beheerd (zie repo.getUsers).
// Onzichtbare tekens (spatie met nulbreedte, harde spatie, BOM) komen mee bij plakken uit mail of Teams; trim() haalt ze deels niet weg.
const clean = (v) => String(v).replace(/[\u200B-\u200D\u2060\uFEFF\u00A0]/g, '').trim().toLowerCase();

function fixedUsers(env = process.env) {
  return (env.ALLOWED_USERS || '').split(',').map((s) => clean(s)).filter(Boolean);
}

const COOKIE = 'gu_session';
const SESSION_DAYS = 7;

// Er zijn twee manieren van inloggen, met elk een eigen set routes (zie functions/api.js):
// - Microsoft, onder /api/ms/...: Static Web Apps dwingt daar inloggen af en zet de header x-ms-client-principal.
// - Lokaal account, onder /api/...: een sessiecookie. Daar negeren we x-ms-client-principal, want die route is openbaar
//   en de header kan dan door iedereen worden meegestuurd.

// Claim-types waarin een e-mailadres kan staan. Alleen deze worden gebruikt (de header zet Static Web Apps zelf op /api/ms/*).
const EMAIL_CLAIMS = ['email', 'emails', 'preferred_username', 'upn', 'unique_name',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn'];
const isMasked = (v) => String(v).includes('*');

// Het adres staat normaal in userDetails. Soms komt daar een afgeschermde versie binnen (bijvoorbeeld 'dot*****'); dan gebruiken we
// een volledig e-mailadres uit de claims. 'diag' beschrijft alleen de vorm van de gegevens (geen adressen) voor de 403-log.
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
  const claims = Array.isArray(principal.claims) ? principal.claims.filter((c) => c && typeof c.typ === 'string' && typeof c.val === 'string') : [];
  const details = String(principal.userDetails);
  let chosen = details;
  if (isMasked(details)) {
    const alt = claims.filter((c) => EMAIL_CLAIMS.includes(c.typ)).map((c) => c.val).find((v) => v.includes('@') && !isMasked(v));
    if (alt) chosen = alt;
  }
  const diag = { provider: principal.identityProvider || null, detailsMasked: isMasked(details), usedClaim: chosen !== details,
    claimTypes: claims.map((c) => c.typ).slice(0, 20), emailClaimsMasked: claims.filter((c) => EMAIL_CLAIMS.includes(c.typ)).map((c) => isMasked(c.val)) };
  return { name: chosen, email: chosen.toLowerCase(), userId: String(principal.userId), masked: isMasked(chosen), diag };
}

// Het platform geeft soms een afgeschermd adres door ('dot*****') zonder claims. Het userId van Static Web Apps blijft wel gelijk. Na
// een geslaagde login met een volledig adres onthouden we daarom userId -> adres; komt het adres afgeschermd binnen, dan zoeken we het
// daar op. Daarna geldt gewoon de controle op de lijsten, dus wie uit de lijst gaat, kan er ook zo niet meer in.
const knownIdentities = new Map();   // per instantie, om niet bij elk verzoek de opslag te raadplegen
const identityKey = (userId) => hashToken(userId);

async function resolveMasked(user, repo) {
  const key = identityKey(user.userId);
  let email = knownIdentities.get(key);
  if (!email && repo.getIdentity) email = await repo.getIdentity(key);
  if (!email) return user;
  knownIdentities.set(key, email);
  return { ...user, email, name: email, masked: false, diag: { ...user.diag, usedStored: true } };
}
async function rememberIdentity(user, repo) {
  const key = identityKey(user.userId);
  if (user.masked || knownIdentities.get(key) === user.email) return;
  knownIdentities.set(key, user.email);
  if (repo.setIdentity) await repo.setIdentity(key, user.email);
}

// Elk Microsoft-account kan inloggen; alleen vaste en toegevoegde gebruikers mogen erbij.
async function authorizeMicrosoft(headers, repo, env = process.env) {
  let user = parsePrincipal(headers);
  if (user.masked) user = await resolveMasked(user, repo);
  const fixed = fixedUsers(env).includes(user.email);
  if (!fixed && !(await repo.getUsers()).includes(user.email)) throw new HttpError(403, 'Geen toegang.', { user: user.email, diag: user.diag });
  await rememberIdentity(user, repo);
  // instanceId: nu één instantie, maar al wel vastgelegd.
  // Vaste gebruikers (ALLOWED_USERS) zijn admin; in de app toegevoegde Microsoft-gebruikers zijn beheerder.
  const { diag, userId, masked, ...rest } = user;
  return { ...rest, kind: 'microsoft', fixed, role: fixed ? 'admin' : 'beheerder', instanceId: 'main', mustChange: false };
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
    kind: 'local', email: account.rowKey, name: account.name || account.rowKey, fixed: false,
    role: account.role, instanceId: account.instanceId, mustChange: !!account.mustChange, totp: !!account.totpSecret, sessionHash: hash,
  };
}

const sessionCookie = (token, now = new Date()) => ({
  name: COOKIE, value: token, httpOnly: true, secure: true, sameSite: 'Strict', path: '/', maxAge: SESSION_DAYS * 24 * 3600,
});
const expiredCookie = () => ({ name: COOKIE, value: '', httpOnly: true, secure: true, sameSite: 'Strict', path: '/', maxAge: 0 });

module.exports = { authorizeMicrosoft, authorizeSession, sessionToken, sessionCookie, expiredCookie, fixedUsers, SESSION_DAYS, COOKIE };
