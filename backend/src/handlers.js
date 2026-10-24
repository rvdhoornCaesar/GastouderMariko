const { HttpError } = require('./errors');
const { fixedUsers } = require('./auth');
const v = require('./validation');

const newId = () => Math.random().toString(36).slice(2, 10).padEnd(8, '0');

// Elke handler krijgt de gebruiker, een repository en de request-data, en geeft { status, jsonBody } terug.
// Alle gegevens zijn gedeeld door de toegestane gebruikers van de omgeving.

async function listChildren({ repo }) {
  return { status: 200, jsonBody: await repo.listChildren() };
}

async function createChild({ repo, body }) {
  const child = { id: newId(), ...v.parseChild(body, newId) };
  await repo.saveChild(child);
  return { status: 201, jsonBody: child };
}

async function updateChild({ repo, params, body }) {
  const id = v.parseId(params.id);
  const existing = await repo.getChild(id);
  if (!existing) throw new HttpError(404, 'Kind niet gevonden.');
  const child = { id, ...v.parseChild(body, newId) };

  // Verwijderde contracten nemen hun uren mee.
  const kept = new Set(child.contracts.map((k) => k.id));
  const removed = existing.contracts.map((k) => k.id).filter((cid) => !kept.has(cid));
  if (removed.length) await repo.deleteEntriesOfContracts(removed);

  await repo.saveChild(child);
  return { status: 200, jsonBody: child };
}

async function deleteChild({ repo, params }) {
  const id = v.parseId(params.id);
  const existing = await repo.getChild(id);
  if (existing) {
    await repo.deleteEntriesOfContracts(existing.contracts.map((k) => k.id));
    await repo.deleteChild(id);
  }
  return { status: 204 };
}

async function listEntries({ repo, query }) {
  return { status: 200, jsonBody: await repo.listEntriesOfMonth(v.parseMonth(query.month)) };
}

async function createEntry({ repo, body }) {
  const data = v.parseEntry(body);
  const children = await repo.listChildren();
  if (!children.some((c) => c.contracts.some((k) => k.id === data.contractId))) throw new HttpError(400, 'Dat contract bestaat niet.');
  const entry = { id: `${data.date}_${newId()}`, ...data };
  await repo.saveEntry(entry);
  return { status: 201, jsonBody: entry };
}

async function deleteEntry({ repo, params }) {
  await repo.deleteEntry(v.parseEntryId(params.id));
  return { status: 204 };
}

// Instellingen: algemene tarieven en toegestane gebruikers.
// "fixedUsers" komen uit de app-setting ALLOWED_USERS en kunnen niet in de app worden verwijderd.
async function getSettings({ user, repo, env }) {
  const opening = (await repo.getOpening()) || v.DEFAULT_OPENING;
  return { status: 200, jsonBody: { rates: await repo.getRates(), users: await repo.getUsers(), fixedUsers: fixedUsers(env), me: user.email, opening, ownChildren: await repo.getOwnChildren(), runtime: process.version } };
}

async function putRates({ repo, body }) {
  const rates = v.parseRates(body && body.rates, newId);
  await repo.setRates(rates);
  return { status: 200, jsonBody: { rates } };
}

async function putOwnChildren({ repo, body }) {
  const ownChildren = v.parseOwnChildren(body && body.ownChildren, newId);
  await repo.setOwnChildren(ownChildren);
  return { status: 200, jsonBody: { ownChildren } };
}

async function putOpening({ repo, body }) {
  const opening = v.parseOpening(body);
  await repo.setOpening(opening);
  return { status: 200, jsonBody: { opening } };
}

async function putUsers({ user, repo, env, body }) {
  const fixed = fixedUsers(env);
  const users = v.parseUsers(body && body.users).filter((e) => !fixed.includes(e));
  if (!user.fixed && !users.includes(user.email)) throw new HttpError(400, 'Je kunt jezelf niet verwijderen.');
  await repo.setUsers(users);
  return { status: 200, jsonBody: { users } };
}

module.exports = { listChildren, createChild, updateChild, deleteChild, listEntries, createEntry, deleteEntry, getSettings, putRates, putOpening, putOwnChildren, putUsers };
