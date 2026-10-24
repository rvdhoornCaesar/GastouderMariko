const { HttpError } = require('./errors');

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const ENTRY_ID = /^\d{4}-\d{2}-\d{2}_[a-z0-9]{6,20}$/;
const ID = /^[a-z0-9]{6,20}$/;

const bad = (msg) => new HttpError(400, msg);
const text = (v, max) => (typeof v === 'string' ? v.trim() : '').slice(0, max);

function toMin(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function validDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T12:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function parseRate(v) {
  const rate = Number(v);
  if (!Number.isFinite(rate) || rate < 0 || rate > 1000) throw bad('Ongeldig uurtarief.');
  return Math.round(rate * 100) / 100;
}

function parseContracts(list, newId) {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > 50) throw bad('Ongeldige contracten.');
  const seen = new Set();
  return list.map((k) => {
    const name = text(k && k.name, 100);
    if (!name) throw bad('Een contract heeft een naam nodig.');
    // Leeg tarief = het algemene tarief (uit de instellingen) geldt.
    const rate = k.rate === null || k.rate === undefined || k.rate === '' ? null : parseRate(k.rate);
    const id = k.id && ID.test(k.id) && !seen.has(k.id) ? k.id : newId();
    seen.add(id);
    return { id, name, rate };
  });
}

function parseChild(body, newId) {
  const name = text(body && body.name, 100);
  if (!name) throw bad('Een kind heeft een naam nodig.');
  return { name, contracts: parseContracts(body.contracts, newId) };
}

function parseEntry(body) {
  const b = body || {};
  const e = { date: b.date, contractId: b.contractId, start: b.start, end: b.end, note: text(b.note, 200) };
  if (!validDate(e.date)) throw bad('Ongeldige datum.');
  if (typeof e.contractId !== 'string' || !ID.test(e.contractId)) throw bad('Ongeldig contract.');
  if (!TIME.test(e.start || '') || !TIME.test(e.end || '')) throw bad('Ongeldige tijd.');
  if (toMin(e.end) <= toMin(e.start)) throw bad('Eindtijd moet na de begintijd liggen.');
  return e;
}

function parseMonth(m) {
  if (!MONTH.test(m || '')) throw bad('Geef een maand op als JJJJ-MM.');
  return m;
}

function parseId(id) {
  if (!ID.test(id || '')) throw new HttpError(404, 'Niet gevonden.');
  return id;
}

function parseEntryId(id) {
  if (!ENTRY_ID.test(id || '')) throw new HttpError(404, 'Niet gevonden.');
  return id;
}

// Algemene tarieven: lijst van { from, to (optioneel), rate }, zonder overlappende periodes.
function parseRates(list, newId) {
  if (!Array.isArray(list) || list.length > 100) throw bad('Ongeldige tarieven.');
  const rates = list.map((r) => {
    if (!validDate(r && r.from)) throw bad('Ongeldige begindatum.');
    const to = r.to === null || r.to === undefined || r.to === '' ? null : r.to;
    if (to !== null && !validDate(to)) throw bad('Ongeldige einddatum.');
    if (to !== null && to < r.from) throw bad('De einddatum ligt voor de begindatum.');
    return { id: r.id && ID.test(r.id) ? r.id : newId(), from: r.from, to, rate: parseRate(r.rate) };
  }).sort((a, b) => a.from.localeCompare(b.from));
  for (let i = 1; i < rates.length; i++) {
    const prev = rates[i - 1];
    if (prev.to === null || prev.to >= rates[i].from) throw bad(`De periodes vanaf ${prev.from} en ${rates[i].from} overlappen.`);
  }
  return rates;
}

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

function parseUsers(list) {
  if (!Array.isArray(list) || list.length > 50) throw bad('Ongeldige gebruikerslijst.');
  const emails = list.map((e) => String(e).trim().toLowerCase());
  const invalid = emails.find((e) => !EMAIL.test(e));
  if (invalid !== undefined) throw bad(`Ongeldig e-mailadres: ${invalid}`);
  return [...new Set(emails)];
}

module.exports = { parseRates, parseUsers, parseChild, parseEntry, parseMonth, parseId, parseEntryId };
