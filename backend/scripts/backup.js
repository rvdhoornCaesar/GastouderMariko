const crypto = require('node:crypto');
const { TableClient, TableServiceClient } = require('@azure/data-tables');
const { createRepo } = require('../src/repo');

// Back-up en herstel van de tabellen in Table Storage. Een back-up is een kopie van elke tabel naar een tabel "bak<id><naam>", plus een
// tabel "bak<id>meta" met per tabel het aantal rijen en een controlesom. Niets wordt ooit weggegooid of overschreven door een back-up.
// Sessies en inlogpogingen worden niet meegenomen: ze bevatten niets om te bewaren, en terugzetten zou ingetrokken sessies kunnen heropenen.
const EXCLUDED = new Set(['sessions', 'throttle']);
const PREFIX = 'bak';
const BACKUP_NAME = /^bak(\d{8}t\d{6})(.+)$/;
const CONCURRENCY = 10;

const optionsFor = (conn) => ({ allowInsecureConnection: /UseDevelopmentStorage|127\.0\.0\.1|localhost/.test(conn) });
const service = (conn) => TableServiceClient.fromConnectionString(conn, optionsFor(conn));
const client = (conn, name) => TableClient.fromConnectionString(conn, name, optionsFor(conn));

const stamp = (now = new Date()) => now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', 't');   // 20261115t093012
const backupTable = (id, name) => `${PREFIX}${id}${name}`;

async function collect(iter) {
  const out = [];
  for await (const x of iter) out.push(x);
  return out;
}
async function tableNames(conn) {
  return (await collect(service(conn).listTables())).map((t) => t.name);
}

// Rijen zonder etag en tijdstempel (die verschillen per kopie), op volgorde, met vaste volgorde van eigenschappen.
const normalizeRow = (r) => {
  const { etag, timestamp, 'odata.metadata': m, ...rest } = r;
  return Object.fromEntries(Object.keys(rest).sort().map((k) => [k, rest[k]]));
};
const sortRows = (rows) => rows.sort((a, b) => a.partitionKey.localeCompare(b.partitionKey) || a.rowKey.localeCompare(b.rowKey));
async function readAll(conn, name) {
  return sortRows((await collect(client(conn, name).listEntities())).map(normalizeRow));
}
const checksum = (rows) => crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
const rowKey = (r) => `${r.partitionKey}\u0000${r.rowKey}`;

async function inBatches(items, fn) {
  for (let i = 0; i < items.length; i += CONCURRENCY) await Promise.all(items.slice(i, i + CONCURRENCY).map(fn));
}
async function createIfMissing(conn, name) {
  await client(conn, name).createTable();   // geen fout als hij al bestaat
}

// Maakt een back-up van alle tabellen (behalve sessies, inlogpogingen en eerdere back-ups). Mislukt als een kopie niet gelijk is aan de bron.
async function backup({ conn, now = new Date(), label = '' }) {
  const id = stamp(now), names = (await tableNames(conn)).filter((n) => !n.startsWith(PREFIX) && !EXCLUDED.has(n)).sort();
  if (await readMeta(conn, id)) throw new Error(`Er bestaat al een back-up ${id}; probeer het over een seconde opnieuw.`);
  const tables = [];
  for (const name of names) {
    const rows = await readAll(conn, name), target = backupTable(id, name);
    await createIfMissing(conn, target);
    const copy = client(conn, target);
    await inBatches(rows, (r) => copy.upsertEntity(r, 'Replace'));
    const copied = await readAll(conn, target);
    if (copied.length !== rows.length || checksum(copied) !== checksum(rows)) throw new Error(`Back-up van ${name} komt niet overeen met de bron (${copied.length} van ${rows.length} rijen).`);
    tables.push({ name, rows: rows.length, checksum: checksum(rows) });
  }
  const meta = { id, label, createdAt: now.toISOString(), tables };
  await createIfMissing(conn, backupTable(id, 'meta'));
  await client(conn, backupTable(id, 'meta')).upsertEntity({ partitionKey: 'meta', rowKey: 'info', json: JSON.stringify(meta) }, 'Replace');
  return meta;
}

async function readMeta(conn, id) {
  try { return JSON.parse((await client(conn, backupTable(id, 'meta')).getEntity('meta', 'info')).json); } catch (e) { if (e.statusCode === 404) return null; throw e; }
}
async function listBackups(conn) {
  const ids = [...new Set((await tableNames(conn)).map((n) => (BACKUP_NAME.exec(n) || [])[1]).filter(Boolean))].sort().reverse();
  return Promise.all(ids.map(async (id) => (await readMeta(conn, id)) || { id, label: '', createdAt: null, tables: [], incomplete: true }));
}

// Zet een back-up terug. Zonder apply gebeurt er niets behalve het tellen van wat er zou veranderen. Met apply wordt eerst een nieuwe
// back-up van de huidige stand gemaakt, zodat ook een herstel terug te draaien is. Rijen die in de huidige tabel staan maar niet in de
// back-up worden alleen verwijderd met replace.
async function restore({ conn, id, apply = false, replace = false, now = new Date() }) {
  const meta = await readMeta(conn, id);
  if (!meta) throw new Error(`Back-up ${id} niet gevonden of niet compleet.`);
  const plan = [];
  for (const t of meta.tables) {
    const rows = await readAll(conn, backupTable(id, t.name));
    if (rows.length !== t.rows || checksum(rows) !== t.checksum) throw new Error(`Back-up ${id} is beschadigd bij tabel ${t.name}; er is niets teruggezet.`);
    const existing = (await tableNames(conn)).includes(t.name) ? await readAll(conn, t.name) : [];
    const live = new Map(existing.map((r) => [rowKey(r), JSON.stringify(r)]));
    const want = new Set(rows.map(rowKey));
    plan.push({ name: t.name, rows,
      add: rows.filter((r) => !live.has(rowKey(r))).length,
      change: rows.filter((r) => live.has(rowKey(r)) && live.get(rowKey(r)) !== JSON.stringify(r)).length,
      same: rows.filter((r) => live.get(rowKey(r)) === JSON.stringify(r)).length,
      extra: existing.filter((r) => !want.has(rowKey(r))),
    });
  }
  const summary = plan.map(({ name, add, change, same, extra }) => ({ name, add, change, same, extra: extra.length, remove: replace ? extra.length : 0 }));
  if (!apply) return { applied: false, id, summary };
  const safety = await backup({ conn, now, label: `voor herstel van ${id}` });
  for (const p of plan) {
    await createIfMissing(conn, p.name);
    const live = client(conn, p.name);
    await inBatches(p.rows, (r) => live.upsertEntity(r, 'Replace'));
    if (replace) await inBatches(p.extra, (r) => live.deleteEntity(r.partitionKey, r.rowKey));
    const after = await readAll(conn, p.name), have = new Map(after.map((r) => [rowKey(r), JSON.stringify(r)]));
    if (p.rows.some((r) => have.get(rowKey(r)) !== JSON.stringify(r)) || (replace && after.length !== p.rows.length)) throw new Error(`Controle na herstel van ${p.name} mislukt; de stand van voor het herstel staat in back-up ${safety.id}.`);
  }
  return { applied: true, id, summary, safetyBackup: safety.id };
}

// Herstel van één administratie (gastouder) uit een back-up. De gegevens van een administratie staan in de tabellen children, entries en
// settings onder PartitionKey = id van de administratie; alleen die rijen worden aangeraakt, de rest van het platform en de andere
// administraties blijven zoals ze zijn. Leden (memberships) en accounts worden nooit teruggezet: wie nu toegang heeft, houdt die.
//  - Met `target` komt de oude stand als nieuwe administratie "<naam> (herstel <tijdstip>)" naast de huidige, met dezelfde leden en
//    rollen, om te vergelijken. Het doel moet nieuw zijn en er verandert niets aan bestaande gegevens.
//  - Zonder `target` wordt de administratie zelf teruggezet: eerst een veiligheidskopie van alle tabellen, dan alle rijen uit de
//    back-up terugschrijven (met `replace` ook de rijen verwijderen die er na de back-up bij zijn gekomen).
// Zonder `apply` verandert er niets en krijg je alleen het overzicht.
const ORG_TABLES = ['children', 'entries', 'settings'];
const ORG_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
async function snapshotRows(conn, id, org) {
  const meta = await readMeta(conn, id);
  if (!meta) throw new Error(`Back-up ${id} niet gevonden of niet compleet.`);
  const out = {};
  for (const name of ORG_TABLES) {
    const t = meta.tables.find((x) => x.name === name);
    if (!t) { out[name] = []; continue; }
    const rows = await readAll(conn, backupTable(id, name));
    if (rows.length !== t.rows || checksum(rows) !== t.checksum) throw new Error(`Back-up ${id} is beschadigd bij tabel ${name}; er is niets teruggezet.`);
    out[name] = rows.filter((r) => r.partitionKey === org);
  }
  return { meta, rows: out };
}
async function liveRows(conn, org) {
  const names = await tableNames(conn), out = {};
  for (const name of ORG_TABLES) out[name] = names.includes(name) ? (await readAll(conn, name)).filter((r) => r.partitionKey === org) : [];
  return out;
}
const count = (o) => ORG_TABLES.map((n) => `${n}=${o[n].length}`).join(' ');

// Welke administraties staan in een back-up, met aantal rijen per tabel.
async function organisationsIn({ conn, id }) {
  const meta = await readMeta(conn, id);
  if (!meta) throw new Error(`Back-up ${id} niet gevonden of niet compleet.`);
  const by = new Map();
  for (const name of ORG_TABLES) {
    if (!meta.tables.some((x) => x.name === name)) continue;
    for (const r of await readAll(conn, backupTable(id, name))) {
      if (!by.has(r.partitionKey)) by.set(r.partitionKey, { org: r.partitionKey, children: 0, entries: 0, settings: 0 });
      by.get(r.partitionKey)[name]++;
    }
  }
  const repo = createRepo(conn);
  return Promise.all([...by.values()].sort((a, b) => a.org.localeCompare(b.org)).map(async (o) => ({ ...o, name: ((await repo.getOrganisation(o.org)) || {}).name || null })));
}

async function restoreOrganisation({ conn, id, org, target = '', apply = false, replace = false, now = new Date() }) {
  if (!ORG_ID.test(org || '')) throw new Error('Geef de id van de administratie (zie de opdracht organisaties).');
  if (target && !ORG_ID.test(target)) throw new Error('Ongeldige id voor de kopie.');
  if (target === org) throw new Error('De kopie moet een andere id hebben dan de administratie zelf; laat target weg om terug te zetten.');
  const { meta, rows } = await snapshotRows(conn, id, org);
  if (!ORG_TABLES.some((n) => rows[n].length)) throw new Error(`Back-up ${id} bevat geen gegevens van administratie ${org}.`);
  const repo = createRepo(conn);
  const live = await liveRows(conn, org);

  if (target) {
    if (await repo.getOrganisation(target)) throw new Error(`Administratie ${target} bestaat al; kies een nieuwe id.`);
    const there = await liveRows(conn, target);
    if (ORG_TABLES.some((n) => there[n].length)) throw new Error(`Er staan al gegevens onder ${target}; kies een nieuwe id.`);
    const summary = { copy: true, from: org, target, backup: id, rows: count(rows) };
    if (!apply) return { applied: false, ...summary };
    const source = await repo.getOrganisation(org);
    const when = (meta.createdAt || '').slice(0, 16).replace('T', ' ');
    for (const name of ORG_TABLES) {
      await createIfMissing(conn, name);
      const t = client(conn, name);
      await inBatches(rows[name], (r) => t.upsertEntity({ ...r, partitionKey: target }, 'Replace'));
    }
    const after = await liveRows(conn, target);
    for (const name of ORG_TABLES) {
      const want = rows[name].map((r) => JSON.stringify({ ...r, partitionKey: target }));
      if (after[name].length !== want.length || after[name].some((r, i) => JSON.stringify(r) !== want[i])) throw new Error(`Controle van de kopie (${name}) mislukt; er is niets aan ${org} veranderd.`);
    }
    // De organisatie als laatste: dit is de markering dat de kopie compleet is.
    await repo.saveOrganisation({ id: target, name: `${source ? source.name : org} (herstel ${when})`, status: 'active', createdAt: now.toISOString(), needsAgency: source ? source.needsAgency : false });
    for (const m of await repo.listMembersOf(org)) await repo.saveMembership({ orgId: target, email: m.email, role: m.role, createdAt: now.toISOString(), source: 'herstel' });
    return { applied: true, ...summary };
  }

  const plan = ORG_TABLES.map((name) => {
    const liveMap = new Map(live[name].map((r) => [rowKey(r), JSON.stringify(r)]));
    const extra = live[name].filter((r) => !rows[name].some((x) => rowKey(x) === rowKey(r)));
    return { name, rows: rows[name], extra,
      add: rows[name].filter((r) => !liveMap.has(rowKey(r))).length,
      change: rows[name].filter((r) => liveMap.has(rowKey(r)) && liveMap.get(rowKey(r)) !== JSON.stringify(r)).length,
      same: rows[name].filter((r) => liveMap.get(rowKey(r)) === JSON.stringify(r)).length };
  });
  const summary = plan.map(({ name, add, change, same, extra }) => ({ name, add, change, same, extra: extra.length, remove: replace ? extra.length : 0 }));
  if (!apply) return { applied: false, copy: false, org, backup: id, summary };
  const safety = await backup({ conn, now, label: `voor herstel van ${org} uit ${id}` });
  for (const p of plan) {
    await createIfMissing(conn, p.name);
    const t = client(conn, p.name);
    await inBatches(p.rows, (r) => t.upsertEntity(r, 'Replace'));
    if (replace) await inBatches(p.extra, (r) => t.deleteEntity(r.partitionKey, r.rowKey));
  }
  const after = await liveRows(conn, org);
  for (const p of plan) {
    const have = new Map(after[p.name].map((r) => [rowKey(r), JSON.stringify(r)]));
    if (p.rows.some((r) => have.get(rowKey(r)) !== JSON.stringify(r)) || (replace && after[p.name].length !== p.rows.length)) throw new Error(`Controle na herstel van ${p.name} mislukt; de stand van voor het herstel staat in back-up ${safety.id}.`);
  }
  return { applied: true, copy: false, org, backup: id, summary, safetyBackup: safety.id };
}

// Ruimt automatische back-ups op: de nieuwste `keep` blijven staan, oudere gaan weg. Alleen back-ups met een omschrijving die met
// "automatisch" begint worden aangeraakt; handmatige back-ups en veiligheidskopieën van een herstel blijven altijd staan.
const AUTO_LABEL = 'automatisch';
async function prune({ conn, keep = 35, apply = true }) {
  if (!Number.isInteger(keep) || keep < 1) throw new Error('keep moet een geheel getal van minstens 1 zijn.');
  const auto = (await listBackups(conn)).filter((b) => !b.incomplete && (b.label || '').startsWith(AUTO_LABEL));   // nieuwste eerst
  const old = auto.slice(keep);
  if (apply) {
    const names = await tableNames(conn);
    for (const b of old) {
      for (const n of names.filter((x) => x.startsWith(`${PREFIX}${b.id}`) && BACKUP_NAME.exec(x)[1] === b.id)) {
        try { await service(conn).deleteTable(n); } catch (e) { if (e.statusCode !== 404) throw e; }
      }
    }
  }
  return { kept: auto.slice(0, keep).map((b) => b.id), removed: old.map((b) => b.id), applied: apply };
}

module.exports = { backup, restore, restoreOrganisation, organisationsIn, listBackups, prune, AUTO_LABEL, checksum, normalizeRow, stamp, EXCLUDED };
