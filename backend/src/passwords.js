const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

// Wachtwoorden worden nooit bewaard, alleen een scrypt-hash met een eigen willekeurige salt.
// Parameters volgens OWASP (N=2^16, r=8, p=2, ~64 MiB); ze staan in de hash zelf, zodat ze later verhoogd kunnen worden.
const PARAMS = { N: 65536, r: 8, p: 2, keylen: 32 };
const MAXMEM = 256 * 1024 * 1024;
const norm = (pw) => String(pw).normalize('NFKC');

async function hashPassword(password, params = PARAMS) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(norm(password), salt, params.keylen, { N: params.N, r: params.r, p: params.p, maxmem: MAXMEM });
  return ['scrypt', params.N, params.r, params.p, salt.toString('base64'), key.toString('base64')].join('$');
}

async function verifyPassword(password, stored) {
  const [alg, N, r, p, saltB64, hashB64] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const key = await scrypt(norm(password), Buffer.from(saltB64, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: MAXMEM });
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

// Voor onbekende e-mailadressen vergelijken we toch met een hash, zodat de duur niet verraadt of een account bestaat.
let dummy;
const dummyHash = () => (dummy ||= hashPassword(crypto.randomBytes(12).toString('hex')));

const MIN_LENGTH = 12;
const MAX_LENGTH = 128;
const COMMON = ['wachtwoord', 'password', 'welkom', 'qwerty', 'gastouder', '123456', 'iloveyou', 'letmein', 'admin'];

// Lengte telt, geen samenstellingsregels. Geeft een foutmelding of null.
function validatePassword(password, { email = '' } = {}) {
  if (typeof password !== 'string') return 'Vul een wachtwoord in.';
  if (password.length < MIN_LENGTH) return `Kies een wachtwoord van minstens ${MIN_LENGTH} tekens.`;
  if (password.length > MAX_LENGTH) return `Een wachtwoord mag maximaal ${MAX_LENGTH} tekens zijn.`;
  const lower = password.toLowerCase();
  const local = String(email).toLowerCase().split('@')[0];
  if (lower === String(email).toLowerCase() || (local.length >= 4 && lower.includes(local))) return 'Het wachtwoord mag niet uit je e-mailadres bestaan.';
  if (new Set(lower).size < 5) return 'Dit wachtwoord is te eenvoudig.';
  if (COMMON.some((c) => lower.includes(c))) return 'Dit wachtwoord is te gemakkelijk te raden.';
  return null;
}

// Tijdelijk wachtwoord voor een nieuw of gereset account, zonder verwarrende tekens (bijv. "k7mn-p3xq-w9ht").
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
function generateTempPassword() {
  const group = () => Array.from({ length: 4 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
  return `${group()}-${group()}-${group()}`;
}

// Sessiesleutels: willekeurig, en in de database staat alleen de SHA-256 ervan.
const newToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

module.exports = { hashPassword, verifyPassword, dummyHash, validatePassword, generateTempPassword, newToken, hashToken, MIN_LENGTH };
