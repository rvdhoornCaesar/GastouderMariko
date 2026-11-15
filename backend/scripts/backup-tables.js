#!/usr/bin/env node
// Gebruik (verbinding in TABLES_CONNECTION):
//   node scripts/backup-tables.js backup [--label tekst]
//   node scripts/backup-tables.js list
//   node scripts/backup-tables.js restore --id <id> [--apply] [--replace]
const { backup, restore, listBackups } = require('./backup');

const [cmd, ...rest] = process.argv.slice(2);
const flag = (n) => rest.includes(`--${n}`);
const value = (n) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
const conn = process.env.TABLES_CONNECTION;

(async () => {
  if (!conn) throw new Error('Zet TABLES_CONNECTION.');
  if (cmd === 'backup') {
    const meta = await backup({ conn, label: value('label') || '' });
    console.log(`Back-up ${meta.id} gemaakt${meta.label ? ` (${meta.label})` : ''}:`);
    meta.tables.forEach((t) => console.log(`  ${t.name}: ${t.rows} rijen, controlesom ${t.checksum.slice(0, 12)}…`));
  } else if (cmd === 'list') {
    const list = await listBackups(conn);
    if (!list.length) console.log('Geen back-ups.');
    list.forEach((b) => console.log(`${b.id}  ${b.createdAt || '(onvolledig)'}  ${b.label || ''}  ${b.tables.map((t) => `${t.name}=${t.rows}`).join(' ')}`));
  } else if (cmd === 'restore') {
    if (!value('id')) throw new Error('Geef --id.');
    const res = await restore({ conn, id: value('id'), apply: flag('apply'), replace: flag('replace') });
    console.log(res.applied ? `Teruggezet uit ${res.id}. De stand van daarvoor staat in back-up ${res.safetyBackup}.` : `Proefrun voor ${res.id}: er is niets veranderd. Voeg --apply toe om terug te zetten.`);
    res.summary.forEach((s) => console.log(`  ${s.name}: ${s.add} toe te voegen, ${s.change} te wijzigen, ${s.same} gelijk, ${s.extra} extra in de huidige tabel${s.remove ? ` (worden verwijderd)` : ''}`));
  } else {
    throw new Error('Onbekende opdracht. Gebruik backup, list of restore.');
  }
})().catch((e) => { console.error(`Mislukt: ${e.message}`); process.exit(1); });
