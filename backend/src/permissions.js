const { HttpError } = require('./errors');

// Rollen en rechten. Dit is het enige punt waar bepaald wordt wat iemand mag; handlers vragen om een recht, niet om een rol.
// Een rol hoort bij een lidmaatschap van een organisatie (iemand kan in de ene organisatie beheerder zijn en in de andere gebruiker):
//   gebruiker: uren invullen en het overzicht zien (daarvoor moet je kinderen/contracten en tarieven kunnen lezen), niets wijzigen.
//   beheerder: alles wat er in de app is (kinderen, contracten, instellingen, toegestane gebruikers) en het beheren van lokale accounts
//              van de eigen organisatie (alleen met een rol tot en met beheerder, zie canManageRole).
// Platformbeheer (user.platformAdmin) staat los van een organisatie: het geeft het admin-tabblad, maar geen toegang tot de gegevens
// van een organisatie. Daarvoor moet je lid zijn van die organisatie.
const GEBRUIKER = ['entries:read', 'entries:write', 'children:read', 'settings:read'];
const BEHEERDER = [...GEBRUIKER, 'children:write', 'settings:write', 'accounts:manage'];
const PERMISSIONS = { gebruiker: GEBRUIKER, beheerder: BEHEERDER };
const PLATFORM = ['admin:view'];
const ROLES = Object.keys(PERMISSIONS);

const permissionsOf = (role) => PERMISSIONS[role] || [];   // onbekende rol: geen enkel recht
const permissionsFor = (user) => [...new Set([...(user ? permissionsOf(user.role) : []), ...(user && user.platformAdmin ? PLATFORM : [])])];
const can = (user, permission) => permissionsFor(user).includes(permission);
function require_(user, permission) {
  if (!can(user, permission)) throw new HttpError(403, 'Je hebt geen rechten voor deze actie.');
}

// Niemand deelt of beheert rechten boven zijn eigen rol: een beheerder kan geen hogere rol toekennen dan hij zelf heeft.
const level = (role) => ROLES.indexOf(role) + 1;   // onbekende rol: 0
const canManageRole = (user, role) => !!user && level(user.role) > 0 && level(role) > 0 && level(user.role) >= level(role);
const assignableRoles = (role) => ROLES.filter((r) => level(role) > 0 && level(r) <= level(role));

module.exports = { ROLES, permissionsOf, permissionsFor, can, canManageRole, assignableRoles, require: require_ };
