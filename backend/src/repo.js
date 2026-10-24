const { TableClient } = require('@azure/data-tables');

// Azure Table Storage. Alle gegevens van een omgeving worden gedeeld door alle toegestane gebruikers
// (PartitionKey is altijd 'main'). Uren hebben RowKey "JJJJ-MM-DD_xxxx", zodat een maand een simpele range-query is.
const PK = 'main';

function createRepo(connectionString) {
  const tables = {};
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

  // Oudere kinderen hebben alleen 'name': dat wordt de voornaam.
  const toChild = (r) => {
    const firstName = r.firstName ?? r.name ?? '';
    const lastName = r.lastName ?? '';
    return {
      id: r.rowKey, name: [firstName, lastName].filter(Boolean).join(' '), firstName, lastName,
      birthDate: r.birthDate || null, parents: r.parents ? JSON.parse(r.parents) : ['', ''],
      contracts: JSON.parse(r.contracts || '[]'), holidays: JSON.parse(r.holidays || '[]'),
    };
  };
  const toEntry = (r) => ({ id: r.rowKey, date: r.rowKey.slice(0, 10), contractId: r.contractId, start: r.start, end: r.end, note: r.note });

  const listEntries = async (filter) => {
    const t = await table('entries');
    const rows = await collect(t.listEntities({ queryOptions: { filter: `PartitionKey eq '${PK}'${filter}` } }));
    return rows.map(toEntry);
  };

  // Instellingen: één rij per soort, de lijst staat als JSON in 'value'.
  const getSetting = async (key, fallback = []) => {
    const t = await table('settings');
    try {
      return JSON.parse((await t.getEntity(PK, key)).value);
    } catch (e) {
      if (e.statusCode === 404) return fallback;
      throw e;
    }
  };
  const setSetting = async (key, list) => {
    const t = await table('settings');
    await t.upsertEntity({ partitionKey: PK, rowKey: key, value: JSON.stringify(list) }, 'Replace');
  };

  return {
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
        partitionKey: 'accounts', rowKey: a.email, name: a.name || '', role: a.role, instanceId: a.instanceId,
        passwordHash: a.passwordHash, mustChange: !!a.mustChange, createdAt: a.createdAt, lastLogin: a.lastLogin || '',
        // Tweestapsverificatie: geheim versleuteld, herstelcodes als hashes (JSON-lijst)
        totpSecret: a.totpSecret || '', totpPending: a.totpPending || '', totpLastStep: a.totpLastStep || 0, recoveryCodes: a.recoveryCodes || '[]',
      }, 'Replace');
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

    getUsers: () => getSetting('users'),
    setUsers: (list) => setSetting('users', list),
    getRates: () => getSetting('rates'),
    setRates: (list) => setSetting('rates', list),
    getOwnChildren: () => getSetting('ownChildren'),
    setOwnChildren: (list) => setSetting('ownChildren', list),
    getOpening: () => getSetting('opening', null),
    setOpening: (o) => setSetting('opening', o),

    async listChildren() {
      const t = await table('children');
      const rows = await collect(t.listEntities({ queryOptions: { filter: `PartitionKey eq '${PK}'` } }));
      return rows.map(toChild).sort((a, b) => a.name.localeCompare(b.name, 'nl'));
    },
    async getChild(id) {
      const t = await table('children');
      try {
        return toChild(await t.getEntity(PK, id));
      } catch (e) {
        if (e.statusCode === 404) return null;
        throw e;
      }
    },
    async saveChild(child) {
      const t = await table('children');
      await t.upsertEntity({
        partitionKey: PK, rowKey: child.id, name: child.name, firstName: child.firstName, lastName: child.lastName,
        birthDate: child.birthDate || '', parents: JSON.stringify(child.parents),
        contracts: JSON.stringify(child.contracts), holidays: JSON.stringify(child.holidays),
      }, 'Replace');
    },
    async deleteChild(id) {
      await (await table('children')).deleteEntity(PK, id);
    },
    // '-' en '.' liggen naast elkaar in ASCII, dus dit selecteert precies één maand.
    listEntriesOfMonth(month) {
      return listEntries(` and RowKey ge '${month}-' and RowKey lt '${month}.'`);
    },
    async saveEntry(e) {
      const t = await table('entries');
      await t.upsertEntity({ partitionKey: PK, rowKey: e.id, contractId: e.contractId, start: e.start, end: e.end, note: e.note }, 'Replace');
    },
    async deleteEntry(id) {
      await (await table('entries')).deleteEntity(PK, id);
    },
    async deleteEntriesOfContracts(contractIds) {
      const t = await table('entries');
      const ids = new Set(contractIds);
      for (const e of await listEntries('')) if (ids.has(e.contractId)) await t.deleteEntity(PK, e.id);
    },
  };
}

module.exports = { createRepo };
