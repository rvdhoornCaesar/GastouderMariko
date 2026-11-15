const { HttpError } = require('./errors');
const { fixedUsers } = require('./admins');
const { keySafe } = require('./repo');

// Organisaties (administraties) en lidmaatschappen. Een gebruiker (e-mailadres) kan in meerdere organisaties zitten, met per organisatie een
// rol (gebruiker of beheerder). Platformbeheer (de vaste gebruikers uit ALLOWED_USERS en de code, of een lokaal account met de vlag
// platformAdmin) is los daarvan: dat geeft toegang tot het Admin-tabblad, niet tot de gegevens van een organisatie. Daarvoor moet je lid zijn.
const FIRST_ORG = { id: 'main', name: 'Gastouder Mariko' };
const ROLES = ['gebruiker', 'beheerder'];
const ORG_HEADER = 'x-organisatie';

// --- Eenmalig vullen vanuit de oude gegevens ---------------------------------------------------------------------------------------------
// Vóór deze versie hoorde iedereen bij de ene administratie 'main': lokale accounts (met een rol en instanceId), de lijst 'Toegestane
// gebruikers' bij de instellingen (Microsoft) en de vaste gebruikers. Dit zet exact die toegang om in lidmaatschappen, zodat niemand iets
// kwijtraakt. De oude gegevens blijven onaangeraakt staan (terugdraaien = de vorige versie deployen). De organisatie zelf wordt als
// laatste geschreven: stopt het halverwege, dan is de volgende keer gewoon opnieuw beginnen (het is herhaalbaar) en wordt niets dubbel.
const higher = (a, b) => (a === 'beheerder' || b === 'beheerder' ? 'beheerder' : 'gebruiker');

async function planSeed(repo, env) {
  const members = new Map(), skipped = [], platformFlags = [];
  const add = (raw, role, source) => {
    const email = String(raw || '').trim().toLowerCase();
    if (!email) return;
    if (!keySafe(email)) { skipped.push({ email, reason: 'ongeldig adres' }); return; }
    const cur = members.get(email);
    members.set(email, { email, role: cur ? higher(cur.role, role) : role, source: cur ? cur.source : source });
  };
  for (const a of await repo.listAccounts()) {
    if ((a.instanceId || FIRST_ORG.id) !== FIRST_ORG.id) { skipped.push({ email: a.rowKey, reason: `account hoort bij administratie ${a.instanceId}` }); continue; }
    add(a.rowKey, a.role === 'admin' || a.role === 'beheerder' ? 'beheerder' : 'gebruiker', 'lokaal account');
    if (a.role === 'admin') platformFlags.push(a.rowKey);   // een lokale admin blijft platformbeheerder
  }
  for (const e of await repo.forInstance(FIRST_ORG.id).getUsers()) add(e, 'beheerder', 'toegestane gebruiker');
  for (const e of fixedUsers(env)) add(e, 'beheerder', 'vaste gebruiker');
  return { organisation: { ...FIRST_ORG }, members: [...members.values()].sort((a, b) => a.email.localeCompare(b.email)), platformFlags, skipped };
}

async function seed(repo, env, { dryRun = false, now = new Date() } = {}) {
  if (await repo.getOrganisation(FIRST_ORG.id)) return { alreadySeeded: true };
  const plan = await planSeed(repo, env);
  if (dryRun) return { dryRun: true, ...plan };
  for (const m of plan.members) {
    if (!(await repo.getMembership(FIRST_ORG.id, m.email))) await repo.saveMembership({ orgId: FIRST_ORG.id, email: m.email, role: m.role, createdAt: now.toISOString(), source: m.source });
  }
  for (const email of plan.platformFlags) await repo.setAccountPlatformAdmin(email, true);
  await repo.saveOrganisation({ ...FIRST_ORG, status: 'active', createdAt: now.toISOString() });   // als laatste: dit is de markering dat het klaar is
  return { dryRun: false, ...plan };
}

// Wordt vóór elk verzoek aangeroepen en doet na de eerste keer niets meer (per proces onthouden).
let seeded = null;
function ensureSeeded(repo, env) {
  if (!seeded) {
    seeded = seed(repo, env).catch((e) => { seeded = null; throw e; });   // bij een fout de volgende keer opnieuw proberen
  }
  return seeded;
}
const resetSeedCache = () => { seeded = null; };

// --- Bij welke organisatie hoort dit verzoek ---------------------------------------------------------------------------------------------
// De organisatie komt nooit zomaar uit het verzoek: de gebruiker mag in de header x-organisatie een keuze doen, maar die moet een organisatie
// zijn waar hij lid van is (en die actief is). Anders is het een 403, ook als hij in een andere organisatie wel lid is: stilzwijgend
// overschakelen zou iemand ongemerkt in de verkeerde administratie laten schrijven. Zonder header is het de eerste organisatie (op naam).
function requestedOrganisation(headers) {
  const raw = headers && typeof headers.get === 'function' ? headers.get(ORG_HEADER) : null;
  const v = String(raw ?? '').trim().toLowerCase();
  return v || null;
}

async function resolveContext({ repo, email, requested, platformAdmin, denied = {} }) {
  const memberships = await repo.listMembershipsOf(email);
  const mine = [];
  for (const m of memberships) {
    if (!ROLES.includes(m.role)) continue;   // onbekende rol: geen toegang
    const org = await repo.getOrganisation(m.orgId);
    if (org && org.status === 'active') mine.push({ id: org.id, name: org.name, role: m.role });
  }
  mine.sort((a, b) => a.name.localeCompare(b.name, 'nl') || a.id.localeCompare(b.id));
  let active = null;
  if (requested) {
    active = mine.find((o) => o.id === requested) || null;
    if (!active) throw new HttpError(403, 'Geen toegang tot deze organisatie.', { code: 'organisation_denied', ...denied });
  } else {
    active = mine[0] || null;
  }
  if (!active && !platformAdmin) throw new HttpError(403, 'Geen toegang.', denied);
  return { organisations: mine, organisation: active ? { id: active.id, name: active.name } : null, instanceId: active ? active.id : null, role: active ? active.role : null };
}

module.exports = { FIRST_ORG, ROLES, ORG_HEADER, planSeed, seed, ensureSeeded, resetSeedCache, requestedOrganisation, resolveContext };
