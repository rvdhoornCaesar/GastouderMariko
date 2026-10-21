# Gastouder Uren

Online urenregistratie voor gastouder Mariko: meerdere kinderen, per kind meerdere contracten (eigen uurtarief), meerdere registraties per dag, maandoverzicht met bedragen, CSV-export en afdrukken.

```
frontend/   Statische site (vanilla HTML/JS) + staticwebapp.config.json (Microsoft-login)
backend/    Azure Functions (Node.js 20, v4-model) met Azure Table Storage
infra/      Bicep: Static Web App + Function App (Consumption) + Storage
```

## Architectuur

- **Frontend:** Azure Static Web App. Alle pagina's en `/api/*` vereisen login via Microsoft (Entra ID).
- **Backend:** aparte Function App op het Consumption-plan, gekoppeld aan de Static Web App (*linked backend*). De frontend roept `/api/...` aan; Static Web App stuurt de ingelogde gebruiker mee.
- **Toegang:** iedereen met een Microsoft-account kan inloggen, maar de API laat alleen e-mailadressen uit de app-setting `ALLOWED_USERS` toe. Staat die leeg, dan komt niemand erin.
- **Opslag:** Azure Table Storage, tabellen `children` (kind + contracten) en `entries` (uren, `RowKey` = `JJJJ-MM-DD_id`). Data is per gebruiker gescheiden (`PartitionKey`).

### API

| Methode | Pad | Doel |
|---|---|---|
| GET / POST | `/api/children` | kinderen met contracten ophalen / kind toevoegen |
| PUT / DELETE | `/api/children/{id}` | kind (met contracten) opslaan / verwijderen; verwijderde contracten nemen hun uren mee |
| GET | `/api/entries?month=JJJJ-MM` | uren van een maand |
| POST | `/api/entries` | uren toevoegen (`date, contractId, start, end, pause, note`) |
| DELETE | `/api/entries/{id}` | uren verwijderen |

## Lokaal draaien

Vereist Node.js 20+, [Azure Functions Core Tools](https://learn.microsoft.com/azure/azure-functions/functions-run-local) en de [SWA CLI](https://azure.github.io/static-web-apps-cli/).

```bash
cd backend
npm install
cp local.settings.json.example local.settings.json   # zet bij ALLOWED_USERS het adres dat je in de SWA-emulator invult
npx azurite-table --location .azurite &              # lokale Table Storage
cd ..
swa start frontend --api-location backend --run "cd backend && func start" --api-devserver-url http://localhost:7071
```

Open daarna http://localhost:4280 (de SWA CLI emuleert de login).

Tests (draaien tegen Azurite, wordt automatisch gestart): `cd backend && npm test`.

## Omgevingen en deployen naar Azure

Er zijn twee volledig gescheiden omgevingen, **test** en **production**: elk met een eigen resource group, Function App, Static Web App en storage-account (dus ook gescheiden data en eigen URL).

De pipeline (`.github/workflows/deploy.yml`, hergebruikt `_deploy.yml`):

```
push naar main → tests → deploy test → (goedkeuring) → deploy production
```

Bij elke deploy worden de resources uit `infra/main.bicep` aangemaakt of bijgewerkt, daarna gaan de backend en de frontend erheen. Inloggen bij Azure gaat via OIDC; er zijn geen wachtwoorden of publish profiles. Handmatig starten kan via *Actions → Deploy → Run workflow*; standaard rolt dat alleen naar **test** uit (vink `only_test` uit om ook production te doen). Zo kun je ook een branch op test uitproberen.

**Eenmalige set-up** (zodra je de subscription hebt):

1. **App-registratie voor GitHub** (Entra ID → App registrations, of `az ad app create`) met twee *federated credentials* voor GitHub Actions, repository `rvdhoornCaesar/GastouderMariko`:
   - entity type *Environment*, naam `test`
   - entity type *Environment*, naam `production`

   (Wil je test en production in aparte subscriptions of met aparte app-registraties, maak er dan twee.)
2. **Rol toekennen** aan die app (service principal): *Contributor* op de subscription, of op de vooraf aangemaakte resource groups.
3. **GitHub-environments** `test` en `production` aanmaken (Settings → Environments). Zet bij `production` *Required reviewers* aan: de pipeline wacht dan op jouw goedkeuring voordat hij naar productie gaat.
4. **Per environment** instellen (Settings → Environments → *test* / *production*):
   - Secrets: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`
   - Variable `ALLOWED_USERS`: komma-gescheiden e-mailadressen die de omgeving mogen gebruiken. Voor test kun je bijvoorbeeld alleen jezelf opnemen, voor production Mariko.
   - Optioneel: `AZURE_RESOURCE_GROUP` (standaard `gastouder-test-rg` / `gastouder-production-rg`) en `AZURE_LOCATION` (standaard `westeurope`)
5. Run de workflow. De frontend-URL van elke omgeving staat in de samenvatting van de run.

**Validatie van de infra:** `.github/workflows/validate-infra.yml` draait bij elke pull request die `infra/` raakt. Hij compileert en lint de Bicep (geen Azure nodig). Zodra de Azure-login voor `test` is ingesteld en de resource group bestaat, draait hij ook `az deployment group validate` (voor test én production) en een what-if voor test, zonder iets te wijzigen. Heeft de service principal geen toegang of bestaat de resource group nog niet, dan blijft het bij compileren.

Handmatig één omgeving aanmaken kan ook: `az deployment group create -g <rg> -f infra/main.bicep -p allowedUsers=mariko@voorbeeld.nl environmentName=test`.

### Kosten en aandachtspunten

- Een eigen Function App koppelen aan een Static Web App vereist de **Standard**-tier (ca. € 9 per maand **per omgeving**, dus ca. € 18 voor test + production). De Function Apps op Consumption en Table Storage kosten bij dit gebruik vrijwel niets. Test kun je tussendoor verwijderen (resource group weggooien); de pipeline maakt hem bij de volgende run opnieuw aan.
- De vooraf ingestelde Microsoft-login van Static Web Apps accepteert werk- en schoolaccounts (Entra ID). Heeft Mariko alleen een persoonlijk Microsoft-account, dan is een eigen app-registratie nodig (custom auth provider).
- De Bicep-template en de deploy-pipeline zijn niet tegen een echte Azure-omgeving uitgevoerd; controleer na de eerste deploy of `/api/children` ingelogd werkt en uitgelogd een 401 geeft.
