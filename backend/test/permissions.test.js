const test = require('node:test');
const assert = require('node:assert/strict');
const { can, permissionsOf, permissionsFor, canManageRole, assignableRoles, ROLES } = require('../src/permissions');

test('rollen en rechten', () => {
  assert.deepEqual(ROLES, ['gebruiker', 'beheerder']);
  const g = { role: 'gebruiker' }, b = { role: 'beheerder' };
  for (const p of ['entries:read', 'entries:write', 'children:read', 'settings:read']) assert.ok(can(g, p), p);
  for (const p of ['children:write', 'settings:write', 'accounts:manage', 'admin:view']) assert.ok(!can(g, p), p);
  assert.ok(can(b, 'children:write') && can(b, 'settings:write') && can(b, 'accounts:manage'));
  assert.ok(!can(b, 'admin:view'));
});

test('platformbeheer geeft het admin-tabblad, maar geen toegang tot de gegevens van een organisatie', () => {
  const platform = { role: null, platformAdmin: true };
  assert.ok(can(platform, 'admin:view'));
  for (const p of ['entries:read', 'entries:write', 'children:read', 'children:write', 'settings:read', 'settings:write', 'accounts:manage']) assert.ok(!can(platform, p), p);
  // lid van een organisatie én platformbeheerder: de rechten van beide
  const both = { role: 'gebruiker', platformAdmin: true };
  assert.ok(can(both, 'admin:view') && can(both, 'entries:read') && !can(both, 'settings:write'));
  assert.deepEqual(permissionsFor({ role: 'gebruiker' }).includes('admin:view'), false);
});

test('onbekende rol of geen gebruiker: geen rechten', () => {
  assert.deepEqual(permissionsOf('hacker'), []);
  assert.deepEqual(permissionsOf('admin'), []);   // admin is geen rol meer binnen een organisatie
  assert.ok(!can({ role: 'hacker' }, 'entries:read'));
  assert.ok(!can(null, 'entries:read'));
  assert.ok(!can({}, 'entries:read'));
  assert.deepEqual(permissionsFor(null), []);
});

test('niemand beheert een rol boven zijn eigen rol', () => {
  assert.deepEqual(assignableRoles('gebruiker'), ['gebruiker']);
  assert.deepEqual(assignableRoles('beheerder'), ['gebruiker', 'beheerder']);
  assert.deepEqual(assignableRoles('hacker'), []);
  assert.deepEqual(assignableRoles(null), []);
  assert.ok(canManageRole({ role: 'beheerder' }, 'beheerder'));
  assert.ok(!canManageRole({ role: 'gebruiker' }, 'beheerder'));
  assert.ok(!canManageRole({ role: 'hacker' }, 'gebruiker'));
  assert.ok(!canManageRole({ role: 'beheerder' }, 'god'));
  assert.ok(!canManageRole({ role: 'beheerder' }, 'admin'));
});
