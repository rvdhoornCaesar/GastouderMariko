const { TableClient } = require('@azure/data-tables');

// Azure Table Storage. De gegevens van een administratie (kinderen, uren en instellingen) staan onder de PartitionKey van die
// administratie; de eerste administratie heet 'main'. Een repo is aan precies één administratie gebonden: createRepo(verbinding, id)
// of repo.forInstance(id). Elke query en elke directe lezing gaat via die ene sleutel, dus een administratie kan niet bij de gegevens
// van een andere. De id wordt nooit uit een verzoek gehaald maar uit de ingelogde gebruiker (zie functions/api.js).
// Accounts, sessies, inlogpogingen en Microsoft-identiteiten zijn bewust gedeeld (globaal) en staan onder eigen vaste sleutels.
// Uren hebben RowKey "JJJJ-MM-DD_xxxx", zodat een maand een simpele range-query is.
// Een e-mailadres dat als RowKey kan dienen (Table Storage weigert / \\ # ? en besturingstekens).
const keySafe = (v) => typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[\\/#?\u0000-\u001f\u007f-\u009f]/.test(v);
const INSTANCE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;   // ook veilig om in een OData-filter te zetten

// instanceId null = geen administratie: alleen de gedeelde tabellen (accounts, organisaties, lidmaatschappen, ...) zijn bruikbaar en elke
// poging om kinderen, uren of instellingen te lezen faalt. Dat is de repo voor een gebruiker die alleen platformbeheer doet.
function createRepo(connectionString, instanceId = 'main', tables = {}) {
  if (instanceId !== null && (typeof instanceId !== 'string' || !INSTANCE_ID.test(instanceId))) throw new Error('Ongeldige administratie.');
  const scope = { get id() { if (instanceId === null) throw new Error('Geen administratie gekozen.'); return instanceId; } };
  const table = (name) => {
    if (!tables[name]) {
      const client = TableClient.fromConnectionString(connectionString, name, { allowInsecureConnection: /UseDevelopmentStorage|127\.0\.0\.1|localhost/.test(connectionString) });
      tables[name] = client.createTable().then(() => client);
    }
    return tables[name];
  };
  const collect = async (iter) => {
    const out = [];
    for await (const row of iter) out.push(row);
    return out;
  };

  const orgOf = (r) => ({ id: r.rowKey, name: r.name, status: r.status || 'active', createdAt: r.createdAt || '', deletedAt: r.deletedAt || '', needsAgency: r.needsAgency === true });
  // Soorten opvang van een bureau (komma-gescheiden in de tabel); oude bureaus zonder veld doen gastouderopvang.
  const agencyTypes = (v) => { const t = String(v || 'gastouder').split(',').filter((x) => x === 'gastouder' || x === 'bso'); return t.length ? t : ['gastouder']; };
  const memberOf = (r) => ({ orgId: r.partitionKey, email: r.rowKey, role: r.role, createdAt: r.createdAt || '', source: r.source || '' });

  // Tweede slot naast het filter: een rij van een andere administratie komt nooit door, wat er ook met de query gebeurt.
  const own = (rows) => {
    if (rows.some((r) => r.partitionKey !== scope.id)) throw new Error('Rij van een andere administratie gevonden.');
    return rows;
  };

  // Oudere kinderen hebben alleen 'name': dat wordt de voornaam.
  const toChild = (r) => {
    const firstName = r.firstName ?? r.name ?? '';
    const lastName = r.lastName ?? '';
    return {
      id: r.rowKey, name: [firstName, lastName].filter(Boolean).join(' '), firstName, lastName,
      birthDate: r.birthDate || null, photo: r.photo || null, parents: r.parents ? JSON.parse(r.parents) : ['', ''],
      contracts: JSON.parse(r.contracts || '[]'), holidays: JSON.parse(r.holidays || '[]'),
    };
  };
  const toEntry = (r) => ({ id: r.rowKey, date: r.rowKey.slice(0, 10), contractId: r.contractId, start: r.start, end: r.end, note: r.note });

  const listEntries = async (filter) => {
    const t = await table('entries');
    const rows = own(await collect(t.listEntities({ queryOptions: { filter: `PartitionKey eq '${scope.id}'${filter}` } })));
    return rows.map(toEntry);
  };

  // Instellingen: één rij per soort, de lijst staat als JSON in 'value'.
  const getSetting = async (key, fallback = []) => {
    const t = await table('settings');
    try {
      return JSON.parse((await t.getEntity(scope.id, key)).value);
    } catch (e) {
      if (e.statusCode === 404) return fallback;
      throw e;
    }
  };
  const setSetting = async (key, list) => {
    const t = await table('settings');
    await t.upsertEntity({ partitionKey: scope.id, rowKey: key, value: JSON.stringify(list) }, 'Replace');
  };

  return {
    instanceId,
    // Dezelfde verbinding en tabelclients, gebonden aan een andere administratie.
    // Zonder id (undefined) komt er géén repo en dus ook niet stilletjes de eerste administratie; null is bewust 'geen administratie'.
    forInstance: (id) => createRepo(connectionString, id === undefined ? 'ongeldig!' : id, tables),

    // Lokale accounts (e-mailadres als sleutel), sessies (sleutel = hash van de sessiesleutel) en inlogpogingen (sleutel = hash van het e-mailadres).
    // 'role' en 'instanceId' liggen nu al vast, zodat er later rollen en meerdere gastouders (instanties) bij kunnen.
    async getAccount(email) {
      const t = await table('accounts');
      try {
        return await t.getEntity('accounts', email);
      } catch (e) {
        if (e.statusCode === 404) return null;
        throw e;
      }
    },
    async listAccounts() {
      const t = await table('accounts');
      return collect(t.listEntities({ queryOptions: { filter: `PartitionKey eq 'accounts'` } }));
    },
    async saveAccount(a) {
      const t = await table('accounts');
      await t.upsertEntity({
        partitionKey: 'accounts', rowKey: a.email, name: a.name || '', role: a.role, instanceId: a.instanceId, platformAdmin: !!a.platformAdmin,
        passwordHash: a.passwordHash, mustChange: !!a.mustChange, createdAt: a.createdAt, lastLogin: a.lastLogin || '',
        // Tweestapsverificatie: geheim versleuteld, herstelcodes als hashes (JSON-lijst)
        totpSecret: a.totpSecret || '', totpPending: a.totpPending || '', totpLastStep: a.totpLastStep || 0, recoveryCodes: a.recoveryCodes || '[]',
      }, 'Replace');
    },
    async setAccountPlatformAdmin(email, flag) {
      await (await table('accounts')).updateEntity({ partitionKey: 'accounts', rowKey: email, platformAdmin: !!flag }, 'Merge');
    },
    async deleteAccount(email) {
      try { await (await table('accounts')).deleteEntity('accounts', email); } catch (e) { if (e.statusCode !== 404) throw e; }
    },
    async createSession(hash, s) {
      await (await table('sessions')).upsertEntity({ partitionKey: 'sessions', rowKey: hash, email: s.email, createdAt: s.createdAt, expiresAt: s.expiresAt }, 'Replace');
    },
    async getSession(hash) {
      try { return await (await table('sessions')).getEntity('sessions', hash); } catch (e) { if (e.statusCode === 404) return null; throw e; }
    },
    async deleteSession(hash) {
      try { await (await table('sessions')).deleteEntity('sessions', hash); } catch (e) { if (e.statusCode !== 404) throw e; }
    },
    async deleteSessionsOf(email, exceptHash) {
      const t = await table('sessions');
      for (const s of await collect(t.listEntities({ queryOptions: { filter: `PartitionKey eq 'sessions' and email eq '${email.replace(/'/g, "''")}'` } }))) {
        if (s.rowKey !== exceptHash) await t.deleteEntity('sessions', s.rowKey);
      }
    },
    async purgeExpiredSessions(nowIso) {
      const t = await table('sessions');
      for (const s of await collect(t.listEntities({ queryOptions: { filter: `PartitionKey eq 'sessions' and expiresAt lt '${nowIso}'` } }))) await t.deleteEntity('sessions', s.rowKey);
    },
    async getThrottle(key) {
      try { return await (await table('throttle')).getEntity('throttle', key); } catch (e) { if (e.statusCode === 404) return null; throw e; }
    },
    async setThrottle(key, v) {
      await (await table('throttle')).upsertEntity({ partitionKey: 'throttle', rowKey: key, count: v.count, lockedUntil: v.lockedUntil || '' }, 'Replace');
    },
    async clearThrottle(key) {
      try { await (await table('throttle')).deleteEntity('throttle', key); } catch (e) { if (e.statusCode !== 404) throw e; }
    },

    // Microsoft-identiteiten: gehasht userId van Static Web Apps -> e-mailadres (zie auth.js, voor als het adres afgeschermd binnenkomt).
    async getIdentity(key) {
      try { return (await (await table('identities')).getEntity('identities', key)).email; } catch (e) { if (e.statusCode === 404) return null; throw e; }
    },
    async setIdentity(key, email) {
      await (await table('identities')).upsertEntity({ partitionKey: 'identities', rowKey: key, email }, 'Replace');
    },
    // Voorkeuren van een persoon (nu: het thema), per e-mailadres en dus los van de organisatie. Zelfde tabel als de identiteiten, eigen PartitionKey.
    async getUserPrefs(email) {
      const key = String(email || '').toLowerCase();
      if (!keySafe(key)) return {};
      try { return JSON.parse((await (await table('identities')).getEntity('prefs', key)).value); } catch (e) { if (e.statusCode === 404) return {}; throw e; }
    },
    async setUserPrefs(email, prefs) {
      const key = String(email || '').toLowerCase();
      if (!keySafe(key)) throw new Error('Ongeldig adres.');
      await (await table('identities')).upsertEntity({ partitionKey: 'prefs', rowKey: key, value: JSON.stringify(prefs) }, 'Replace');
    },

    // Organisaties (administraties) en lidmaatschappen: wie bij welke organisatie hoort en met welke rol. Gedeeld, niet per administratie.
    // Een lidmaatschap staat onder PartitionKey = id van de organisatie en RowKey = e-mailadres.
    async getOrganisation(id) {
      try { return orgOf(await (await table('organisations')).getEntity('organisations', id)); } catch (e) { if (e.statusCode === 404) return null; throw e; }
    },
    async listOrganisations() {
      return (await collect((await table('organisations')).listEntities({ queryOptions: { filter: `PartitionKey eq 'organisations'` } }))).map(orgOf)
        .sort((a, b) => a.name.localeCompare(b.name, 'nl') || a.id.localeCompare(b.id));
    },
    async saveOrganisation(o) {
      if (!INSTANCE_ID.test(o.id)) throw new Error('Ongeldige administratie.');
      await (await table('organisations')).upsertEntity({ partitionKey: 'organisations', rowKey: o.id, name: o.name, status: o.status || 'active', createdAt: o.createdAt || '', deletedAt: o.deletedAt || '', needsAgency: o.needsAgency === true }, 'Replace');
    },
    async deleteOrganisation(id) {
      if (!INSTANCE_ID.test(id)) return;
      try { await (await table('organisations')).deleteEntity('organisations', id); } catch (e) { if (e.statusCode !== 404) throw e; }
    },
    // Gastouderbureaus: één gedeelde lijst voor alle administraties (beheerd door platformbeheerders), in dezelfde tabel als de organisaties maar
    // onder een eigen PartitionKey. Een bureau wordt nooit verwijderd, alleen op niet-actief gezet, zodat contracten ernaar kunnen blijven verwijzen.
    async listAgencies() {
      return (await collect((await table('organisations')).listEntities({ queryOptions: { filter: `PartitionKey eq 'agencies'` } })))
        .map((r) => ({ id: r.rowKey, name: r.name, active: r.active !== false, types: agencyTypes(r.types) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'nl') || a.id.localeCompare(b.id));
    },
    async saveAgency(a) {
      if (!/^[a-z0-9]{6,20}$/.test(a.id)) throw new Error('Ongeldig bureau.');
      await (await table('organisations')).upsertEntity({ partitionKey: 'agencies', rowKey: a.id, name: a.name, active: a.active !== false, types: agencyTypes(a.types).join(',') }, 'Replace');
    },
    async getMembership(orgId, email) {
      if (!INSTANCE_ID.test(orgId) || !keySafe(email)) return null;
      try { return memberOf(await (await table('memberships')).getEntity(orgId, email)); } catch (e) { if (e.statusCode === 404) return null; throw e; }
    },
    async listMembersOf(orgId) {
      if (!INSTANCE_ID.test(orgId)) return [];
      return (await collect((await table('memberships')).listEntities({ queryOptions: { filter: `PartitionKey eq '${orgId}'` } }))).map(memberOf).sort((a, b) => a.email.localeCompare(b.email));
    },
    async listMembershipsOf(email) {
      if (!keySafe(email)) return [];
      return (await collect((await table('memberships')).listEntities({ queryOptions: { filter: `RowKey eq '${email.replace(/'/g, "''")}'` } }))).map(memberOf);
    },
    async saveMembership(m) {
      if (!INSTANCE_ID.test(m.orgId) || !keySafe(m.email)) throw new Error('Ongeldig lidmaatschap.');
      await (await table('memberships')).upsertEntity({ partitionKey: m.orgId, rowKey: m.email, role: m.role, createdAt: m.createdAt || '', source: m.source || '' }, 'Replace');
    },
    async deleteMembership(orgId, email) {
      if (!INSTANCE_ID.test(orgId) || !keySafe(email)) return;
      try { await (await table('memberships')).deleteEntity(orgId, email); } catch (e) { if (e.statusCode !== 404) throw e; }
    },

    getUsers: () => getSetting('users'),
    setUsers: (list) => setSetting('users', list),
    getRates: () => getSetting('rates'),
    setRates: (list) => setSetting('rates', list),
    getStartDate: () => getSetting('startDate', null),
    setStartDate: (d) => setSetting('startDate', d),
    // Status van de uren per kind per maand (geen status = geen rij): 'ingediend' of 'betaald', met wie en wanneer. Eén rij per kind en maand in de
    // instellingentabel (RowKey ms:<kind>:<maand>), zodat het met de jaren niet in één rij hoeft te passen.
    async listMonthStatuses() {
      const t = await table('settings');
      const rows = own(await collect(t.listEntities({ queryOptions: { filter: `PartitionKey eq '${scope.id}' and RowKey ge 'ms:' and RowKey lt 'ms;'` } })));
      return rows.map((r) => { const [, childId, month] = r.rowKey.split(':'); return { childId, month, ...JSON.parse(r.value) }; });
    },
    async setMonthStatus(childId, month, status, by, at) {
      const t = await table('settings'), rowKey = `ms:${childId}:${month}`;
      if (status === 'geen') { try { await t.deleteEntity(scope.id, rowKey); } catch (e) { if (e.statusCode !== 404) throw e; } return; }
      await t.upsertEntity({ partitionKey: scope.id, rowKey, value: JSON.stringify({ status, by, at }) }, 'Replace');
    },
    getAgencyIds: () => getSetting('agencyIds'),
    setAgencyIds: (list) => setSetting('agencyIds', list),
    // Aansluitingen bij gastouderbureaus met periodes. Bestaande gegevens (alleen een lijst bureaus) tellen als aansluiting zonder begin en einde.
    async getAgencyLinks() {
      const links = await getSetting('agencyLinks', null);
      return links || (await getSetting('agencyIds')).map((agencyId) => ({ agencyId, from: null, to: null }));
    },
    setAgencyLinks: (list) => setSetting('agencyLinks', list),
    // Soorten opvang die de gastouder zelf heeft gekozen (null = nog niet gekozen: dan gelden alle soorten van haar bureaus) en de tarieven per bureau.
    getCareTypes: () => getSetting('careTypes', null),
    setCareTypes: (list) => setSetting('careTypes', list),
    getAgencyRates: () => getSetting('agencyRates'),
    setAgencyRates: (list) => setSetting('agencyRates', list),
    getSickDays: () => getSetting('sickDays'),
    setSickDays: (list) => setSetting('sickDays', list),
    getVacations: () => getSetting('vacations'),
    setVacations: (list) => setSetting('vacations', list),
    getOwnChildren: () => getSetting('ownChildren'),
    setOwnChildren: (list) => setSetting('ownChildren', list),
    getOpening: () => getSetting('opening', null),
    setOpening: (o) => setSetting('opening', o),

    async listChildren() {
      const t = await table('children');
      const rows = own(await collect(t.listEntities({ queryOptions: { filter: `PartitionKey eq '${scope.id}'` } })));
      return rows.map(toChild).sort((a, b) => a.name.localeCompare(b.name, 'nl'));
    },
    async getChild(id) {
      const t = await table('children');
      try {
        return toChild(await t.getEntity(scope.id, id));
      } catch (e) {
        if (e.statusCode === 404) return null;
        throw e;
      }
    },
    async saveChild(child) {
      const t = await table('children');
      await t.upsertEntity({
        partitionKey: scope.id, rowKey: child.id, name: child.name, firstName: child.firstName, lastName: child.lastName,
        birthDate: child.birthDate || '', photo: child.photo || '', parents: JSON.stringify(child.parents),
        contracts: JSON.stringify(child.contracts), holidays: JSON.stringify(child.holidays),
      }, 'Replace');
    },
    async deleteChild(id) {
      await (await table('children')).deleteEntity(scope.id, id);
    },
    // '-' en '.' liggen naast elkaar in ASCII, dus dit selecteert precies één maand.
    listEntriesOfMonth(month) {
      return listEntries(` and RowKey ge '${month}-' and RowKey lt '${month}.'`);
    },
    async saveEntry(e) {
      const t = await table('entries');
      await t.upsertEntity({ partitionKey: scope.id, rowKey: e.id, contractId: e.contractId, start: e.start, end: e.end, note: e.note }, 'Replace');
    },
    async getEntry(id) {
      try { return toEntry(await (await table('entries')).getEntity(scope.id, id)); } catch (e) { if (e.statusCode === 404) return null; throw e; }
    },
    async deleteEntry(id) {
      await (await table('entries')).deleteEntity(scope.id, id);
    },
    // Datum van de eerste registratie van deze administratie (of null): de rijen staan op volgorde van RowKey, dus de eerste pagina van 1 is de oudste.
    async firstEntryDate() {
      const t = await table('entries');
      const page = await t.listEntities({ queryOptions: { filter: `PartitionKey eq '${scope.id}'` } }).byPage({ maxPageSize: 1 }).next();
      const first = page.value && own(page.value).map(toEntry)[0];
      return first ? first.date : null;
    },
    // Alle uren van deze administratie (voor een export).
    listAllEntries() {
      return listEntries('');
    },
    // Verwijdert alle gegevens van deze administratie (kinderen, uren, instellingen) en niets van een andere. Onomkeerbaar, behalve via een back-up.
    async purgeInstanceData() {
      const counts = {};
      for (const name of ['children', 'entries', 'settings']) {
        const t = await table(name);
        const rows = own(await collect(t.listEntities({ queryOptions: { filter: `PartitionKey eq '${scope.id}'` } })));
        for (const r of rows) await t.deleteEntity(r.partitionKey, r.rowKey);
        counts[name] = rows.length;
      }
      return counts;
    },
    async deleteEntriesOfContracts(contractIds) {
      const t = await table('entries');
      const ids = new Set(contractIds);
      for (const e of await listEntries('')) if (ids.has(e.contractId)) await t.deleteEntity(scope.id, e.id);
    },
  };
}

module.exports = { createRepo, keySafe };
