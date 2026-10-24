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

function parseContracts(list, newId) {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > 50) throw bad('Ongeldige contracten.');
  const seen = new Set();
  return list.map((k) => {
    const name = text(k && k.name, 100);
    const rate = Number(k && k.rate);
    if (!name) throw bad('Een contract heeft een naam nodig.');
    if (!Number.isFinite(rate) || rate < 0 || rate > 1000) throw bad('Ongeldig uurtarief.');
    const id = k.id && ID.test(k.id) && !seen.has(k.id) ? k.id : newId();
    seen.add(id);
    return { id, name, rate: Math.round(rate * 100) / 100 };
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

module.exports = { parseChild, parseEntry, parseMonth, parseId, parseEntryId };
