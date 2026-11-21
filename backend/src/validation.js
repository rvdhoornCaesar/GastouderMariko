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

function parseMonthlyHours(v) {
  if (v === null || v === undefined || v === '') return null;
  const h = Number(v);
  if (!Number.isFinite(h) || h < 0 || h > 744) throw bad('Ongeldige vaste uren per maand.');
  return h === 0 ? null : Math.round(h * 100) / 100;
}

// Vaste tijden per weekdag (maandag = eerste): { open, from, to }. Alles gesloten telt als "geen vaste tijden".
function parseDays(days, what) {
  if (!Array.isArray(days) || days.length !== 7) throw bad(`Ongeldige ${what}.`);
  return days.map((d) => {
    if (!d || !d.open) return { open: false, from: null, to: null };
    if (!TIME.test(d.from || '') || !TIME.test(d.to || '')) throw bad(`Ongeldige tijd bij de ${what}.`);
    if (toMin(d.to) <= toMin(d.from)) throw bad(`De eindtijd moet na de begintijd liggen bij de ${what}.`);
    return { open: true, from: d.from, to: d.to };
  });
}

function parseSchedule(v) {
  if (v === null || v === undefined) return null;
  const days = parseDays(v, 'vaste tijden');
  return days.some((d) => d.open) ? days : null;
}

function requiredDate(v, msg) {
  if (!validDate(v)) throw bad(msg);
  return v;
}

function parseContracts(list, newId) {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > 50) throw bad('Ongeldige contracten.');
  const seen = new Set();
  return list.map((k, i) => {
    const who = `Contract ${i + 1}`;
    const number = text(k && k.number, 50);   // optioneel
    // Leeg tarief = het algemene tarief (uit de instellingen) geldt.
    const rate = k.rate === null || k.rate === undefined || k.rate === '' ? null : parseRate(k.rate);
    const monthlyHours = parseMonthlyHours(k.monthlyHours);
    const start = requiredDate(k.start, `${who}: vul een geldige startdatum in.`);
    const end = requiredDate(k.end, `${who}: vul een geldige t/m datum in.`);
    if (end < start) throw bad(`${who}: de t/m datum ligt voor de startdatum.`);
    const id = k.id && ID.test(k.id) && !seen.has(k.id) ? k.id : newId();
    seen.add(id);
    // Optioneel (standaard uit): worden vakanties van het kind doorbetaald?
    // Optioneel: het gastouderbureau van dit contract (id uit de lijst van platformbeheer; of dat bureau bij deze gastouder past, controleert de handler).
    const agencyId = typeof k.agencyId === 'string' && ID.test(k.agencyId) ? k.agencyId : null;
    // Soort opvang van het contract: gastouder (standaard) of bso. Een kind heeft per periode één soort: wisselt het, dan komt er een nieuw contract.
    const type = CARE_TYPES.includes(k.type) ? k.type : 'gastouder';
    return { id, number, rate, monthlyHours, start, end, schedule: parseSchedule(k.schedule), paidHolidays: k.paidHolidays === true, agencyId, type };
  });
}

// Vakanties van een kind: lijst van { from, to (t/m) }, gesorteerd op begindatum.
function parseHolidays(list, newId) {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > 200) throw bad('Ongeldige vakanties.');
  return list.map((h) => {
    const from = requiredDate(h && h.from, 'Vakantie: ongeldige begindatum.');
    const to = requiredDate(h.to, 'Vakantie: ongeldige t/m datum.');
    if (to < from) throw bad('Vakantie: de t/m datum ligt voor de begindatum.');
    return { id: h.id && ID.test(h.id) ? h.id : newId(), from, to };
  }).sort((a, b) => a.from.localeCompare(b.from));
}

// Foto van een kind: een klein JPEG-plaatje als data-URL (de browser verkleint het eerst). Een tabelrij kan maximaal 64 KB per veld bevatten.
const PHOTO = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/;
const MAX_PHOTO = 30000;
function parsePhoto(v_) {
  if (v_ === undefined) return undefined;   // niet meegestuurd: de bestaande foto blijft
  if (v_ === null || v_ === '') return null;
  if (typeof v_ !== 'string' || v_.length > MAX_PHOTO || !PHOTO.test(v_)) throw bad('Ongeldige foto. Kies een afbeelding (JPEG, PNG of WebP); die wordt automatisch verkleind.');
  return v_;
}

function parseChild(body, newId) {
  const b = body || {};
  const firstName = text(b.firstName ?? b.name, 100);
  if (!firstName) throw bad('Een kind heeft een voornaam nodig.');
  const lastName = text(b.lastName, 100);
  let birthDate = null;
  if (b.birthDate !== null && b.birthDate !== undefined && b.birthDate !== '') {
    birthDate = requiredDate(b.birthDate, 'Ongeldige geboortedatum.');
    if (birthDate > new Date().toISOString().slice(0, 10)) throw bad('De geboortedatum ligt in de toekomst.');
  }
  const parents = [0, 1].map((i) => text(Array.isArray(b.parents) ? b.parents[i] : '', 100));
  return {
    firstName, lastName, name: [firstName, lastName].filter(Boolean).join(' '), birthDate, parents, photo: parsePhoto(b.photo),
    contracts: parseContracts(b.contracts, newId), holidays: parseHolidays(b.holidays, newId),
  };
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
    return { id: r.id && ID.test(r.id) ? r.id : newId(), type: CARE_TYPES.includes(r.type) ? r.type : 'gastouder', from: r.from, to, rate: parseRate(r.rate) };
  }).sort((a, b) => a.from.localeCompare(b.from));
  noOverlap(rates, (r) => r.type);   // per soort opvang mogen de periodes niet overlappen
  return rates;
}

// Periodes (gesorteerd op begindatum) mogen per groep niet overlappen.
function noOverlap(rates, groupOf) {
  const last = new Map();
  for (const r of rates) {
    const g = groupOf(r), prev = last.get(g);
    if (prev && (prev.to === null || prev.to >= r.from)) throw bad(`De periodes vanaf ${prev.from} en ${r.from} overlappen.`);
    last.set(g, r);
  }
}

// Tarieven per gastouderbureau en soort opvang, met periodes zoals het algemene tarief.
function parseAgencyRates(list, newId) {
  if (!Array.isArray(list) || list.length > 200) throw bad('Ongeldige tarieven.');
  const rates = list.map((r) => {
    if (!r || typeof r.agencyId !== 'string' || !ID.test(r.agencyId)) throw bad('Ongeldig gastouderbureau.');
    if (!CARE_TYPES.includes(r.type)) throw bad('Ongeldige soort opvang.');
    if (!validDate(r.from)) throw bad('Ongeldige begindatum.');
    const to = r.to === null || r.to === undefined || r.to === '' ? null : r.to;
    if (to !== null && !validDate(to)) throw bad('Ongeldige einddatum.');
    if (to !== null && to < r.from) throw bad('De einddatum ligt voor de begindatum.');
    return { id: r.id && ID.test(r.id) ? r.id : newId(), agencyId: r.agencyId, type: r.type, from: r.from, to, rate: parseRate(r.rate) };
  }).sort((a, b) => a.from.localeCompare(b.from));
  noOverlap(rates, (r) => `${r.agencyId}|${r.type}`);
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

// Openingstijden per weekdag (maandag = eerste) en de toeslagfactor voor uren daarbuiten (2 = dubbel tarief).
const DEFAULT_OPENING = {
  days: [0, 1, 2, 3, 4].map(() => ({ open: true, from: '07:00', to: '18:00' })).concat([5, 6].map(() => ({ open: false, from: null, to: null }))),
  factor: 1,
};

function parseOpening(b) {
  if (!b) throw bad('Ongeldige openingstijden.');
  const days = parseDays(b.days, 'openingstijden');
  const factor = Number(b.factor);
  if (!Number.isFinite(factor) || factor < 0 || factor > 10) throw bad('Ongeldige toeslagfactor (0 tot 10).');
  return { days, factor: Math.round(factor * 100) / 100 };
}

// Eigen kinderen van de gastouder (voornaam en geboortedatum); ze tellen mee voor het maximum aantal kinderen.
// Vakantie van de gastouder zelf: periodes (van, t/m) waarin er geen opvang is, met een optionele omschrijving.
function parseVacations(list, newId) {
  if (!Array.isArray(list) || list.length > 100) throw bad('Ongeldige lijst met vakanties.');
  return list.map((h) => {
    const from = requiredDate(h && h.from, 'Vakantie: ongeldige begindatum.');
    const to = requiredDate(h.to, 'Vakantie: ongeldige t/m datum.');
    if (to < from) throw bad('Vakantie: de t/m datum ligt voor de begindatum.');
    return { id: h.id && ID.test(h.id) ? h.id : newId(), from, to, note: text(h.note, 100) };
  }).sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}
// Begindatum van de gastouder: alles ervoor wordt genegeerd. Leeg of null = geen begindatum.
function parseStartDate(value) {
  if (value === undefined) throw bad('Geen begindatum opgegeven.');
  if (value === null || value === '') return null;
  return requiredDate(value, 'Ongeldige begindatum.');
}
// Een dag dat de gastouder ziek is (of niet meer): { date, sick }. 'sick' is standaard waar.
function parseSickDay(body) {
  const date = requiredDate(body && body.date, 'Ongeldige datum.');
  if (body && body.sick !== undefined && typeof body.sick !== 'boolean') throw bad('Ongeldige waarde voor ziek.');
  return { date, sick: !(body && body.sick === false) };
}
function parseOwnChildren(list, newId) {
  if (!Array.isArray(list) || list.length > 20) throw bad('Ongeldige lijst met eigen kinderen.');
  const today = new Date().toISOString().slice(0, 10);
  return list.map((c) => {
    const firstName = text(c && c.firstName, 100);
    if (!firstName) throw bad('Een eigen kind heeft een voornaam nodig.');
    const birthDate = requiredDate(c.birthDate, `${firstName}: vul een geldige geboortedatum in.`);
    if (birthDate > today) throw bad(`${firstName}: de geboortedatum ligt in de toekomst.`);
    return { id: c.id && ID.test(c.id) ? c.id : newId(), firstName, birthDate };
  }).sort((a, b) => a.birthDate.localeCompare(b.birthDate));
}

// Lokale accounts: het e-mailadres is de sleutel in Table Storage, dus geen tekens die daar niet mogen.
const ACCOUNT_EMAIL = /^[^\s@,;/\\#?'"%]+@[^\s@,;/\\#?'"%]+\.[^\s@,;/\\#?'"%]+$/;
function parseAccountEmail(v) {
  const e = String(v ?? '').trim().toLowerCase();
  if (e.length > 200 || !ACCOUNT_EMAIL.test(e)) throw bad('Ongeldig e-mailadres.');
  return e;
}

// Naam van een organisatie: gewone tekst, 1 tot 100 tekens.
function parseAgencyName(v) {
  const n = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (!n || n.length > 100 || /[\u0000-\u001f\u007f-\u009f<>]/.test(n)) throw bad('Geef een naam van 1 tot 100 tekens.');
  return n;
}

// Soorten opvang: gastouder en bso. Een bureau en een gastouder doen er één of beide van.
const CARE_TYPES = ['gastouder', 'bso'];
function parseTypes(list, what = 'soorten opvang') {
  if (!Array.isArray(list) || !list.length || list.some((t) => !CARE_TYPES.includes(t))) throw bad(`Kies minstens één van de ${what}: gastouder of bso.`);
  return CARE_TYPES.filter((t) => list.includes(t));
}

function parseAgencyIds(list) {
  if (!Array.isArray(list) || list.length > 100) throw bad('Ongeldige gastouderbureaus.');
  const out = [...new Set(list)];
  if (out.some((id) => typeof id !== 'string' || !ID.test(id))) throw bad('Ongeldige gastouderbureaus.');
  return out;
}

// Aansluitingen van de gastouder bij gastouderbureaus: lijst van { agencyId, from, to (t/m) }, datums optioneel (leeg = open).
function parseAgencyLinks(list) {
  if (!Array.isArray(list) || list.length > 60) throw bad('Ongeldige aansluitingen.');
  return list.map((l) => {
    if (!l || typeof l.agencyId !== 'string' || !ID.test(l.agencyId)) throw bad('Ongeldig gastouderbureau.');
    const date = (x, msg) => (x === null || x === undefined || x === '' ? null : requiredDate(x, msg));
    const from = date(l.from, 'Ongeldige begindatum van de aansluiting.'), to = date(l.to, 'Ongeldige einddatum van de aansluiting.');
    if (from && to && to < from) throw bad('De einddatum van een aansluiting ligt voor de begindatum.');
    return { agencyId: l.agencyId, from, to };
  });
}

// Status van de uren van een kind in een maand.
const MONTH_STATUSES = ['geen', 'ingediend', 'betaald'];
function parseMonthStatus(body) {
  const b = body || {};
  if (typeof b.childId !== 'string' || !ID.test(b.childId)) throw bad('Ongeldig kind.');
  if (!MONTH.test(b.month || '')) throw bad('Geef een maand op als JJJJ-MM.');
  if (!MONTH_STATUSES.includes(b.status)) throw bad('Ongeldige status: kies geen status, uren ingediend of betaald.');
  return { childId: b.childId, month: b.month, status: b.status };
}

// Nederlandse feestdagen die de gastouder als gesloten kan laten gelden. Standaard gesloten: de dagen waarop een kinderopvang meestal dicht is;
// Goede Vrijdag en Bevrijdingsdag (alleen in lustrumjaren een vrije dag) staan standaard uit.
const HOLIDAY_KEYS = ['nieuwjaarsdag', 'goedevrijdag', 'eerstepaasdag', 'tweedepaasdag', 'koningsdag', 'bevrijdingsdag', 'hemelvaartsdag', 'eerstepinksterdag', 'tweedepinksterdag', 'eerstekerstdag', 'tweedekerstdag'];
const HOLIDAYS_DEFAULT = ['nieuwjaarsdag', 'eerstepaasdag', 'tweedepaasdag', 'koningsdag', 'hemelvaartsdag', 'eerstepinksterdag', 'tweedepinksterdag', 'eerstekerstdag', 'tweedekerstdag'];
function parseHolidaySettings(body) {
  const b = body || {};
  if (!Array.isArray(b.closed) || b.closed.some((k) => !HOLIDAY_KEYS.includes(k))) throw bad('Ongeldige feestdagen.');
  if (!Array.isArray(b.openDates) || b.openDates.length > 200 || b.openDates.some((d) => !validDate(d))) throw bad('Ongeldige datum bij de uitzonderingen.');
  return { closed: HOLIDAY_KEYS.filter((k) => b.closed.includes(k)), openDates: [...new Set(b.openDates)].sort() };
}

function parseOrgName(v) {
  const n = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (!n || n.length > 100 || /[\u0000-\u001f\u007f-\u009f<>]/.test(n)) throw bad('Geef een naam van 1 tot 100 tekens.');
  return n;
}

function parseRole(v) {
  const r = String(v ?? '').trim();
  if (!require('./permissions').ROLES.includes(r)) throw bad('Ongeldige rol.');
  return r;
}

module.exports = { parseSickDay, parseOrgName, parseAgencyName, parseMonthStatus, MONTH_STATUSES, parseHolidaySettings, HOLIDAY_KEYS, HOLIDAYS_DEFAULT, parseAgencyIds, parseAgencyLinks, parseTypes, parseAgencyRates, CARE_TYPES, parseRole, parseAccountEmail, parseOwnChildren, parseVacations, parseStartDate, DEFAULT_OPENING, parseOpening, parseRates, parseUsers, parseChild, parseEntry, parseMonth, parseId, parseEntryId };
