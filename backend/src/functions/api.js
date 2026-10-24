const { app } = require('@azure/functions');
const { authorizeMicrosoft, authorizeSession } = require('../auth');
const { HttpError } = require('../errors');
const { createRepo } = require('../repo');
const handlers = require('../handlers');

let repo;
const getRepo = () => (repo ||= createRepo(process.env.TABLES_CONNECTION || process.env.AzureWebJobsStorage));

// Elke route bestaat in twee varianten, omdat er twee manieren van inloggen zijn:
//   /api/<pad>     lokaal account (sessiecookie). Openbaar bereikbaar; de functie controleert de sessie.
//                  x-ms-client-principal wordt hier genegeerd: die header kan op een openbare route door iedereen worden meegestuurd.
//   /api/ms/<pad>  Microsoft-login. Static Web Apps dwingt hier inloggen af (zie staticwebapp.config.json) en zet de header.
// auth: 'both' (beide), 'session' (alleen lokaal), 'ms' (alleen Microsoft), 'public' (geen login nodig: inloggen en uitloggen).
function route(name, methods, path, handler, { auth = 'both', allowMustChange = false } = {}) {
  const register = (fnName, routePath, mode) => app.http(fnName, {
    methods,
    route: routePath,
    authLevel: 'anonymous', // toegang loopt via Static Web Apps (Microsoft) of via onze eigen sessiecontrole
    handler: async (request, context) => {
      try {
        const db = getRepo();
        const unsafe = !['GET', 'HEAD'].includes(request.method);
        let user = null;
        if (mode === 'ms') user = await authorizeMicrosoft(request.headers, db);
        else if (mode === 'session') user = await authorizeSession(request.headers, request.method, db);
        else if (unsafe && !request.headers.get('x-requested-with')) throw new HttpError(403, 'Ongeldig verzoek.');
        if (user && user.mustChange && !allowMustChange) throw new HttpError(403, 'Je moet eerst je wachtwoord wijzigen.', { code: 'password_change_required' });
        let body;
        if (['POST', 'PUT'].includes(request.method)) {
          const text = await request.text();
          if (text.trim()) {
            try { body = JSON.parse(text); } catch { throw new HttpError(400, 'Ongeldige JSON.'); }
          }
        }
        return await handler({ user, repo: db, env: process.env, params: request.params, query: Object.fromEntries(request.query), body, headers: request.headers });
      } catch (e) {
        // Geweigerde toegang loggen we (naar Application Insights) om problemen met inloggen te kunnen vinden.
        if (e instanceof HttpError && [401, 403, 429].includes(e.status)) context.warn(`${e.status} ${request.method} ${new URL(request.url).pathname}: ${e.message} ${JSON.stringify(e.extra || {})}`);
        if (e instanceof HttpError) return { status: e.status, jsonBody: { error: e.message, ...e.extra } };
        context.error(e);
        return { status: 500, jsonBody: { error: 'Er ging iets mis.' } };
      }
    },
  });
  if (auth === 'both' || auth === 'session') register(name, path, 'session');
  if (auth === 'public') register(name, path, 'public');
  if (auth === 'both' || auth === 'ms') register(`${name}Ms`, `ms/${path}`, 'ms');
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
route('putOwnChildren', ['PUT'], 'settings/own-children', handlers.putOwnChildren);
route('putOpening', ['PUT'], 'settings/opening', handlers.putOpening);
route('putUsers', ['PUT'], 'settings/users', handlers.putUsers);

// Inloggen met een lokaal account
route('login', ['POST'], 'auth/login', handlers.login, { auth: 'public' });
route('loginMfa', ['POST'], 'auth/login-mfa', handlers.loginMfa, { auth: 'public' });
route('logout', ['POST'], 'auth/logout', handlers.logout, { auth: 'public' });
route('me', ['GET'], 'me', handlers.me, { allowMustChange: true });
route('changePassword', ['POST'], 'auth/change-password', handlers.changePassword, { auth: 'session', allowMustChange: true });
route('totpStart', ['POST'], 'auth/totp/start', handlers.totpStart, { auth: 'session' });
route('totpEnable', ['POST'], 'auth/totp/enable', handlers.totpEnable, { auth: 'session' });
route('totpDisable', ['POST'], 'auth/totp/disable', handlers.totpDisable, { auth: 'session' });
// Accountbeheer (recht accounts:manage: beheerder en admin, binnen hun eigen rol; zie handlers.js)
route('listAccounts', ['GET'], 'accounts', handlers.listAccounts);
route('createAccount', ['POST'], 'accounts', handlers.createAccount);
route('setAccountRole', ['PUT'], 'accounts/{email}/role', handlers.setAccountRole);
route('resetAccount', ['POST'], 'accounts/{email}/reset', handlers.resetAccount);
route('deleteAccount', ['DELETE'], 'accounts/{email}', handlers.deleteAccount);
