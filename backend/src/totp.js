const crypto = require('node:crypto');

// Tweestapsverificatie (TOTP, RFC 6238): 6 cijfers, 30 seconden, SHA-1 (wat authenticator-apps verwachten).
const STEP = 30;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function fromBase32(str) {
  let bits = 0, value = 0;
  const out = [];
  for (const c of str.replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(c);
    if (i < 0) throw new Error('Ongeldige base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

const newSecret = () => base32(crypto.randomBytes(20));

function code(secret, counter, digits = 6) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', fromBase32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** digits).padStart(digits, '0');
}

// Geeft de tijdstap terug waarmee de code klopt (één stap marge naar beide kanten voor klokverschil), of null.
// Een stap die al gebruikt is (lastStep) wordt geweigerd, zodat een afgekeken code niet nog een keer werkt.
function verify(secret, input, now = new Date(), lastStep = 0) {
  const c = String(input ?? '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const step = Math.floor(now.getTime() / 1000 / STEP);
  for (const s of [step, step - 1, step + 1]) {
    if (s <= Number(lastStep)) continue;
    const a = Buffer.from(code(secret, s)), b = Buffer.from(c);
    if (crypto.timingSafeEqual(a, b)) return s;
  }
  return null;
}

const otpauthUri = (secret, email) => {
  const issuer = 'Gastouder Uren';
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP}`;
};

// Het geheim moet terug te lezen zijn (anders kunnen we geen codes controleren), dus het staat versleuteld in de opslag.
// Sleutel: de app-setting TOTP_KEY; zonder die setting leiden we een sleutel af van de opslagverbinding (TABLES_CONNECTION).
function key(env = process.env) {
  const ikm = env.TOTP_KEY || env.TABLES_CONNECTION || env.AzureWebJobsStorage;
  if (!ikm) throw new Error('Geen sleutel beschikbaar voor tweestapsverificatie.');
  return Buffer.from(crypto.hkdfSync('sha256', ikm, 'gastouder-uren', 'totp-secret-v1', 32));
}
function encrypt(plain, env) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(env), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join('$');
}
function decrypt(stored, env) {
  const [v, iv, tag, ct] = String(stored).split('$');
  if (v !== 'v1') throw new Error('Onbekend formaat');
  const d = crypto.createDecipheriv('aes-256-gcm', key(env), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

// Herstelcodes voor als de telefoon kwijt is: eenmalig bruikbaar, alleen de hash wordt bewaard.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const randomChars = (n) => Array.from(crypto.randomBytes(n), (b) => ALPHABET[b % ALPHABET.length]).join('');
const newRecoveryCode = () => `${randomChars(5)}-${randomChars(5)}`;
const normalizeRecovery = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const hashRecovery = (s) => crypto.createHash('sha256').update(`recovery:${normalizeRecovery(s)}`).digest('hex');

// Ticket tussen 'wachtwoord goed' en 'code ingevoerd': ondertekend, 5 minuten geldig, bevat alleen het e-mailadres.
const TICKET_MINUTES = 5;
function makeTicket(email, now = new Date(), env) {
  const body = Buffer.from(JSON.stringify({ e: email, x: now.getTime() + TICKET_MINUTES * 60000 })).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', key(env)).update(`ticket:${body}`).digest('base64url')}`;
}
function readTicket(ticket, now = new Date(), env) {
  const [body, sig] = String(ticket ?? '').split('.');
  if (!body || !sig) return null;
  const want = crypto.createHmac('sha256', key(env)).update(`ticket:${body}`).digest('base64url');
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try {
    const t = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return t.x > now.getTime() ? String(t.e) : null;
  } catch { return null; }
}

module.exports = { newSecret, code, verify, otpauthUri, encrypt, decrypt, newRecoveryCode, hashRecovery, normalizeRecovery, makeTicket, readTicket, base32, fromBase32, STEP };
