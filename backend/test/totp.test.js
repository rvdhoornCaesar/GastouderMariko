const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/totp');

const env = { TOTP_KEY: 'test-sleutel' };
const RFC = T.base32(Buffer.from('12345678901234567890'));

test('TOTP volgens RFC 6238 (testvectoren)', () => {
  assert.equal(T.code(RFC, Math.floor(59 / 30), 8), '94287082');
  assert.equal(T.code(RFC, Math.floor(1111111109 / 30), 8), '07081804');
  assert.equal(T.code(RFC, Math.floor(20000000000 / 30), 8), '65353130');
});

test('verify: marge van één stap, geen hergebruik, geen onzin', () => {
  const now = new Date(1111111109 * 1000);
  const step = Math.floor(now.getTime() / 30000);
  assert.equal(T.verify(RFC, T.code(RFC, step), now), step);
  assert.equal(T.verify(RFC, T.code(RFC, step - 1), now), step - 1);
  assert.equal(T.verify(RFC, T.code(RFC, step - 2), now), null);
  assert.equal(T.verify(RFC, T.code(RFC, step), now, step), null);
  assert.equal(T.verify(RFC, 'abcdef', now), null);
  assert.equal(T.verify(RFC, '', now), null);
});

test('base32 rondreis en geheim', () => {
  const s = T.newSecret();
  assert.match(s, /^[A-Z2-7]{32}$/);
  assert.equal(T.base32(T.fromBase32(s)), s);
});

test('versleutelen: rondreis, geen leesbaar geheim, andere sleutel lukt niet', () => {
  const s = T.newSecret();
  const enc = T.encrypt(s, env);
  assert.ok(!enc.includes(s));
  assert.equal(T.decrypt(enc, env), s);
  assert.notEqual(T.encrypt(s, env), enc);
  assert.throws(() => T.decrypt(enc, { TOTP_KEY: 'andere' }));
});

test('ticket: geldig, verlopen en vervalst', () => {
  const now = new Date();
  const t = T.makeTicket('a@b.nl', now, env);
  assert.equal(T.readTicket(t, now, env), 'a@b.nl');
  assert.equal(T.readTicket(t, new Date(now.getTime() + 6 * 60000), env), null);
  assert.equal(T.readTicket(t, now, { TOTP_KEY: 'andere' }), null);
  const [b, s] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ e: 'x@y.nl', x: now.getTime() + 1e6 })).toString('base64url');
  assert.equal(T.readTicket(`${forged}.${s}`, now, env), null);
  assert.equal(T.readTicket('troep', now, env), null);
});

test('herstelcodes: formaat en hash is onafhankelijk van streepje en hoofdletters', () => {
  const c = T.newRecoveryCode();
  assert.match(c, /^[a-z2-9]{5}-[a-z2-9]{5}$/);
  assert.equal(T.hashRecovery(c), T.hashRecovery(c.toUpperCase().replace('-', ' ')));
  assert.notEqual(T.newRecoveryCode(), c);
});
