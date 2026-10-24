const { HttpError } = require('./errors');

// Rollen en rechten. Dit is het enige punt waar bepaald wordt wat een rol mag; handlers vragen om een recht, niet om een rol.
//   gebruiker: uren invullen en het overzicht zien (daarvoor moet je kinderen/contracten en tarieven kunnen lezen), niets wijzigen.
//   beheerder: alles wat er in de app is (kinderen, contracten, instellingen, toegestane gebruikers) en het beheren van lokale accounts
//              (alleen accounts met een rol tot en met beheerder, zie canManageRole).
//   admin:     alles van de beheerder, plus het admin-tabblad en het beheren van accounts met elke rol.
const GEBRUIKER = ['entries:read', 'entries:write', 'children:read', 'settings:read'];
const BEHEERDER = [...GEBRUIKER, 'children:write', 'settings:write', 'accounts:manage'];
const ADMIN = [...BEHEERDER, 'admin:view'];
const PERMISSIONS = { gebruiker: GEBRUIKER, beheerder: BEHEERDER, admin: ADMIN };
const ROLES = Object.keys(PERMISSIONS);

const permissionsOf = (role) => PERMISSIONS[role] || [];   // onbekende rol: geen enkel recht
const can = (user, permission) => !!user && permissionsOf(user.role).includes(permission);
function require_(user, permission) {
  if (!can(user, permission)) throw new HttpError(403, 'Je hebt geen rechten voor deze actie.');
}

// Niemand deelt of beheert rechten boven zijn eigen rol: een beheerder maakt geen admins en past geen admin-account aan.
const level = (role) => ROLES.indexOf(role) + 1;   // onbekende rol: 0
const canManageRole = (user, role) => !!user && level(user.role) > 0 && level(role) > 0 && level(user.role) >= level(role);
const assignableRoles = (role) => ROLES.filter((r) => level(role) > 0 && level(r) <= level(role));

module.exports = { ROLES, permissionsOf, can, canManageRole, assignableRoles, require: require_ };
