const { HttpError } = require('./errors');

// E-mailadressen uit de app-setting ALLOWED_USERS: de vaste gebruikers (beheerders).
// Zij kunnen nooit buitengesloten worden; extra gebruikers worden in de app beheerd (zie repo.getUsers).
function fixedUsers(env = process.env) {
  return (env.ALLOWED_USERS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

// Static Web Apps stuurt de ingelogde gebruiker mee in de header x-ms-client-principal.
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
async function authorize(headers, repo, env = process.env) {
  const user = parsePrincipal(headers);
  const fixed = fixedUsers(env).includes(user.email);
  if (!fixed && !(await repo.getUsers()).includes(user.email)) throw new HttpError(403, 'Geen toegang.', { user: user.email });
  return { ...user, fixed };
}

module.exports = { authorize, fixedUsers };
