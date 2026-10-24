const { HttpError } = require('./errors');

// Static Web Apps stuurt de ingelogde gebruiker mee in de header x-ms-client-principal.
function getUser(headers, env = process.env) {
  const raw = headers.get('x-ms-client-principal');
  if (!raw) throw new HttpError(401, 'Niet ingelogd.');

  let principal;
  try {
    principal = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    throw new HttpError(401, 'Ongeldige inloggegevens.');
  }
  if (!principal || !principal.userId || !principal.userDetails) throw new HttpError(401, 'Ongeldige inloggegevens.');

  // Elk Microsoft-account kan inloggen; alleen de genoemde gebruikers mogen erbij. Leeg = niemand.
  const allowed = (env.ALLOWED_USERS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!allowed.includes(String(principal.userDetails).toLowerCase())) throw new HttpError(403, 'Geen toegang.');

  return { id: String(principal.userId).replace(/[^A-Za-z0-9_-]/g, '_'), name: principal.userDetails };
}

module.exports = { getUser };
