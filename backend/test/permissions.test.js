const test = require('node:test');
const assert = require('node:assert/strict');
const { can, permissionsOf, canManageRole, assignableRoles, ROLES } = require('../src/permissions');

test('rollen en rechten', () => {
  assert.deepEqual(ROLES, ['gebruiker', 'beheerder', 'admin']);
  const g = { role: 'gebruiker' }, b = { role: 'beheerder' }, a = { role: 'admin' };
  for (const p of ['entries:read', 'entries:write', 'children:read', 'settings:read']) assert.ok(can(g, p), p);
  for (const p of ['children:write', 'settings:write', 'accounts:manage', 'admin:view']) assert.ok(!can(g, p), p);
  assert.ok(can(b, 'children:write') && can(b, 'settings:write') && can(b, 'accounts:manage'));
  assert.ok(!can(b, 'admin:view'));
  assert.ok(can(a, 'accounts:manage') && can(a, 'admin:view') && can(a, 'children:write'));
});

test('onbekende rol of geen gebruiker: geen rechten', () => {
  assert.deepEqual(permissionsOf('hacker'), []);
  assert.ok(!can({ role: 'hacker' }, 'entries:read'));
  assert.ok(!can(null, 'entries:read'));
  assert.ok(!can({}, 'entries:read'));
});

test('niemand beheert een rol boven zijn eigen rol', () => {
  assert.deepEqual(assignableRoles('gebruiker'), ['gebruiker']);
  assert.deepEqual(assignableRoles('beheerder'), ['gebruiker', 'beheerder']);
  assert.deepEqual(assignableRoles('admin'), ['gebruiker', 'beheerder', 'admin']);
  assert.deepEqual(assignableRoles('hacker'), []);
  assert.ok(canManageRole({ role: 'beheerder' }, 'beheerder'));
  assert.ok(!canManageRole({ role: 'beheerder' }, 'admin'));
  assert.ok(canManageRole({ role: 'admin' }, 'admin'));
  assert.ok(!canManageRole({ role: 'hacker' }, 'gebruiker'));
  assert.ok(!canManageRole({ role: 'beheerder' }, 'god'));
});
