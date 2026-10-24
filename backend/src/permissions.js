const { HttpError } = require('./errors');

// Rollen en rechten. Dit is het enige punt waar bepaald wordt wat een rol mag; handlers vragen om een recht, niet om een rol.
//   gebruiker: uren invullen en het overzicht zien (daarvoor moet je kinderen/contracten en tarieven kunnen lezen), niets wijzigen.
//   beheerder: alles wat er in de app is (kinderen, contracten, instellingen, toegestane gebruikers).
//   admin:     alles van de beheerder, plus het admin-tabblad en het beheren van lokale accounts (alleen via Microsoft-login, zie functions/api.js).
const GEBRUIKER = ['entries:read', 'entries:write', 'children:read', 'settings:read'];
const BEHEERDER = [...GEBRUIKER, 'children:write', 'settings:write'];
const ADMIN = [...BEHEERDER, 'accounts:manage', 'admin:view'];
const PERMISSIONS = { gebruiker: GEBRUIKER, beheerder: BEHEERDER, admin: ADMIN };
const ROLES = Object.keys(PERMISSIONS);

const permissionsOf = (role) => PERMISSIONS[role] || [];   // onbekende rol: geen enkel recht
const can = (user, permission) => !!user && permissionsOf(user.role).includes(permission);
function require_(user, permission) {
  if (!can(user, permission)) throw new HttpError(403, 'Je hebt geen rechten voor deze actie.');
}

module.exports = { ROLES, permissionsOf, can, require: require_ };
