const { app } = require('@azure/functions');
const { getUser } = require('../auth');
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
        const user = getUser(request.headers);
        const body = request.method === 'POST' || request.method === 'PUT' ? await request.json().catch(() => { throw new HttpError(400, 'Ongeldige JSON.'); }) : undefined;
        const res = await handler({ user, repo: getRepo(), params: request.params, query: Object.fromEntries(request.query), body });
        return res;
      } catch (e) {
        if (e instanceof HttpError) return { status: e.status, jsonBody: { error: e.message } };
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
