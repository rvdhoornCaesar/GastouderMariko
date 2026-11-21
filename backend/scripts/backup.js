const crypto = require('node:crypto');
const { TableClient, TableServiceClient } = require('@azure/data-tables');

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

module.exports = { backup, restore, listBackups, prune, AUTO_LABEL, checksum, normalizeRow, stamp, EXCLUDED };
