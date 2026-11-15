const { openWorkbook, XlsxError } = require('./xlsx');
const v = require('./validation');
const { HttpError } = require('./errors');

// Eenmalige import van historische gegevens uit het Excel-planningsbestand van de gastouder (alleen platformbeheer).
//   Blad "Kinderen":   voornaam, geboortedatum, achternaam en contractnummer per kind (vaste tijden en kleur worden niet gebruikt).
//   Blad met jaartal:  per week blokken met vier of vijf kinderen per dag: boven elk blok staat de datum, daaronder per kind
//                      "naam | van | tot". "Vrij" en "Week" zijn geen kinderen. Het aantal kinderen per blok mag verschillen.
// Alleen toevoegen: bestaande kinderen, contracten en uren worden nooit gewijzigd of verwijderd, en een tweede keer importeren van
// hetzelfde bestand voegt niets toe (dubbele uren worden herkend).
const newId = () => Math.random().toString(36).slice(2, 10).padEnd(8, '0');
const SERIAL_MIN = 20000, SERIAL_MAX = 80000;   // Excel-datums (1954 t/m 2118); tijden zijn delen van een dag (< 1)
const isoOfSerial = (n) => new Date(Math.round((Math.floor(n) - 25569) * 86400000)).toISOString().slice(0, 10);
const hhmm = (f) => { const m = Math.round(f * 1440); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
const mins = (e) => (+e.end.slice(0, 2) * 60 + +e.end.slice(3)) - (+e.start.slice(0, 2) * 60 + +e.start.slice(3));
const key = (first, last) => `${String(first).trim().toLowerCase()}|${String(last || '').trim().toLowerCase()}`;
const str = (x) => (typeof x === 'string' ? x.replace(/\s+/g, ' ').trim() : '');

function parsePlanning(buf) {
  let wb;
  try { wb = openWorkbook(buf); } catch (e) { if (e instanceof XlsxError) throw new HttpError(400, e.message); throw e; }
  const warnings = [];
  const get = (cells, r, c) => cells.get(`${r},${c}`);

  // --- Kinderen
  if (!wb.sheets.some((s) => s.name === 'Kinderen')) throw new HttpError(400, 'Het blad "Kinderen" ontbreekt in dit bestand.');
  const kc = wb.read('Kinderen');
  let head = null;
  for (const k of kc.keys()) { const [r, c] = k.split(',').map(Number); if (str(kc.get(k)) === 'Kinderen' && (!head || r < head.r)) head = { r, c }; }
  if (!head) throw new HttpError(400, 'Op het blad "Kinderen" staat geen kolom "Kinderen".');
  const col = { first: head.c };
  for (const k of kc.keys()) {
    const [r, c] = k.split(',').map(Number);
    if (r !== head.r) continue;
    const t = str(kc.get(k)).toLowerCase();
    if (t === 'geboortedatum') col.birth = c; else if (t === 'achternaam') col.last = c; else if (t.startsWith('contract')) col.number = c;
  }
  const children = [], seen = new Set();
  for (let r = head.r + 1; r <= head.r + 60; r++) {
    const first = str(get(kc, r, col.first));
    if (!first || first.toLowerCase() === 'vrij') continue;
    const last = col.last ? str(get(kc, r, col.last)) : '';
    if (seen.has(key(first, last))) { warnings.push(`Kind "${first}" staat dubbel op het blad Kinderen; de tweede is overgeslagen.`); continue; }
    seen.add(key(first, last));
    const bs = col.birth ? get(kc, r, col.birth) : null;
    const num = col.number ? get(kc, r, col.number) : null;
    children.push({ firstName: first, lastName: last, birthDate: typeof bs === 'number' && bs > SERIAL_MIN && bs < SERIAL_MAX ? isoOfSerial(bs) : null, number: num === null || num === undefined ? '' : str(String(num)) });
  }
  if (!children.length) throw new HttpError(400, 'Er staan geen kinderen op het blad "Kinderen".');

  // --- Jaarbladen: elk blad met alleen een jaartal als naam (bijvoorbeeld "2024"); ook de bladen "2024 uren" enz. worden niet gelezen.
  const yearSheets = wb.sheets.filter((s) => /^\d{4}$/.test(s.name)).sort((a, b) => a.name.localeCompare(b.name));
  if (!yearSheets.length) throw new HttpError(400, 'Er is geen blad met een jaartal (bijvoorbeeld "2025") gevonden.');
  const byName = new Map(children.map((c) => [c.firstName.toLowerCase(), c]));
  const years = yearSheets.map((sheet) => {
    const cells = wb.read(sheet.name);
    const a1 = get(cells, 1, 1);
    const year = typeof a1 === 'number' && a1 > SERIAL_MIN && a1 < SERIAL_MAX ? Number(isoOfSerial(a1).slice(0, 4)) : Number(sheet.name);
    if (year !== Number(sheet.name)) warnings.push(`Blad "${sheet.name}": cel A1 zegt ${year}; dat jaar wordt gebruikt.`);
    const dateCells = [];
    for (const [k, val] of cells) {
      const [r, c] = k.split(',').map(Number);
      if (c >= 2 && typeof val === 'number' && val > SERIAL_MIN && val < SERIAL_MAX) dateCells.push({ r, c, date: isoOfSerial(val) });
    }
    const dateRows = [...new Set(dateCells.map((d) => d.r))].sort((a, b) => a - b);
    const entries = [], unknown = new Map();
    for (const d of dateCells) {
      const next = dateRows.find((r) => r > d.r) || d.r + 12;
      for (let r = d.r + 1; r < next; r++) {
        const name = get(cells, r, d.c);
        if (typeof name !== 'string') continue;
        const n = str(name);
        if (!n || n.toLowerCase() === 'week' || n.toLowerCase() === 'vrij') continue;
        const from = get(cells, r, d.c + 1), to = get(cells, r, d.c + 2);
        if (typeof from !== 'number' || typeof to !== 'number' || from < 0 || from >= 1 || to <= 0 || to > 1) { warnings.push(`${sheet.name}, ${d.date}: "${n}" heeft geen geldige begin- en eindtijd; overgeslagen.`); continue; }
        const child = byName.get(n.toLowerCase());
        if (!child) { unknown.set(n, (unknown.get(n) || 0) + 1); continue; }
        const start = hhmm(from), end = hhmm(to);
        if (end <= start) { warnings.push(`${sheet.name}, ${d.date}: ${n} ${start}–${end}: de eindtijd ligt niet na de begintijd; overgeslagen.`); continue; }
        entries.push({ child: key(child.firstName, child.lastName), date: d.date, start, end });
      }
    }
    unknown.forEach((count, n) => warnings.push(`Blad "${sheet.name}": "${n}" staat in de planning (${count}×) maar niet op het blad Kinderen; die uren zijn overgeslagen.`));
    entries.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
    return { year, sheet: sheet.name, entries };
  });
  const dup = years.find((y, i) => years.findIndex((z) => z.year === y.year) !== i);
  if (dup) throw new HttpError(400, `Het jaar ${dup.year} komt meer dan één keer voor in dit bestand.`);
  return { years, children, warnings };
}

// Wat er zou gebeuren (apply = false) of wat er is gebeurd (apply = true), voor de administratie van repo en de gekozen jaren.
// selected = lijst jaartallen (leeg of weggelaten: alle jaren in het bestand).
async function runImport({ repo, parsed, apply, selected }) {
  const available = parsed.years.map((y) => y.year);
  const want = Array.isArray(selected) && selected.length ? selected.map(Number) : available;
  if (want.some((y) => !available.includes(y))) throw new HttpError(400, 'Dat jaar staat niet in dit bestand.');
  const chosen = parsed.years.filter((y) => want.includes(y.year));
  const startDate = await repo.getStartDate();
  const existing = await repo.listChildren();
  const known = new Map(existing.map((c) => [key(c.firstName, c.lastName), c]));
  const taken = new Set((await repo.listAllEntries()).map((e) => `${e.contractId}|${e.date}|${e.start}|${e.end}`));
  const warnings = [...parsed.warnings];
  let before = 0, outside = 0;

  // Per kind en jaar: welk contract, welke uren erbij. Een contract voor een jaar alleen als het kind in dat jaar uren heeft.
  const plan = new Map(parsed.children.map((c) => [key(c.firstName, c.lastName), { src: c, existing: known.get(key(c.firstName, c.lastName)) || null, perYear: [] }]));
  for (const y of chosen) {
    const from = `${y.year}-01-01`, to = `${y.year}-12-31`;
    const mine = new Map();
    y.entries.forEach((e) => mine.set(e.child, [...(mine.get(e.child) || []), e]));
    for (const [k, p] of plan) {
      const list = mine.get(k) || [];
      if (!list.length) continue;
      const have = p.existing && p.existing.contracts.find((x) => x.start && x.end && x.start <= from && x.end >= to);
      const py = { year: y.year, contract: have || { id: newId(), number: p.src.number, rate: null, monthlyHours: null, start: from, end: to, schedule: undefined, paidHolidays: false, agencyId: null }, newContract: !have, add: [], duplicate: 0 };
      for (const e of list) {
        if (e.date < from || e.date > to) { outside++; continue; }
        if (startDate && e.date < startDate) { before++; continue; }
        const id = `${py.contract.id}|${e.date}|${e.start}|${e.end}`;
        if (taken.has(id)) { py.duplicate++; continue; }
        taken.add(id);
        py.add.push(e);
      }
      p.perYear.push(py);
    }
  }
  if (outside) warnings.push(`${outside} uren vielen buiten het jaar van hun blad en zijn overgeslagen.`);
  if (before) warnings.push(`${before} uren lagen vóór de begindatum van de gastouder en zijn overgeslagen.`);

  if (apply) {
    for (const p of plan.values()) {
      const fresh = p.perYear.filter((py) => py.newContract);
      if (p.existing && !fresh.length) continue;
      if (!p.existing && !p.perYear.length) {
        // geen uren in de gekozen jaren: het kind komt er wel in, zonder contract
        await repo.saveChild({ id: newId(), ...v.parseChild({ firstName: p.src.firstName, lastName: p.src.lastName, birthDate: p.src.birthDate }, newId) });
        continue;
      }
      const body = { firstName: p.src.firstName, lastName: p.src.lastName, birthDate: p.src.birthDate, ...(p.existing ? { ...p.existing } : {}), contracts: [...(p.existing ? p.existing.contracts : []), ...fresh.map((py) => py.contract)] };
      const child = { id: p.existing ? p.existing.id : newId(), ...v.parseChild(body, newId) };
      const saved = new Map(child.contracts.map((c) => [`${c.start}|${c.end}|${c.number}`, c]));
      fresh.forEach((py) => { py.contract = saved.get(`${py.contract.start}|${py.contract.end}|${py.contract.number || ''}`) || py.contract; });
      await repo.saveChild(child);
    }
    const all = [...plan.values()].flatMap((p) => p.perYear.flatMap((py) => py.add.map((e) => ({ id: `${e.date}_${newId()}`, date: e.date, contractId: py.contract.id, start: e.start, end: e.end, note: '' }))));
    for (let i = 0; i < all.length; i += 25) await Promise.all(all.slice(i, i + 25).map((e) => repo.saveEntry(e)));
  }
  const rows = [...plan.values()].map((p) => ({
    name: [p.src.firstName, p.src.lastName].filter(Boolean).join(' '),
    child: p.existing ? 'bestaat al' : 'nieuw',
    years: p.perYear.map((py) => ({ year: py.year, contract: py.newContract ? 'nieuw' : 'bestaand', entries: py.add.length, duplicates: py.duplicate, minutes: py.add.reduce((s, e) => s + mins(e), 0) })),
  }));
  const sum = (f) => rows.reduce((s, r) => s + r.years.reduce((t, y) => t + f(y), 0), 0);
  return {
    applied: !!apply, availableYears: available, selectedYears: chosen.map((y) => y.year), children: rows,
    entries: { found: chosen.reduce((s, y) => s + y.entries.length, 0), add: sum((y) => y.entries), minutes: sum((y) => y.minutes), duplicate: sum((y) => y.duplicates), outside, before },
    warnings,
  };
}

module.exports = { parsePlanning, runImport };
