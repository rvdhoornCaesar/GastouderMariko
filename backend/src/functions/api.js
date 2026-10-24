const { app } = require('@azure/functions');
const { authorize } = require('../auth');
const { HttpError } = require('../errors');
const { createRepo } = require('../repo');
const handlers = require('../handlers');

let repo;
const getRepo = () => (repo ||= createRepo(process.env.TABLES_CONNECTION || process.env.AzureWebJobsStorage));

function route(name, methods, path, handler) {
  app.http(name, {
    methods,
    route: path,
    authLevel: 'anonymous', // toegang loopt via Static Web Apps + ALLOWED_USERS
    handler: async (request, context) => {
      try {
        const db = getRepo();
        const user = await authorize(request.headers, db);
        const body = ['POST', 'PUT'].includes(request.method) ? await request.json().catch(() => { throw new HttpError(400, 'Ongeldige JSON.'); }) : undefined;
        const res = await handler({ user, repo: db, env: process.env, params: request.params, query: Object.fromEntries(request.query), body });
        return res;
      } catch (e) {
        // Geweigerde toegang loggen we (naar Application Insights) om problemen met inloggen te kunnen vinden.
        if (e instanceof HttpError && (e.status === 401 || e.status === 403)) context.warn(`${e.status} ${request.method} ${new URL(request.url).pathname}: ${e.message} ${JSON.stringify(e.extra || {})}`);
        if (e instanceof HttpError) return { status: e.status, jsonBody: { error: e.message, ...e.extra } };
        context.error(e);
        return { status: 500, jsonBody: { error: 'Er ging iets mis.' } };
      }
    },
  });
}

route('listChildren', ['GET'], 'children', handlers.listChildren);
route('createChild', ['POST'], 'children', handlers.createChild);
route('updateChild', ['PUT'], 'children/{id}', handlers.updateChild);
route('deleteChild', ['DELETE'], 'children/{id}', handlers.deleteChild);
route('listEntries', ['GET'], 'entries', handlers.listEntries);
route('createEntry', ['POST'], 'entries', handlers.createEntry);
route('deleteEntry', ['DELETE'], 'entries/{id}', handlers.deleteEntry);
route('getSettings', ['GET'], 'settings', handlers.getSettings);
route('putRates', ['PUT'], 'settings/rates', handlers.putRates);
route('putOpening', ['PUT'], 'settings/opening', handlers.putOpening);
route('putUsers', ['PUT'], 'settings/users', handlers.putUsers);
