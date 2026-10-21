const { HttpError } = require('./errors');
const v = require('./validation');

const newId = () => Math.random().toString(36).slice(2, 10).padEnd(8, '0');

// Elke handler krijgt de gebruiker, een repository en de request-data, en geeft { status, jsonBody } terug.

async function listChildren({ user, repo }) {
  return { status: 200, jsonBody: await repo.listChildren(user.id) };
}

async function createChild({ user, repo, body }) {
  const child = { id: newId(), ...v.parseChild(body, newId) };
  await repo.saveChild(user.id, child);
  return { status: 201, jsonBody: child };
}

async function updateChild({ user, repo, params, body }) {
  const id = v.parseId(params.id);
  const existing = await repo.getChild(user.id, id);
  if (!existing) throw new HttpError(404, 'Kind niet gevonden.');
  const child = { id, ...v.parseChild(body, newId) };

  // Verwijderde contracten nemen hun uren mee.
  const kept = new Set(child.contracts.map((k) => k.id));
  const removed = existing.contracts.map((k) => k.id).filter((cid) => !kept.has(cid));
  if (removed.length) await repo.deleteEntriesOfContracts(user.id, removed);

  await repo.saveChild(user.id, child);
  return { status: 200, jsonBody: child };
}

async function deleteChild({ user, repo, params }) {
  const id = v.parseId(params.id);
  const existing = await repo.getChild(user.id, id);
  if (existing) {
    await repo.deleteEntriesOfContracts(user.id, existing.contracts.map((k) => k.id));
    await repo.deleteChild(user.id, id);
  }
  return { status: 204 };
}

async function listEntries({ user, repo, query }) {
  return { status: 200, jsonBody: await repo.listEntriesOfMonth(user.id, v.parseMonth(query.month)) };
}

async function createEntry({ user, repo, body }) {
  const data = v.parseEntry(body);
  const children = await repo.listChildren(user.id);
  if (!children.some((c) => c.contracts.some((k) => k.id === data.contractId))) throw new HttpError(400, 'Dat contract bestaat niet.');
  const entry = { id: `${data.date}_${newId()}`, ...data };
  await repo.saveEntry(user.id, entry);
  return { status: 201, jsonBody: entry };
}

async function deleteEntry({ user, repo, params }) {
  await repo.deleteEntry(user.id, v.parseEntryId(params.id));
  return { status: 204 };
}

module.exports = { listChildren, createChild, updateChild, deleteChild, listEntries, createEntry, deleteEntry };
