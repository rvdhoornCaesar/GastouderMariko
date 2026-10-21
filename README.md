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

1. **Resources aanmaken** (eenmalig):
   ```bash
   az group create -n gastouder-rg -l westeurope
   az deployment group create -g gastouder-rg -f infra/main.bicep -p allowedUsers=mariko@voorbeeld.nl
   ```
   De outputs geven de frontend-URL en de namen van de Function App en Static Web App.
2. **GitHub-secrets en -variabelen** (Settings → Secrets and variables → Actions):
   - secret `AZURE_STATIC_WEB_APPS_API_TOKEN`: `az staticwebapp secrets list -n <staticWebAppName> --query properties.apiKey -o tsv`
   - secret `AZURE_FUNCTIONAPP_PUBLISH_PROFILE`: `az functionapp deployment list-publishing-profiles -n <functionAppName> -g gastouder-rg --xml`
   - variable `AZURE_FUNCTIONAPP_NAME`: naam van de Function App
3. Een push naar `main` draait de tests en deployt backend en frontend (`.github/workflows/deploy.yml`).

### Kosten en aandachtspunten

- Een eigen Function App koppelen aan een Static Web App vereist de **Standard**-tier (ca. € 9 per maand). De Function App op Consumption en Table Storage kosten bij dit gebruik vrijwel niets.
- De vooraf ingestelde Microsoft-login van Static Web Apps accepteert werk- en schoolaccounts (Entra ID). Heeft Mariko alleen een persoonlijk Microsoft-account, dan is een eigen app-registratie nodig (custom auth provider).
- De Bicep-template en de deploy-workflows zijn niet tegen een echte Azure-omgeving uitgevoerd; controleer na de eerste deploy of `/api/children` ingelogd werkt en uitgelogd een 401 geeft.
