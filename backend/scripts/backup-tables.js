#!/usr/bin/env node
// Gebruik (verbinding in TABLES_CONNECTION):
//   node scripts/backup-tables.js backup [--label tekst]
//   node scripts/backup-tables.js list
//   node scripts/backup-tables.js prune [--keep 35]   (ruimt alleen back-ups met omschrijving "automatisch…" op)
//   node scripts/backup-tables.js organisaties --id <id>   (welke administraties in een back-up staan)
//   node scripts/backup-tables.js restore-organisatie --id <id> --org <administratie> [--target <nieuwe id>] [--apply] [--replace]
//   node scripts/backup-tables.js restore --id <id> [--apply] [--replace]
//   node scripts/backup-tables.js plan-organisaties   (alleen lezen: wat de overstap naar organisaties zou doen; ALLOWED_USERS uit de omgeving)
const { backup, restore, restoreOrganisation, organisationsIn, listBackups, prune } = require('./backup');
const { createRepo } = require('../src/repo');
const { planSeed } = require('../src/organisations');
const masked = (e) => e.replace(/^(.{1,2})[^@]*@/, '$1***@');   // adressen niet volledig in een log

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
  } else if (cmd === 'prune') {
    const keep = value('keep') ? Number(value('keep')) : 35;
    const res = await prune({ conn, keep });
    console.log(`Automatische back-ups: ${res.kept.length} bewaard, ${res.removed.length} opgeruimd${res.removed.length ? ` (${res.removed.join(', ')})` : ''}.`);
  } else if (cmd === 'organisaties') {
    if (!value('id')) throw new Error('Geef --id.');
    (await organisationsIn({ conn, id: value('id') })).forEach((o) => console.log(`${o.org}  ${o.name || '(geen naam meer)'}  kinderen=${o.children} uren=${o.entries} instellingen=${o.settings}`));
  } else if (cmd === 'restore-organisatie') {
    if (!value('id') || !value('org')) throw new Error('Geef --id en --org.');
    const res = await restoreOrganisation({ conn, id: value('id'), org: value('org'), target: value('target') || '', apply: flag('apply'), replace: flag('replace') });
    if (res.copy) console.log(res.applied ? `Kopie ${res.target} aangemaakt uit ${res.backup} (${res.rows}). Zelfde leden als ${res.from}; wissel in de app naar de administratie "herstel" om te vergelijken.` : `Proefrun: er zou een kopie ${res.target} komen met ${res.rows}. Voeg --apply toe.`);
    else {
      console.log(res.applied ? `Administratie ${res.org} teruggezet uit ${res.backup}. De stand van daarvoor staat in back-up ${res.safetyBackup}.` : `Proefrun voor ${res.org} uit ${res.backup}: er is niets veranderd. Voeg --apply toe om terug te zetten.`);
      res.summary.forEach((x) => console.log(`  ${x.name}: ${x.add} toe te voegen, ${x.change} te wijzigen, ${x.same} gelijk, ${x.extra} nieuwer dan de back-up${x.remove ? ' (worden verwijderd)' : ''}`));
    }
  } else if (cmd === 'restore') {
    if (!value('id')) throw new Error('Geef --id.');
    const res = await restore({ conn, id: value('id'), apply: flag('apply'), replace: flag('replace') });
    console.log(res.applied ? `Teruggezet uit ${res.id}. De stand van daarvoor staat in back-up ${res.safetyBackup}.` : `Proefrun voor ${res.id}: er is niets veranderd. Voeg --apply toe om terug te zetten.`);
    res.summary.forEach((s) => console.log(`  ${s.name}: ${s.add} toe te voegen, ${s.change} te wijzigen, ${s.same} gelijk, ${s.extra} extra in de huidige tabel${s.remove ? ` (worden verwijderd)` : ''}`));
  } else if (cmd === 'plan-organisaties') {
    const repo = createRepo(conn);
    if (await repo.getOrganisation('main')) { console.log('De organisatie "main" bestaat al: de overstap is al gedaan en er wordt niets meer gevuld.'); return; }
    const plan = await planSeed(repo, process.env);
    console.log(`Er wordt een organisatie "${plan.organisation.name}" (id ${plan.organisation.id}) aangemaakt met ${plan.members.length} leden. Er wordt niets geschreven door dit voorbeeld.`);
    const count = (r) => plan.members.filter((m) => m.role === r).length;
    console.log(`  beheerder: ${count('beheerder')}, gebruiker: ${count('gebruiker')}`);
    plan.members.forEach((m) => console.log(`  ${masked(m.email)}  ${m.role}  (${m.source})`));
    console.log(`Lokale accounts die platformbeheerder blijven: ${plan.platformFlags.length}${plan.platformFlags.length ? ` (${plan.platformFlags.map(masked).join(', ')})` : ''}`);
    plan.skipped.forEach((x) => console.log(`  overgeslagen: ${masked(x.email)} (${x.reason})`));
  } else {
    throw new Error('Onbekende opdracht. Gebruik backup, list, organisaties, prune, restore, restore-organisatie of plan-organisaties.');
  }
})().catch((e) => { console.error(`Mislukt: ${e.message}`); process.exit(1); });
