const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../src/passwords');

test('hash: scrypt-formaat, unieke salt, bevat het wachtwoord niet', async () => {
  const a = await p.hashPassword('koekjes-tomaat-fiets-42');
  const b = await p.hashPassword('koekjes-tomaat-fiets-42');
  assert.notEqual(a, b);
  assert.match(a, /^scrypt\$65536\$8\$2\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.ok(!a.includes('koekjes-tomaat-fiets-42'));
});

test('verify: juist, onjuist, kapotte hash', async () => {
  const h = await p.hashPassword('koekjes-tomaat-fiets-42');
  assert.equal(await p.verifyPassword('koekjes-tomaat-fiets-42', h), true);
  assert.equal(await p.verifyPassword('koekjes-tomaat-fiets-43', h), false);
  assert.equal(await p.verifyPassword('', h), false);
  for (const bad of [undefined, '', 'plain', 'scrypt$1$2', 'bcrypt$1$2$3$4$5']) assert.equal(await p.verifyPassword('x', bad), false);
});

test('verify: Unicode-normalisatie (é als één of twee tekens)', async () => {
  const h = await p.hashPassword('café-café-café');
  assert.equal(await p.verifyPassword('café-café-café', h), true);
});

test('wachtwoordregels', () => {
  const v = (pw, email) => p.validatePassword(pw, { email });
  assert.equal(v('koekjes-tomaat-fiets-42', 'a@b.nl'), null);
  assert.match(v('kort', 'a@b.nl'), /minstens 12/);
  assert.match(v('x'.repeat(129), 'a@b.nl'), /maximaal 128/);
  assert.match(v('mariko@voorbeeld.nl', 'mariko@voorbeeld.nl'), /e-mailadres/);
  assert.match(v('xxmarikoxx-12345', 'mariko@voorbeeld.nl'), /e-mailadres/);
  assert.match(v('aaaaaaaaaaaaaaaa', 'a@b.nl'), /eenvoudig/);
  assert.match(v('Wachtwoord12345!', 'a@b.nl'), /raden/);
  assert.match(v(undefined, 'a@b.nl'), /Vul een wachtwoord/);
});

test('tijdelijk wachtwoord: formaat, voldoende lang, verschillend', () => {
  const set = new Set();
  for (let i = 0; i < 50; i++) {
    const t = p.generateTempPassword();
    assert.match(t, /^[a-hj-km-np-z2-9]{4}-[a-hj-km-np-z2-9]{4}-[a-hj-km-np-z2-9]{4}$/);
    assert.ok(t.length >= p.MIN_LENGTH);
    set.add(t);
  }
  assert.equal(set.size, 50);
});

test('sessiesleutel: lang, uniek, hash is sha-256 hex en niet gelijk aan de sleutel', () => {
  const a = p.newToken(), b = p.newToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 43);
  const h = p.hashToken(a);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.notEqual(h, a);
  assert.equal(h, p.hashToken(a));
});
