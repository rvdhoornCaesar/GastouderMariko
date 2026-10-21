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

## Deployen naar Azure

Eén pipeline (`.github/workflows/deploy.yml`) doet bij elke push naar `main` (of handmatig via *Run workflow*): tests draaien, de resources uit `infra/main.bicep` aanmaken of bijwerken, de backend naar de Function App en de frontend naar de Static Web App uitrollen. Inloggen bij Azure gaat via OIDC; er zijn geen wachtwoorden of publish profiles nodig.

**Eenmalige set-up** (zodra je de subscription hebt):

1. **App-registratie voor GitHub** (Entra ID → App registrations → New, of `az ad app create`), met een *federated credential* voor GitHub Actions:
   - Organization/repository: `rvdhoornCaesar/GastouderMariko`
   - Entity type: *Environment*, naam `production`
2. **Rol toekennen** aan die app (service principal): *Contributor* op de subscription, of op een vooraf aangemaakte resource group.
3. **GitHub-environment** `production` aanmaken (Settings → Environments); optioneel met *required reviewers* als je een goedkeuringsstap voor elke deploy wilt.
4. **Secrets** (Settings → Secrets and variables → Actions → Secrets): `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`.
5. **Variables** (zelfde plek → Variables):
   - `ALLOWED_USERS`: komma-gescheiden e-mailadressen die de app mogen gebruiken (bijv. `mariko@voorbeeld.nl`)
   - `AZURE_RESOURCE_GROUP` (optioneel, standaard `gastouder-rg`) en `AZURE_LOCATION` (optioneel, standaard `westeurope`)
6. Run de workflow. De frontend-URL staat in de samenvatting van de run.

Handmatig kan ook: `az deployment group create -g <rg> -f infra/main.bicep -p allowedUsers=mariko@voorbeeld.nl`.

### Kosten en aandachtspunten

- Een eigen Function App koppelen aan een Static Web App vereist de **Standard**-tier (ca. € 9 per maand). De Function App op Consumption en Table Storage kosten bij dit gebruik vrijwel niets.
- De vooraf ingestelde Microsoft-login van Static Web Apps accepteert werk- en schoolaccounts (Entra ID). Heeft Mariko alleen een persoonlijk Microsoft-account, dan is een eigen app-registratie nodig (custom auth provider).
- De Bicep-template en de deploy-pipeline zijn niet tegen een echte Azure-omgeving uitgevoerd; controleer na de eerste deploy of `/api/children` ingelogd werkt en uitgelogd een 401 geeft.
