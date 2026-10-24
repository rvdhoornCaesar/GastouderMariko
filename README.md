# Gastouder Uren

Online urenregistratie voor gastouder Mariko: meerdere kinderen, per kind meerdere contracten (eigen uurtarief of algemeen tarief, optioneel vaste uren per maand), meerdere registraties per dag, openingstijden met toeslag daarbuiten, maandoverzicht met bedragen, CSV-export en afdrukken.

```
frontend/   Statische site (vanilla HTML/JS) + staticwebapp.config.json (Microsoft-login)
backend/    Azure Functions-code (Node.js 20, v4-model) met Azure Table Storage; draait als managed functions in de Static Web App
infra/      Bicep: Static Web App (Free) + Storage
```

## Architectuur

- **Frontend:** Azure Static Web App. Alle pagina's en `/api/*` vereisen login via Microsoft (Entra ID).
- **Backend:** de Functions-code uit `backend/` draait als *managed functions* binnen dezelfde Static Web App (Free-tier). De frontend roept `/api/...` aan; Static Web App stuurt de ingelogde gebruiker mee en de pipeline levert de API vooraf gebouwd aan (`api/`, zonder tests en dev-dependencies).
- **Toegang:** iedereen met een Microsoft-account kan inloggen, maar de API laat alleen toegestane e-mailadressen toe: de *beheerders* uit de app-setting `ALLOWED_USERS` (kunnen nooit buitengesloten worden) plus de gebruikers die in de app bij *Instellingen* zijn toegevoegd. Zijn beide lijsten leeg, dan komt niemand erin.
- **Opslag:** Azure Table Storage, tabellen `children` (kind + contracten) en `entries` (uren, `RowKey` = `JJJJ-MM-DD_id`). Alle toegestane gebruikers van een omgeving delen dezelfde gegevens (`PartitionKey` is altijd `main`). Ook de instellingen (tabel `settings`) staan hier.

### API

| Methode | Pad | Doel |
|---|---|---|
| GET / POST | `/api/children` | kinderen ophalen / kind toevoegen (`firstName, lastName, birthDate, parents[2], contracts[{ start, end, number, rate, monthlyHours, schedule, paidHolidays }], holidays[{ from, to }]`) |
| PUT / DELETE | `/api/children/{id}` | kind (met contracten) opslaan / verwijderen; verwijderde contracten nemen hun uren mee |
| GET | `/api/entries?month=JJJJ-MM` | uren van een maand |
| POST | `/api/entries` | uren toevoegen (`date, contractId, start, end, note`) |
| DELETE | `/api/entries/{id}` | uren verwijderen |
| GET | `/api/settings` | algemene tarieven, openingstijden, toegevoegde gebruikers, beheerders en het ingelogde adres |
| PUT | `/api/settings/rates` | lijst algemene tarieven opslaan (`{ rates: [{ from, to, rate }] }`; `to` is tot en met; periodes mogen niet overlappen) |
| PUT | `/api/settings/opening` | openingstijden en toeslagfactor opslaan (`{ days: [7 × { open, from, to }], factor }`, maandag eerst) |
| PUT | `/api/settings/users` | lijst toegevoegde gebruikers opslaan (`{ users: [email] }`) |

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

Er zijn twee volledig gescheiden omgevingen, **test** en **production**: elk met een eigen resource group, Static Web App en storage-account (dus ook gescheiden data en eigen URL).

De pipeline (`.github/workflows/deploy.yml`, hergebruikt `_deploy.yml`):

```
push naar main → tests → deploy test → (goedkeuring) → deploy production
```

Bij elke deploy worden de resources uit `infra/main.bicep` aangemaakt of bijgewerkt, daarna gaan de frontend en de API (managed functions) erheen. Inloggen bij Azure gaat via OIDC; er zijn geen wachtwoorden of publish profiles. Handmatig starten kan via *Actions → Deploy → Run workflow*; standaard rolt dat alleen naar **test** uit (vink `only_test` uit om ook production te doen). Zo kun je ook een branch op test uitproberen.

**Eenmalige set-up** (zodra je de subscription hebt):

1. **App-registratie voor GitHub** (Entra ID → App registrations, of `az ad app create`) met twee *federated credentials* voor GitHub Actions, repository `rvdhoornCaesar/GastouderMariko`:
   - entity type *Environment*, naam `test`
   - entity type *Environment*, naam `production`

   (Wil je test en production in aparte subscriptions of met aparte app-registraties, maak er dan twee.)
2. **Rol toekennen** aan die app (service principal): *Contributor* op de subscription, of op de vooraf aangemaakte resource groups.
3. **GitHub-environments** `test` en `production` aanmaken (Settings → Environments). Zet bij `production` *Required reviewers* aan: de pipeline wacht dan op jouw goedkeuring voordat hij naar productie gaat.
4. **Per environment** instellen (Settings → Environments → *test* / *production*):
   - Secrets: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`
   - Variable `ALLOWED_USERS`: komma-gescheiden e-mailadressen van de *beheerders*: zij hebben altijd toegang. Meer gebruikers voeg je daarna in de app toe. Voor test kun je bijvoorbeeld alleen jezelf opnemen, voor production Mariko.
   - `AZURE_RESOURCE_GROUP`: naam van de (al aangemaakte) resource group van deze omgeving. Bestaat hij niet, dan maakt de pipeline hem aan (standaard `gastouder-<omgeving>-rg`).
   - Optioneel: `AZURE_LOCATION` (standaard `westeurope`) voor de resources zelf
5. Run de workflow. De frontend-URL van elke omgeving staat in de samenvatting van de run.

**Validatie van de infra:** `.github/workflows/validate-infra.yml` draait bij elke pull request die `infra/` raakt. Hij compileert en lint de Bicep (geen Azure nodig). Zodra de Azure-login voor `test` is ingesteld en de resource group bestaat, draait hij ook `az deployment group validate` (voor test én production) en een what-if voor test, zonder iets te wijzigen. Heeft de service principal geen toegang of bestaat de resource group nog niet, dan blijft het bij compileren.

Handmatig één omgeving aanmaken kan ook: `az deployment group create -g <rg> -f infra/main.bicep -p allowedUsers=mariko@voorbeeld.nl environmentName=test`.

### Eigen domein (gastouderuren.nl)
**test** hoort bij `test.gastouderuren.nl` en **production** bij `invullen.gastouderuren.nl`; de namen staan in `.github/workflows/deploy.yml` (`domain:`). Het kale domein `gastouderuren.nl` blijft vrij voor een informatiesite. De DNS staat bij de registrar (Versio/PCextreme) en beheer je zelf. Bij elke deploy koppelt de pipeline het domein aan de Static Web App (idempotent) en zet in de samenvatting van de run welke DNS-records nog nodig zijn. Die stap laat de deploy nooit falen; de status verschijnt als waarschuwing.

Per omgeving is één `CNAME`-record nodig bij de registrar:

| Naam | Type | Waarde |
|---|---|---|
| `test` | CNAME | de standaard-hostnaam van de test-Static Web App (`happy-rock-0e5676603.5.azurestaticapps.net`) |
| `invullen` | CNAME | de standaard-hostnaam van de production-Static Web App (staat in de samenvatting van de eerste production-run) |

1. Zet het record **vóór** de koppeling: Azure controleert bij het koppelen of het CNAME bestaat. Staat het er nog niet, dan faalt de koppeling zonder de deploy te breken; zet het record en draai de workflow opnieuw (*Actions → Deploy → Run workflow*; production alleen met `only_test` uitgevinkt).
2. Draai de workflow opnieuw tot de status *Ready* is. Het HTTPS-certificaat regelt Azure zelf (gratis). Inloggen met Microsoft werkt op het eigen domein zonder extra instellingen.
3. Sommige DNS-panelen willen de waarde met een punt aan het eind (`...azurestaticapps.net.`); gebruik wat het paneel vraagt.

### Instellingen in de app
Op het tabblad **Instellingen** beheer je:
- **Algemeen uurtarief:** een lijst met periodes (van, tot en met, € per uur), bijvoorbeeld 1-1 t/m 31-12. “Tot en met” leeg = doorlopend; periodes mogen niet overlappen. De periode van het huidige jaar staat vet. Een contract zonder eigen tarief gebruikt het algemene tarief dat geldt op de datum van elke registratie; een contract met eigen tarief houdt dat. Is er voor een datum geen tarief bekend, dan telt het bedrag als € 0 en toont het overzicht een waarschuwing.
- **Openingstijden en toeslag:** per weekdag open of gesloten, met een van- en tottijd, plus een *factor buiten openingstijden* (2 = dubbel tarief, 1 = geen toeslag). Een registratie wordt per minuut verdeeld: binnen de openingstijden geldt het tarief, daarbuiten tarief × factor; op een gesloten dag valt alles buiten de openingstijden. Het overzicht toont per contract hoeveel uur buiten de openingstijden viel. Dit geldt voor geregistreerde uren, niet voor vaste uren per maand.
- **Toegestane gebruikers:** iedereen in deze lijst kan inloggen en ziet dezelfde gegevens. Wie niet in de lijst staat, krijgt na het inloggen het scherm *Geen toegang*. Een toegevoegde gebruiker kan zichzelf niet verwijderen.

De *beheerders* uit de GitHub-variabele `ALLOWED_USERS` (Settings → Environments → *test* / *production* → Variables, komma-gescheiden, hoofdletters maken niet uit) staan ook in die lijst, gemarkeerd als beheerder, en kunnen niet in de app worden verwijderd. Zo kun je jezelf nooit buitensluiten. Wijzig je die variabele, dan pas je de beheerders aan na een nieuwe deploy (*Actions → Deploy → Run workflow*, of *Re-run*).

De pagina zelf is voor elk ingelogd Microsoft-account te laden, maar bevat geen gegevens: alle data zit achter de API, en die controleert de toegang. Wil je de pagina ook blokkeren, dan kan dat met rollen/uitnodigingen van Static Web Apps.

### Monitoring (Application Insights)
Elke omgeving krijgt een Application Insights-resource (workspace-based, 30 dagen bewaard, plafond van 0,1 GB per dag, dus kosten rond nul). De API stuurt requests, fouten en logregels daar naartoe; geweigerde toegang (401/403) wordt gelogd met het adres dat de server zag. Kijk in de Azure Portal bij de resource group → Application Insights → *Logs* of *Failures*, bijvoorbeeld:

```kusto
traces | where message startswith "403" or message startswith "401" | order by timestamp desc
requests | where resultCode >= 400 | project timestamp, name, resultCode | order by timestamp desc
exceptions | order by timestamp desc
```

Eenmalig nodig: de resource providers `Microsoft.OperationalInsights` en `Microsoft.Insights` moeten op de subscription geregistreerd zijn (`az provider register --namespace Microsoft.OperationalInsights`); de pipeline kan dat zelf niet, want zijn rol geldt alleen op de resource groups.

### Kinderen en contracten
Het tabblad **Kinderen** toont eerst een lijst; met *Bewerken* (of *Kind toevoegen*) open je de details. Wijzigingen worden pas bewaard met *Opslaan*.

- **Kind:** voornaam, achternaam, geboortedatum, twee ouders (namen).
- **Contracten (één of meer):** alleen de **startdatum en t/m datum zijn verplicht**. Een contract heeft geen naam; in lijsten herken je het aan de periode (en het contractnummer). Optioneel zijn: contractnummer, uurprijs (leeg = algemeen tarief), vast aantal uren per maand en vaste tijden per weekdag. Verder is er per contract de optie *Vakanties doorbetalen* (standaard uit, zie hieronder).
  - *Buiten de contractperiode:* uren invullen blijft mogelijk, maar het formulier toont een melding, de registratie krijgt een waarschuwing en het maandoverzicht telt hoeveel registraties buiten het contract vallen.
  - *Vaste tijden:* kies je een contract en een datum, dan vult het formulier de begin- en eindtijd van die weekdag alvast in.
  - *Vast aantal uren per maand:* het overzicht en de CSV tellen die uren elke maand mee waarin het contract loopt (een maand telt als de contractperiode die maand raakt, niet naar rato), tegen het tarief van het contract of het algemene tarief op de eerste dag van de maand, naast geregistreerde uren.
- **Vakanties:** een lijst met periodes (van, t/m). Of een vakantie wordt doorbetaald, hangt van het contract af:
  - **Vast aantal uren per maand:** vakanties zijn altijd doorbetaald; de vaste uren tellen elke maand vol mee. De optie staat dan aan en is niet te wijzigen.
  - **Vaste tijden en *Vakanties doorbetalen* aan:** op elke vakantiedag van het kind binnen de contractperiode tellen de uren van die weekdag (volgens de vaste tijden) mee, tegen het tarief van die dag. Heb je op zo'n dag al zelf uren ingevuld voor dat contract, dan telt alleen wat je invulde. Het overzicht toont per contract hoeveel daarvan doorbetaalde vakantie is en lijst de dagen op; de CSV bevat ze met de opmerking *Doorbetaalde vakantie*.
  - **Geen vaste uren en geen vaste tijden:** er wordt niets automatisch berekend; je vult de uren in vakanties zelf in. De optie is dan niet te kiezen. Vakanties die vóór de vorige maand eindigden, staan verborgen en zijn zichtbaar met *Toon eerdere vakanties*. Vakanties zijn voorlopig alleen informatie: ze beïnvloeden de berekening niet.

Kinderen en contracten uit een eerdere versie hebben nog geen startdatum, t/m datum of achternaam; bij het eerstvolgende opslaan vraagt de app daarom om die in te vullen.

### Kosten en aandachtspunten

- Static Web App **Free** met managed functions kost niets, ook niet voor twee omgevingen; het storage-account kost bij dit gebruik centen per maand. Grenzen van Free: 100 GB bandwidth per maand, alleen HTTP-triggers, geen VNet. Test kun je tussendoor verwijderen (resource group weggooien); de pipeline maakt hem bij de volgende run opnieuw aan.
- De vooraf ingestelde Microsoft-login van Static Web Apps accepteert werk- en schoolaccounts (Entra ID). Heeft Mariko alleen een persoonlijk Microsoft-account, dan is een eigen app-registratie nodig (custom auth provider).
- De Bicep-template en de deploy-pipeline zijn niet tegen een echte Azure-omgeving uitgevoerd; controleer na de eerste deploy of `/api/children` ingelogd werkt en uitgelogd een 401 geeft.

### Later opschalen
De API-code is gewone Azure Functions en staat los van de hosting. Groeit het gebruik of heb je een eigen Function App nodig (scaling, monitoring, VNet), dan:
1. Zet de SKU van de Static Web App in `infra/main.bicep` op `Standard` (ca. € 9 per maand per omgeving).
2. Voeg een Function App (Consumption, Node 20) toe met dezelfde app-settings (`TABLES_CONNECTION`, `ALLOWED_USERS`) en een `Microsoft.Web/staticSites/linkedBackends`-resource die ernaar verwijst.
3. Deploy `backend/` naar die Function App (`Azure/functions-action`) en haal `api_location` uit de Static Web App-deploy; managed functions en een gekoppelde backend kunnen niet naast elkaar bestaan.

De frontend (`/api/...`), de login en de data in Table Storage veranderen niet.
