const { TableClient } = require('@azure/data-tables');

// Azure Table Storage. PartitionKey = gebruiker, RowKey = id.
// Uren hebben RowKey "JJJJ-MM-DD_xxxx", zodat een maand een simpele range-query is.
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

  const toChild = (r) => ({ id: r.rowKey, name: r.name, contracts: JSON.parse(r.contracts || '[]') });
  const toEntry = (r) => ({ id: r.rowKey, date: r.rowKey.slice(0, 10), contractId: r.contractId, start: r.start, end: r.end, note: r.note });

  const listEntries = async (user, filter) => {
    const t = await table('entries');
    const rows = await collect(t.listEntities({ queryOptions: { filter: `PartitionKey eq '${user}'${filter}` } }));
    return rows.map(toEntry);
  };

  return {
    async listChildren(user) {
      const t = await table('children');
      const rows = await collect(t.listEntities({ queryOptions: { filter: `PartitionKey eq '${user}'` } }));
      return rows.map(toChild).sort((a, b) => a.name.localeCompare(b.name, 'nl'));
    },
    async getChild(user, id) {
      const t = await table('children');
      try {
        return toChild(await t.getEntity(user, id));
      } catch (e) {
        if (e.statusCode === 404) return null;
        throw e;
      }
    },
    async saveChild(user, child) {
      const t = await table('children');
      await t.upsertEntity({ partitionKey: user, rowKey: child.id, name: child.name, contracts: JSON.stringify(child.contracts) }, 'Replace');
    },
    async deleteChild(user, id) {
      await (await table('children')).deleteEntity(user, id);
    },
    // '-' en '.' liggen naast elkaar in ASCII, dus dit selecteert precies één maand.
    listEntriesOfMonth(user, month) {
      return listEntries(user, ` and RowKey ge '${month}-' and RowKey lt '${month}.'`);
    },
    async saveEntry(user, e) {
      const t = await table('entries');
      await t.upsertEntity({ partitionKey: user, rowKey: e.id, contractId: e.contractId, start: e.start, end: e.end, note: e.note }, 'Replace');
    },
    async deleteEntry(user, id) {
      await (await table('entries')).deleteEntity(user, id);
    },
    async deleteEntriesOfContracts(user, contractIds) {
      const t = await table('entries');
      const ids = new Set(contractIds);
      for (const e of await listEntries(user, '')) if (ids.has(e.contractId)) await t.deleteEntity(user, e.id);
    },
  };
}

module.exports = { createRepo };
