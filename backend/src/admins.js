// E-mailadressen uit de app-setting ALLOWED_USERS: de vaste gebruikers (beheerders).
// Zij kunnen nooit buitengesloten worden; extra gebruikers worden in de app beheerd (zie repo.getUsers).
// Onzichtbare tekens (spatie met nulbreedte, harde spatie, BOM) komen mee bij plakken uit mail of Teams; trim() haalt ze deels niet weg.
const clean = (v) => String(v).replace(/[\u200B-\u200D\u2060\uFEFF\u00A0]/g, '').trim().toLowerCase();

// Vaste beheerders die in de code staan, naast ALLOWED_USERS. Zo blijven ze admin, ook als de omgevingsvariabele wordt overschreven.
// Wijzigen kan alleen met een codewijziging en een deploy.
const CODE_ADMINS = ['r.hoorn@caesar.nl'];

function fixedUsers(env = process.env) {
  const fromEnv = (env.ALLOWED_USERS || '').split(',').map((s) => clean(s)).filter(Boolean);
  return [...new Set([...CODE_ADMINS, ...fromEnv])];
}

module.exports = { clean, CODE_ADMINS, fixedUsers };
