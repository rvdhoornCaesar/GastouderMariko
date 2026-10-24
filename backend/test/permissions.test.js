const test = require('node:test');
const assert = require('node:assert/strict');
const { can, permissionsOf, ROLES } = require('../src/permissions');

test('rollen en rechten', () => {
  assert.deepEqual(ROLES, ['gebruiker', 'beheerder', 'admin']);
  const g = { role: 'gebruiker' }, b = { role: 'beheerder' }, a = { role: 'admin' };
  for (const p of ['entries:read', 'entries:write', 'children:read', 'settings:read']) assert.ok(can(g, p), p);
  for (const p of ['children:write', 'settings:write', 'accounts:manage', 'admin:view']) assert.ok(!can(g, p), p);
  assert.ok(can(b, 'children:write') && can(b, 'settings:write'));
  assert.ok(!can(b, 'accounts:manage') && !can(b, 'admin:view'));
  assert.ok(can(a, 'accounts:manage') && can(a, 'admin:view') && can(a, 'children:write'));
});

test('onbekende rol of geen gebruiker: geen rechten', () => {
  assert.deepEqual(permissionsOf('hacker'), []);
  assert.ok(!can({ role: 'hacker' }, 'entries:read'));
  assert.ok(!can(null, 'entries:read'));
  assert.ok(!can({}, 'entries:read'));
});
