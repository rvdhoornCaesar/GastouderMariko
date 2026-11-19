# Gastouder Uren

Online urenregistratie voor gastouder Mariko: meerdere kinderen, per kind meerdere contracten (eigen uurtarief of algemeen tarief, optioneel vaste uren per maand), meerdere registraties per dag, openingstijden met toeslag daarbuiten, maandoverzicht met bedragen, CSV-export en afdrukken.

```
frontend/   Statische site (vanilla HTML/JS) + staticwebapp.config.json (routes: Microsoft-login voor `/api/ms/*`)
backend/    Azure Functions-code (Node.js 22, v4-model) met Azure Table Storage; draait als managed functions in de Static Web App
infra/      Bicep: Static Web App (Free) + Storage
```

## Architectuur

- **Frontend:** Azure Static Web App. De pagina is openbaar (het inlogscherm); alle gegevens zitten achter de API, die inloggen vereist: Microsoft (Entra ID, `/api/ms/*`) of een lokaal account (`/api/*`, zie hieronder).
- **Backend:** de Functions-code uit `backend/` draait als *managed functions* binnen dezelfde Static Web App (Free-tier). De frontend roept `/api/...` aan; Static Web App stuurt de ingelogde gebruiker mee en de pipeline levert de API vooraf gebouwd aan (`api/`, zonder tests en dev-dependencies).
- **Toegang:** iedereen met een Microsoft-account kan inloggen, maar de API laat alleen toegestane e-mailadressen toe: de *beheerders* uit de app-setting `ALLOWED_USERS` (kunnen nooit buitengesloten worden) plus de gebruikers die in de app bij *Instellingen* zijn toegevoegd. Zijn beide lijsten leeg, dan komt niemand erin.
- **Opslag:** Azure Table Storage, tabellen `children` (kind + contracten) en `entries` (uren, `RowKey` = `JJJJ-MM-DD_id`). Alle toegestane gebruikers van een omgeving delen dezelfde gegevens (`PartitionKey` is altijd `main`). Ook de instellingen (tabel `settings`) staan hier.

### Gegevens per administratie

De gegevens van een administratie (kinderen, contracten, uren en instellingen) staan in Table Storage onder de PartitionKey van die administratie; de eerste administratie heet `main`. De repo (`backend/src/repo.js`) is aan precies één administratie gebonden: `createRepo(verbinding, id)` of `repo.forInstance(id)`. De API bindt de repo aan het `instanceId` van de ingelogde gebruiker voordat een handler draait; de handlers kunnen dus alleen bij de gegevens van die administratie, en de id komt nooit uit een verzoek. Daarbovenop controleert de repo bij elke lijst dat elke rij van de eigen administratie is, en een ontbrekend of ongeldig `instanceId` geeft geen toegang. Accounts, sessies, inlogpogingen en Microsoft-identiteiten zijn bewust gedeeld. Dat dit klopt wordt bewezen in `backend/test/isolation.test.js` (twee en drie administraties naast elkaar, elke methode kruislings).

### API

| Methode | Pad | Doel |
|---|---|---|
| GET / POST | `/api/children` | kinderen ophalen / kind toevoegen (`firstName, lastName, birthDate, parents[2], contracts[{ start, end, number, rate, monthlyHours, schedule, paidHolidays }], holidays[{ from, to }]`) |
| PUT / DELETE | `/api/children/{id}` | kind (met contracten) opslaan / verwijderen; verwijderde contracten nemen hun uren mee |
| GET | `/api/entries?month=JJJJ-MM` | uren van een maand |
| POST | `/api/entries` | uren toevoegen (`date, contractId, start, end, note`) |
| DELETE | `/api/entries/{id}` | uren verwijderen |
| GET | `/api/settings` | algemene tarieven, openingstijden, eigen kinderen, toegevoegde gebruikers, beheerders en het ingelogde adres |
| PUT | `/api/settings/rates` | lijst algemene tarieven opslaan (`{ rates: [{ from, to, rate }] }`; `to` is tot en met; periodes mogen niet overlappen) |
| PUT | `/api/settings/opening` | openingstijden en toeslagfactor opslaan (`{ days: [7 × { open, from, to }], factor }`, maandag eerst) |
| PUT | `/api/settings/start-date` | begindatum van de gastouder opslaan (`{ startDate: "JJJJ-MM-DD" }`, `null` of leeg wist hem); uren ervoor worden genegeerd |
| PUT | `/api/settings/vacations` | vakantie van de gastouder opslaan (`{ vacations: [{ from, to, note }] }`; `to` is tot en met, `note` optioneel) |
| PUT | `/api/sick-days` | gastouder ziek melden of ongedaan maken voor één dag (`{ date, sick }`; ook voor gebruikers, permissie `entries:write`) |
| POST | `/api/import/planning` | eenmalige import uit het Excel-planningsbestand (`{ file: <xlsx als base64>, apply? }`; alleen platformbeheerder die lid-beheerder is van de huidige organisatie; zonder `apply` alleen een voorbeeld) |
| PUT | `/api/settings/care-types` | welke soorten opvang de gastouder doet (`{ careTypes: ['gastouder','bso'] }`; alleen soorten die een van haar bureaus aanbiedt; beheerder) |
| PUT | `/api/settings/agency-rates` | tarieven per gastouderbureau en soort opvang (`{ agencyRates: [{ agencyId, type, from, to, rate }] }`; beheerder) |
| PUT | `/api/settings/agencies` | aansluitingen van de gastouder bij gastouderbureaus met periodes (`{ links: [{ agencyId, from, to }] }`, datums optioneel, `to` is t/m; ook nog `{ agencyIds }`; beheerder). Het antwoord bevat `agencyWarnings`: de periodes met meer dan twee bureaus tegelijk |
| POST / PUT | `/api/agencies`, `/api/agencies/{id}` | gedeelde lijst gastouderbureaus beheren (`{ name }`, `{ name?, active? }`; alleen platformbeheerder) |
| PUT | `/api/settings/own-children` | eigen kinderen opslaan (`{ ownChildren: [{ firstName, birthDate }] }`) |
| PUT | `/api/settings/users` | lijst toegevoegde gebruikers opslaan (`{ users: [email] }`) |

## Lokaal draaien

Vereist Node.js 22 (`engines` in `backend/package.json`; de bouwstap van Static Web Apps kiest zijn Node-versie daaruit), [Azure Functions Core Tools](https://learn.microsoft.com/azure/azure-functions/functions-run-local) en de [SWA CLI](https://azure.github.io/static-web-apps-cli/).

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
- **Eigen kinderen:** voornaam en geboortedatum van je eigen kinderen. Ze tellen mee voor het maximum aantal kinderen dat je tegelijk mag opvangen; de app toont daarbij de regels als infotekst en een indicatie van het aantal plekken voor gastkinderen (6 min de eigen kinderen onder 8 jaar). De infotekst volgt [Ondernemersplein/RVO](https://ondernemersplein.overheid.nl/wetten-en-regels/eisen-aan-gastouders/#art:hoeveel-kinderen-mag-een-gastouder-opvangen) (per dag maximaal 6 kinderen van 0 tot 13 jaar tegelijk; maximaal 5 tot 4 jaar, 4 tot 2 jaar en 2 baby's tot 1 jaar; eigen kinderen tot 8 jaar tellen mee) en staat in `frontend/index.html`; pas die tekst aan als de regels wijzigen. Daaronder staat de opmerking dat ook vriendjes en vriendinnetjes onder de 13 jaar die komen spelen meetellen (ook in de tuin); dat komt van de gastouder zelf en staat niet op de Ondernemersplein-pagina. De indicatie rekent de staffels voor jonge kinderen niet door.
  **Melding bij te veel kinderen tegelijk:** de app telt per tijdstip hoeveel kinderen tegelijk aanwezig zijn (op basis van de ingevulde uren van alle kinderen, plus de eigen kinderen onder 8 jaar, die de hele dag meetellen; één kind telt één keer) en waarschuwt bij meer dan 6, meer dan 5 jonger dan 4 jaar, meer dan 4 jonger dan 2 jaar of meer dan 2 jonger dan 1 jaar. De melding verschijnt tijdens het invullen van de uren (ook bij tijden die uit de vaste tijden zijn ingevuld), boven de lijst van die dag en als regel in het maandoverzicht. Invullen blijft altijd mogelijk. Vriendjes en vriendinnetjes die komen spelen worden niet bijgehouden en tellen dus niet mee in de berekening; eigen kinderen worden ook in de staffels voor jonge kinderen meegeteld (voorzichtig gerekend).
- **Standaard kind bij Uren invullen:** het formulier selecteert het eerste kind waarvoor die dag nog geen uren zijn ingevuld, met een contract dat die dag loopt. Na het toevoegen springt het naar het volgende kind. Kies je zelf een kind, dan blijft dat staan tot je van dag wisselt of uren toevoegt. Hebben alle kinderen met een lopend contract al uren, dan blijft de keuze staan. De vaste tijden van dat kind worden ingevuld.
- **Compact invullen en bewerken:** elke registratie is één regel (kind, tijden, opmerking, uren). Met ✎ bewerk je kind/contract, tijden en opmerking op de regel zelf (Enter slaat op, Escape annuleert); ✎ in het Overzicht opent dezelfde registratie bij Uren invullen. Het formulier om uren toe te voegen staat op één regel, zodat een dag met zes kinderen met het formulier op één laptopscherm past. API: `PUT /api/entries/{id}` (bij een andere datum krijgt de registratie een nieuw id) en `POST /api/entries-batch` (1 tot 100 registraties tegelijk).
- **Geplande uren overnemen (Overzicht):** per kind en maand een knop die de dagen van die maand tot en met vandaag invult volgens de vaste tijden van het contract, voor dagen waarvoor dat kind nog niets heeft ingevuld. Vakantiedagen van het kind of de gastouder, dagen vóór de begindatum en contracten met vaste uren per maand worden overgeslagen. Je bevestigt eerst het aantal dagen en uren; daarna pas je de registraties zo nodig aan met ✎.
- **Volgorde van de dag:** de registraties van een dag staan alfabetisch op naam van het kind, en bij hetzelfde kind op begintijd. Een nieuwe registratie komt dus op de juiste plek te staan.
- **Navigeren bij Uren invullen:** naast ‹ en › (vorige of volgende dag) springen « en » naar de vorige of volgende *openingsdag*: een dag waarop je volgens de openingstijden open bent en geen vakantie hebt.
- **Begindatum gastouder:** vanaf wanneer je gastouder bent in de app. Alles van vóór die datum wordt genegeerd: de server laat uren van daarvoor weg en weigert nieuwe uren ervoor (bestaande uren worden niet verwijderd, ze zijn weer zichtbaar als je de datum wist of vervroegt), geplande en doorbetaalde uren beginnen op die datum, en je kunt er niet naartoe navigeren (Uren invullen, Overzicht en Kalender stoppen bij de begindatum; dagen ervoor staan grijs). Vaste uren per maand tellen vanaf de maand van de begindatum, niet naar rato. API: `PUT /api/settings/start-date` (`{ startDate }`, `null` wist hem).
- **Laden en logo:** duurt een verzoek aan de server langer dan een kwart seconde (bijvoorbeeld bij het wisselen van tabblad), dan wordt het oude scherm gedimd en draait er een rondje in het midden (`#spinner`, met een verborgen tekst *Laden…* voor schermlezers; bij *minder beweging* draait het langzamer). Bovenaan staat het logo (een huisje met een hartje, `frontend/logo.svg`). Het icoon voor het tabblad en het beginscherm: `favicon.svg`, `favicon-32.png`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png` en `manifest.webmanifest` (de app kan zo op het beginscherm van een telefoon worden gezet); `logo-square.svg` is de bron van het iOS-icoon. De PNG's zijn uit de SVG gemaakt; pas je de SVG aan, maak ze dan opnieuw.
- **Volgorde van kinderen:** in het weekoverzicht en de namen in de maandkalender, in de lijst en de samenvatting bij Overzicht en bij Uren invullen staan de kinderen alfabetisch (op voornaam; binnen een dag daarna op begintijd).
- **Foto per kind:** bij Kinderen (bewerken) kun je een foto kiezen. De browser snijdt hem vierkant uit en verkleint hem tot 128 × 128 JPEG (maximaal ca. 28 KB); de server accepteert alleen een klein JPEG als data-URL (veld `photo` van het kind, `null` = geen). De foto staat bij het kind in de tabel `children`, is per organisatie en zit in de JSON-export. Bij Kalender (week) staat *Foto's tonen* (standaard uit, per browser onthouden) en bij Kinderen staat de foto naast de naam. Een bijwerking zonder `photo` laat de foto staan; `photo: null` verwijdert hem.
- **Financieel, lijngrafiek:** één cumulatieve lijn per jaar (januari t/m december, het totaal t/m die maand), zodat je jaren met elkaar vergelijkt. Het gekozen jaar staat bovenop en heeft de eerste kleur; de eerdere jaren lopen vanaf het jaar van de begindatum van de gastouder (anders van de eerste registratie, `firstEntry` in de instellingen), maximaal tien jaar. De legenda toont het totaal per jaar en de tooltip per maand de stand van elk jaar. Het huidige jaar is doorgetrokken t/m deze maand en gestippeld daarna (verwachting). De kolommen en de tabel blijven per gekozen jaar.
- **Import uit Excel (Admin):** eenmalige import van historische gegevens uit het planningsbestand van de gastouder (blad *Kinderen* en één of meer bladen waarvan de naam alleen een jaartal is; bladen als *2024 uren* worden niet gelezen). Het bestand wordt op de server gelezen (eigen kleine xlsx-lezer in `backend/src/xlsx.js`, zonder extra pakketten). Heeft het bestand meer jaren, dan kies je eerst welk(e) jaar je importeert (`years` in het verzoek; zonder keuze toont het voorbeeld alles, maar de app vraagt eerst om een keuze). Per kind komt er (als het kind nog niet bestaat, op voor- plus achternaam) een kind met geboortedatum en per gekozen jaar waarin het kind uren heeft een contract voor het hele jaar met het contractnummer uit het bestand, zonder vaste tijden en zonder eigen tarief; de ingevulde tijden per dag (vier of vijf kinderen per dag, "Vrij" en "Week" worden overgeslagen) worden geschreven uren. Eerst een voorbeeld, dan bevestigen. Er wordt alleen toegevoegd (niets gewijzigd of verwijderd). Is een jaar al deels met de hand ingevuld, dan komt er niets dubbel: heeft het kind die dag al uren (bij welk contract ook), dan wordt de dag overgeslagen (met dezelfde tijden telt het als *al aanwezig*; met andere tijden wordt dat apart gemeld, met voorbeelden), uren komen bij een bestaand contract dat die dag dekt en er komt alleen een nieuw jaarcontract voor dagen die geen enkel contract dekt. Nogmaals importeren voegt dus niets toe. Uren buiten het jaar of vóór de begindatum, en kinderen die niet op het blad *Kinderen* staan, worden overgeslagen en gemeld. De import werkt in de organisatie waarin je zit; maak vooraf een back-up (workflow *backup*). Met het vinkje *Alleen t/m vandaag importeren* (standaard aan; `until` in het verzoek) worden uren na vandaag overgeslagen, omdat die nog planning zijn; later kun je zonder het vinkje de rest importeren.
- **Gastouderbureaus:** een gedeelde lijst voor alle organisaties, bijgehouden door platformbeheerders in het tabblad Admin (toevoegen, naam wijzigen, op niet-actief zetten; verwijderen kan niet, omdat contracten ernaar verwijzen). De rijen staan in de tabel `organisations` onder PartitionKey `agencies`, dus de back-up neemt ze mee. Bij Instellingen vinkt de gastouder aan bij welke bureaus ze is aangesloten (instelling `agencyIds`, per organisatie). Bij elk contract (tabblad Kinderen) is optioneel één van die bureaus te kiezen (`agencyId`); de server weigert een bureau waarbij de gastouder niet is aangesloten, behalve een verwijzing die al bestond. De bureaus van de gastouder staan ook in de JSON-export.
- **Soorten opvang (gastouder en bso) en drie niveaus van tarieven:** een gastouderbureau doet gastouder, bso of beide (platformbeheer stelt dat per bureau in; bureaus zonder opgave doen gastouder). De gastouder vinkt bij Instellingen aan welke soorten ze doet; alleen soorten die minstens één van haar bureaus aanbiedt zijn te kiezen, de keuze staat in `careTypes` (leeg = alle soorten van haar bureaus; zolang er nog geen bureau is gekozen geldt alleen gastouder). Is een soort niet beschikbaar of uitgezet, dan kun je er nergens tarieven of nieuwe contracten voor aanmaken (bestaande blijven gewoon werken). Een contract heeft een soort (`type`, standaard gastouder; een kind heeft per periode één soort, wisselt het dan komt er een nieuw contract) en een bureau dat die soort doet. Tarieven, het meest specifieke wint: het tarief van het contract, dan het tarief van het bureau voor die soort (`agencyRates`, met periodes), dan het algemene tarief van die soort (`rates` heeft nu een `type`, bestaande tarieven zijn gastouder). Bij het contract staat welk tarief geldt en waar het vandaan komt. Het maximum van twee bureaus telt per soort opvang (aanname, nog uit te zoeken). Bestaande gegevens: alle contracten en tarieven zijn gastouder; er verandert geen bedrag.
- **Onboarding:** een nieuwe organisatie (aangemaakt door platformbeheer) kan pas kinderen toevoegen als er een gastouderbureau is gekozen; tot die tijd staat er een banner *Eerste stap* en is *Kind toevoegen* uit (`needsAgency` bij de organisatie). Bestaande organisaties zijn vrijgesteld (met alleen een banner zolang ze geen bureau hebben). De import uit Excel is vrijgesteld.
- **Aansluitingen met periodes en het maximum van twee bureaus:** bij Instellingen geef je per gastouderbureau op van wanneer tot en met wanneer de gastouder is aangesloten (leeg = open; een bureau kan meerdere periodes hebben). Oude gegevens (alleen een lijst bureaus) tellen als aansluiting zonder begin en einde. Volgens de Wet kinderopvang (art. 1.56c, Stb. 2025, 164) mag een gastouder per voorziening bij ten hoogste **twee** gastouderbureaus zijn aangesloten, bij een overstap tijdelijk drie (Besluit Stb. 2025, 427); overschrijdingen die voortkomen uit overeenkomsten tussen ouders en bureau van vóór de inwerkingtreding mogen blijven bestaan (art. 3.2c). Is de gastouder in een periode bij meer dan twee verschillende bureaus tegelijk aangesloten, dan toont Instellingen een waarschuwing met die periode (een waarschuwing, geen blokkade: er zijn uitzonderingen). Alleen vanaf de ingangsdatum telt de waarschuwing: `LIMIT.from` in `backend/src/agency-links.js`, nu 1 juli 2026 (volgens de VNG en de Rijksoverheid; niet in het Staatsblad zelf nagelopen, pas het daar aan als het koninklijk besluit iets anders zegt).
- **Kinderen zonder lopend contract:** bij Kinderen staan alleen kinderen met een contract dat vandaag loopt in de lijst. Kinderen waarvan het contract is afgelopen, pas later begint, of die nog geen contract hebben, staan onderaan onder het ingeklapte kopje *Kinderen zonder lopend contract (n)*, met erbij waarom (bijvoorbeeld "laatste contract afgelopen op …"). Bewerken kan ook vanuit dat kopje; er verdwijnt niets, het is alleen een weergave.
- **Contracten bij een kind:** afgelopen contracten (t/m datum voorbij) staan in het kindscherm standaard ingeklapt, met de periode en een label *afgelopen* in de kop. Zelf open- of dichtklappen blijft zo staan tijdens het bewerken; een nieuw contract staat open.
- **Gastouder ziek melden:** bij Uren invullen staat onder de dag de knop *Gastouder ziek melden* (en *Ziekmelding ongedaan maken*). Een ziekmelding geldt voor één dag, wordt per administratie bewaard (instelling `sickDays`, ook in de JSON-export) en werkt overal als een dag zonder opvang: gearceerd rood en *ziek* in de week-, maand- en jaarkalender, geen geplande uren, overgeslagen bij *Past het?*, waarschuwing bij uren op die dag, en bij Overzicht een regel met de ziekmeldingen van de maand. Vakantie gaat voor als beide gelden. Vóór de begindatum kan niet ziek worden gemeld. Staan er die dag al uren, dan vraagt de app eerst of die verwijderd moeten worden: *Uren verwijderen en ziek melden*, *Uren laten staan en ziek melden* (ze blijven dan staan met een waarschuwing) of *Annuleren*.
- **Vakantie gastouder:** periodes (van, tot en met, optionele omschrijving) waarin je zelf geen opvang geeft. In de kalender staan die dagen als *vakantie* (gearceerd, in Beschikbaarheid gesloten), er worden voor die dagen geen uren gepland en *Past het?* slaat ze over. Ingevulde uren blijven staan; bij Uren invullen en in de lijst staat een waarschuwing. Het verandert niets aan het overzicht met bedragen. Vakantie van een kind staat nog bij het kind zelf (tabblad Kinderen).
- **Openingstijden en toeslag:** per weekdag open of gesloten, met een van- en tottijd, plus een *factor buiten openingstijden* (2 = dubbel tarief, 1 = geen toeslag). Een registratie wordt per minuut verdeeld: binnen de openingstijden geldt het tarief, daarbuiten tarief × factor; op een gesloten dag valt alles buiten de openingstijden. Het overzicht toont per contract hoeveel uur buiten de openingstijden viel. Dit geldt voor geregistreerde uren, niet voor vaste uren per maand.
- **Toegestane gebruikers:** iedereen in deze lijst kan inloggen en ziet dezelfde gegevens. Wie niet in de lijst staat, krijgt na het inloggen het scherm *Geen toegang*. Een toegevoegde gebruiker kan zichzelf niet verwijderen.

**Vaste beheerders in de code:** naast `ALLOWED_USERS` staat er een lijst `CODE_ADMINS` in `backend/src/auth.js`. Die adressen zijn altijd admin en kunnen niet buitengesloten worden, ook niet als de omgevingsvariabele wordt overschreven. Ze staan in de app bij de beheerders. Wijzigen kan alleen met een codewijziging en een deploy.

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
  - *Vast aantal uren per maand:* het overzicht en de CSV tellen die uren elke maand mee waarin het contract loopt (een maand telt als de contractperiode die maand raakt, niet naar rato), tegen het tarief van het contract of het algemene tarief op de eerste dag van de maand. Geregistreerde uren van dat contract tellen niet extra (je schrijft immers de uren die je al vast krijgt); alleen wat je méér schrijft dan de vaste uren van die maand komt erbij (in het jaaroverzicht en bij Financieel als *extra*). De CSV-export toont nog wel alle regels afzonderlijk plus de vaste regel.
- **Vakanties:** een lijst met periodes (van, t/m). Of een vakantie wordt doorbetaald, hangt van het contract af:
  - **Vast aantal uren per maand:** vakanties zijn altijd doorbetaald; de vaste uren tellen elke maand vol mee. De optie staat dan aan en is niet te wijzigen.
  - **Vaste tijden en *Vakanties doorbetalen* aan:** op elke vakantiedag van het kind binnen de contractperiode tellen de uren van die weekdag (volgens de vaste tijden) mee, tegen het tarief van die dag. Heb je op zo'n dag al zelf uren ingevuld voor dat contract, dan telt alleen wat je invulde. Het overzicht toont per contract hoeveel daarvan doorbetaalde vakantie is en lijst de dagen op; de CSV bevat ze met de opmerking *Doorbetaalde vakantie*.
  - **Geen vaste uren en geen vaste tijden:** er wordt niets automatisch berekend; je vult de uren in vakanties zelf in. De optie is dan niet te kiezen. Vakanties die vóór de vorige maand eindigden, staan verborgen en zijn zichtbaar met *Toon eerdere vakanties*. Vakanties zijn voorlopig alleen informatie: ze beïnvloeden de berekening niet.

Kinderen en contracten uit een eerdere versie hebben nog geen startdatum, t/m datum of achternaam; bij het eerstvolgende opslaan vraagt de app daarom om die in te vullen.

### Kalender (week, maand, jaar)
Het tabblad **Kalender** toont de uren per kind in drie weergaven, met `‹ ›` om te bladeren en *Vandaag*:

- **Week:** per dag welke kinderen er zijn, met begin- en eindtijd en het aantal uren, plus een weektotaal per kind.
- **Maand:** een kalender met een week per regel, met per dag de kinderen, tijden en uren en een weektotaal aan het eind van de regel. Tik op een dag om die week te openen. Onder de kalender staat het maandtotaal per kind.
- **Jaar:** een regel per maand en een kolom per kind, met totalen (standaard het huidige jaar), alleen voor kinderen die in dat jaar uren hebben (geschreven, gepland of vast). Het maandtotaal en het weektotaal tonen ook alleen kinderen met uren.

**Geschreven of gepland:** *geschreven* uren zijn ingevuld (volle kleur, label *geschreven*). *Gepland* uren (stippellijn, cursief, label *gepland*) komen uit de vaste tijden van het contract, voor dagen vanaf vandaag waarvoor nog niets is ingevuld, en voor voorbije dagen **na de laatst geschreven uren van dat kind** (de uren worden meestal pas aan het eind van de maand of begin van de volgende maand geschreven; kinderen die van dag wisselen krijgen zo geen plan voor oude dagen die ze niet kwamen), en uit doorbetaalde vakanties. Voorbije dagen worden niet verder terug dan de eerste dag van de vorige maand gepland. Heeft een kind in de laatste maanden nog niets geschreven, dan geldt gewoon dat hele venster (de vorige en de huidige maand). Zodra je voor zo'n dag iets invult, vervalt de planning voor dat kind op die dag. Contracten met een vast aantal uren per maand hebben geen tijden; die uren staan als *vast* in het maand- en jaaroverzicht. Staat er voor een contract op een dag wel iets ingevuld, dan telt alleen dat.

**Leeftijd (kleur):** met het vinkje *Leeftijd tonen (kleur)* krijgt elk kind een kleur naar leeftijd op de dag zelf (jonger dan 1 jaar, 1 jaar, 2–3 jaar, 4–7 jaar, 8 jaar en ouder), met de leeftijd erbij als tekst. De keuze wordt in de browser onthouden.

**Beschikbaarheid:** met de knop *Beschikbaarheid* draait elk overzicht om en toont het per dag hoeveel plekken er nog vrij zijn: het maximum van 6 kinderen tegelijk, min de aanwezige kinderen en de eigen kinderen onder 8 jaar, op het drukste moment van de dag (geschreven en geplande uren). Daaronder staan regels voor de plekken voor jonge kinderen (2–3 jaar, 1 jaar, baby) als die lager zijn. Groen = 2 of meer vrij, oranje = 1 vrij, rood = vol, grijs = gesloten volgens de openingstijden. Week: per dag de blokken met dezelfde aanwezigen; maand: een vak per dag; jaar: een rij per maand met een vakje per dag. Vaste uren per maand hebben geen tijden en tellen hier niet mee.

**Waarschuwing te veel kinderen:** op een dag met te veel kinderen tegelijk (geschreven of gepland: meer dan 6, meer dan 5 jonger dan 4 jaar, meer dan 4 jonger dan 2 jaar of meer dan 2 jonger dan 1 jaar) staat een ⚠️ in alle weergaven en overzichten, met de reden bij het icoon. In de maand staat onder het totaal welke dagen het zijn; in het jaar staat het aantal dagen bij de maand (Kinderen) of een ⚠️ in het dagvakje (Beschikbaarheid).

### Financieel
Het tabblad **Financieel** (voor elke rol, net als de bedragen in het Overzicht) toont per jaar, met ‹ › en *Dit jaar* om te wisselen:

1. **Opbrengst per kind per maand:** een regel per maand, een kolom per kind, met totalen per maand, per kind en per jaar. Het bedrag is uren × uurprijs, met de toeslag buiten de openingstijden, voor *geschreven* uren, *geplande* uren (vaste tijden vanaf vandaag en na de laatst geschreven uren, en doorbetaalde vakanties) en *vaste* uren per maand. Waar meer dan alleen geschreven uren in zitten, staat de uitsplitsing eronder. Kinderen zonder uren in dat jaar staan er niet bij. Is er voor sommige uren geen tarief bekend, dan telt dat als € 0 en staat er een waarschuwing.
2. **Grafiek met de opbrengst per maand**, met een schakelaar tussen *Kolommen* (per maand gestapeld: geschreven, vast, gepland) en *Lijn (cumulatief)*: maart is januari + februari + maart. In de lijn is het deel t/m de huidige maand doorgetrokken en het verwachte deel gestippeld. Beweeg over een maand (of kies hem met het toetsenbord) voor de bedragen; de tabel erboven bevat alle waarden. De keuze kolommen of lijn wordt in de browser onthouden.

De begindatum en de vakantie van de gastouder gelden ook hier (er worden geen uren gepland op die dagen of ervoor).

### Past het?
Het tabblad **Past het?** (voor elke rol; er wordt niets opgeslagen) test of een extra kind of een ander rooster past:

- **Nieuw kind:** optionele naam, geboortedatum (nodig voor de regels voor jonge kinderen), gewenste dagen en tijden, startdatum en optionele einddatum.
- **Bestaand kind aanpassen:** kies een kind; het huidige rooster wordt ingevuld en vervangt de *geplande* uren van dat kind in de periode (vakanties van het kind blijven vrij, ingevulde uren blijven staan).

De uitkomst staat per gevraagde weekdag: *past*, *past niet altijd* of *past niet*. Past het niet, dan staat erbij vanaf wanneer het wel past, welke losse dagen of perioden niet passen (met tijden en reden: meer dan 6 kinderen, of een staffel voor jonge kinderen) en welke tijden op alle dagen wel passen. Gecontroleerd wordt vanaf vandaag met dezelfde regels als de waarschuwing in de kalender, op basis van geschreven en geplande uren van de andere kinderen en de eigen kinderen onder 8 jaar. Zonder einddatum loopt de controle tot de laatste einddatum van een bestaand contract (minimaal 8 weken, maximaal 2 jaar). Vaste uren per maand hebben geen tijden en tellen niet mee.

### Inloggen met een lokaal account

Naast Microsoft kan een gebruiker inloggen met een account dat alleen in deze app bestaat (e-mailadres + wachtwoord).

- **Beheer:** een beheerder of admin maakt accounts aan bij *Instellingen → Lokale accounts*. Het tijdelijke wachtwoord wordt één keer getoond; de gebruiker moet het bij de eerste keer inloggen wijzigen. Wachtwoord vergeten: de beheerder zet een nieuw tijdelijk wachtwoord (de gebruiker wordt overal uitgelogd).
- **Wachtwoorden:** nooit leesbaar opgeslagen. Alleen een scrypt-hash (N=65536, r=8, p=2, eigen salt per wachtwoord) staat in tabel `accounts`. Regels: 12–128 tekens, niet afgeleid van het e-mailadres, geen gangbare woorden.
- **Sessies:** na inloggen een willekeurige sleutel in een `HttpOnly`/`Secure`/`SameSite=Strict`-cookie (`gu_session`, 7 dagen). In tabel `sessions` staat alleen de SHA-256 van die sleutel, dus een uitgelezen database levert geen bruikbare sessies op. Wachtwoord wijzigen beëindigt de andere sessies. Wijzigende verzoeken vereisen daarnaast de header `X-Requested-With` (CSRF).
- **Gokken tegen gegaan:** na 5 mislukte pogingen per e-mailadres volgt een blokkade van 15 minuten (steeds langer, maximaal een dag); ook bij onbekende adressen, zodat niet te zien is of een account bestaat.
- **Twee routesets:** `/api/ms/*` vereist een Microsoft-login (afgedwongen door Static Web Apps) en `/api/*` werkt met de sessiecookie. De sessieroutes negeren `x-ms-client-principal`, omdat die header op een openbare route door iedereen te vervalsen is. Accountbeheer staat op beide routesets, dus ook een beheerder met een lokaal account kan het; zet 2FA aan op die accounts.
- **Tweestapsverificatie (TOTP):** een lokale gebruiker kan bij *Instellingen → Mijn account* een authenticator-app koppelen (RFC 6238, 6 cijfers). Bij het inloggen volgt na het wachtwoord een codestap; een code werkt maar één keer en foute codes tellen mee voor dezelfde blokkade. Bij het aanzetten krijgt de gebruiker 8 herstelcodes (eenmalig, alleen als hash opgeslagen). Het TOTP-geheim moet terug te lezen zijn en staat daarom versleuteld (AES-256-GCM) in de opslag. De sleutel is de app-setting `TOTP_KEY`: de pipeline maakt er bij de eerste deploy van een omgeving een willekeurige aan en behoudt hem daarna uit de Static Web App zelf (hij staat dus niet in GitHub of de repository en verschilt per omgeving). Hij staat los van de opslagsleutel, dus een uitgelezen opslagaccount geeft de 2FA-geheimen niet prijs. Wijzig of verwijder hem niet: dan moeten gebruikers hun 2FA opnieuw instellen. Alleen lokaal zonder `TOTP_KEY` wordt een sleutel afgeleid van `TABLES_CONNECTION`. Later kan dit naar Azure Key Vault, zodra de API een eigen identiteit heeft (Standard-plan of eigen Function App). Een beheerder die een nieuw tijdelijk wachtwoord instelt, zet 2FA van dat account ook uit (telefoon kwijt en geen herstelcodes). Voor Microsoft-logins regelt Microsoft zelf of er MFA is; zet dat aan op beheerdersaccounts.
- **Organisaties en rollen:** een gebruiker (e-mailadres) kan lid zijn van meerdere organisaties (administraties), met per organisatie een rol. Alle rechten staan op één plek (`backend/src/permissions.js`) en de server controleert ze bij elk verzoek; het verbergen van tabbladen in de pagina is alleen weergave.

  | Rol (per organisatie) | Mag |
  | --- | --- |
  | `gebruiker` | uren invullen en het overzicht zien (kinderen, contracten en tarieven alleen lezen), plus het tabblad Account (wachtwoord en 2FA). Geen Kinderen of Instellingen. |
  | `beheerder` | alles wat de app biedt in die organisatie: kinderen, contracten, instellingen, toegestane gebruikers en de lokale accounts van die organisatie. |

  **Platformbeheer** (de vaste gebruikers uit `ALLOWED_USERS` en de code, of een lokaal account met de vlag `platformAdmin`) is een eigenschap van de persoon, los van een organisatie. Het geeft het tabblad Admin (dat later organisaties aanmaken en beheren krijgt), maar geen toegang tot de gegevens van een organisatie: daarvoor moet je lid zijn.

  **Welke organisatie?** De pagina stuurt bij elk verzoek de gekozen organisatie mee (header `X-Organisatie`, met een keuzelijst in de kop als je er meer hebt). De server accepteert alleen een organisatie waar je lid van bent en die actief is; anders een 403, nooit stilzwijgend een andere organisatie. Zonder header is het de eerste organisatie op naam. De rol komt uit het lidmaatschap van die organisatie.

  **Accountbeheer** (aanmaken, rol wijzigen, nieuw tijdelijk wachtwoord, verwijderen) doet een beheerder voor de leden van de eigen organisatie, met grenzen die de server afdwingt: nooit je eigen lidmaatschap, en alleen rollen tot en met de eigen rol. Een account is van de persoon: voeg je een adres toe dat al een account heeft (bijvoorbeeld in een andere organisatie), dan wordt alleen het lidmaatschap toegevoegd en houdt de persoon zijn eigen wachtwoord. Een wachtwoord of 2FA resetten kan alleen als het account in geen enkele andere organisatie lid is, anders zou een beheerder via een nieuw wachtwoord in een andere organisatie kunnen komen. Verwijderen haalt het lidmaatschap weg; het account zelf verdwijnt pas als de persoon nergens meer lid is.

  **Overstap naar organisaties (eenmalig, automatisch):** de eerste keer dat de nieuwe versie een verzoek krijgt en er nog geen organisatie `main` bestaat, worden de lidmaatschappen gevuld uit de oude gegevens zodat niemand toegang verliest: elk lokaal account wordt lid van `main` met zijn rol (`admin` wordt beheerder, en het account blijft platformbeheerder), de oude lijst Toegestane gebruikers en de vaste gebruikers worden lid als beheerder. De organisatie "Gastouder Mariko" (id `main`) wordt als laatste aangemaakt; stopt het halverwege, dan gaat de volgende poging verder zonder iets dubbel te doen of een bestaande rol te overschrijven. De gegevens zelf (kinderen, uren, instellingen) blijven onder `main` staan en worden niet aangeraakt, en de oude velden en lijsten blijven bestaan. **Terugdraaien** is de vorige versie deployen: die werkt weer op de ongewijzigde oude gegevens (wijzigingen in lidmaatschappen sinds de overstap gelden dan niet). **Vooraf bekijken:** *Actions → Back-up en herstel (tabellen) → plan-organisaties* toont, alleen lezend en met gedeeltelijk afgeschermde adressen, wie er lid wordt met welke rol. Maak vóór de eerste deploy een back-up (zie hieronder).
- **Organisaties beheren (tabblad Admin, alleen platformbeheer):** organisaties aanmaken (de id wordt uit de naam gemaakt met een willekeurig einde en verandert nooit), hernoemen en een beheerder toevoegen, met een Microsoft-account of een lokaal account (tijdelijk wachtwoord, één keer te zien; heeft het adres al een account, dan wordt alleen het lidmaatschap toegevoegd). Platformbeheer ziet alleen de organisaties zelf (naam, aantal leden), nooit de gegevens erin.
- **Verwijderen in twee stappen:** *Verwijderen* zet een organisatie op "verwijderd": de leden raken direct hun toegang kwijt, de gegevens blijven 30 dagen staan en *Terugzetten* kan. *Definitief verwijderen* kan pas na die 30 dagen en vraagt de id van de organisatie ter bevestiging; het wist alleen de gegevens van die organisatie (kinderen, uren, instellingen, lidmaatschappen) en de accounts van personen die daarna nergens meer lid zijn. Dat is onomkeerbaar behalve via een eerdere back-up, dus maak er vooraf een (zie hieronder).
- **Export per organisatie:** een beheerder downloadt bij *Instellingen → Gegevens downloaden* alles van de eigen organisatie als JSON (kinderen, contracten, alle uren, instellingen, leden). Platformbeheer kan dit bewust niet voor andere organisaties.
- **Voorbereid op later:** de overstap bij verwijderen zonder handmatig definitief verwijderen (nu altijd een bewuste handeling).
- Controleer na de eerste deploy op test dat inloggen (cookie) via Static Web Apps werkt; zo niet, dan is een token in een header het alternatief.

### Back-up en herstel van de gegevens

Alle gegevens staan in Azure Table Storage (één storage account per omgeving). Table Storage heeft zelf geen herstel in de tijd en geen prullenbak, dus de app maakt zelf kopieën.

- **Back-up maken:** GitHub, *Actions → Back-up en herstel (tabellen) → Run workflow*, omgeving kiezen, opdracht `backup` en eventueel een omschrijving (bijvoorbeeld "voor migratie"). Voor production vraagt GitHub om goedkeuring, net als bij een deploy.
- **Wat er gebeurt:** elke tabel wordt gekopieerd naar een tabel `bak<tijdstip><naam>` in hetzelfde storage account (bijvoorbeeld `bak20261115t093012children`), met een tabel `bak<tijdstip>meta` met per tabel het aantal rijen en een controlesom. Na elke kopie wordt gecontroleerd dat die gelijk is aan de bron; is dat niet zo, dan mislukt de opdracht. De bestaande gegevens worden niet gewijzigd en niets wordt verwijderd. Sessies en inlogpogingen worden niet meegenomen: ze bevatten niets om te bewaren en terugzetten kan ingetrokken sessies heropenen. Back-ups worden nooit automatisch opgeruimd.
- **Overzicht:** opdracht `list` toont de back-ups met tijdstip, omschrijving en aantal rijen per tabel.
- **Voorbeeld van de overstap naar organisaties:** opdracht `plan-organisaties` schrijft niets en toont wie er lid wordt met welke rol (zie hierboven).
- **Terugzetten:** opdracht `restore` met het id uit `list`. Zonder `apply` is het een proefrun: er verandert niets en je ziet per tabel hoeveel rijen er zouden worden toegevoegd of gewijzigd. Met `apply` wordt eerst een nieuwe back-up van de huidige stand gemaakt (zodat ook een herstel terug te draaien is) en daarna teruggezet. Rijen die nieuwer zijn dan de back-up blijven staan, tenzij je ook `replace` aanzet. Een beschadigde back-up (controlesom klopt niet) wordt niet teruggezet.
- **Beperking:** de kopieën van de tabellen worden na elkaar gemaakt, niet op precies hetzelfde moment. Maak een back-up daarom liever op een rustig moment, en bij een migratie vlak ervoor.
- **Lokaal of vanuit Cloud Shell:** `TABLES_CONNECTION=<verbinding> node backend/scripts/backup-tables.js backup|list|restore` (zie het begin van dat bestand voor de opties).
- **Eenmalig, handmatig:** zet een verwijderslot op het storage account van production, zodat het niet per ongeluk kan worden verwijderd. Dat kan de pipeline niet zelf, want daarvoor zijn eigenaarsrechten nodig:
  `az lock create --name geen-verwijderen --lock-type CanNotDelete --resource-group GastouderMariko --resource-name <naam van het storage account> --resource-type Microsoft.Storage/storageAccounts`
  (de naam van het account staat bij de resourcegroep in de portal, `gastouderprd…`; voor test `GastouderMarikoTest` en `gastoudertst…`). Het slot beschermt het account, niet de tabellen zelf: tabellen kunnen alleen via de app of met de sleutel worden gewist, en daarvoor zijn de back-ups.

### Kosten en aandachtspunten

- Static Web App **Free** met managed functions kost niets, ook niet voor twee omgevingen; het storage-account kost bij dit gebruik centen per maand. Grenzen van Free: 100 GB bandwidth per maand, alleen HTTP-triggers, geen VNet. Test kun je tussendoor verwijderen (resource group weggooien); de pipeline maakt hem bij de volgende run opnieuw aan.
- De vooraf ingestelde Microsoft-login van Static Web Apps accepteert werk- en schoolaccounts (Entra ID). Heeft Mariko alleen een persoonlijk Microsoft-account, dan is een eigen app-registratie nodig (custom auth provider).
- De Bicep-template en de deploy-pipeline zijn niet tegen een echte Azure-omgeving uitgevoerd; controleer na de eerste deploy of `/api/children` ingelogd werkt en uitgelogd een 401 geeft.

### Node-versie

CI, de deploy-pipeline en de API in de Static Web App draaien op **Node.js 22** (LTS). De bouwstap van Static Web Apps (Oryx) gebruikt voor de API Node 22, ook als `engines` hoger is; daarom staat alles op 22: `engines` in `backend/package.json`, `apiRuntime` in `frontend/staticwebapp.config.json` en `node-version` in de workflows. Bij Instellingen staat onderaan op welke Node-versie de API echt draait. Gaat Static Web Apps later Node 24 ondersteunen, pas die drie plekken dan samen aan. De GitHub-acties zelf (`checkout`, `setup-node`, `azure/login`) draaien op Node 24.

### Later opschalen
De API-code is gewone Azure Functions en staat los van de hosting. Groeit het gebruik of heb je een eigen Function App nodig (scaling, monitoring, VNet), dan:
1. Zet de SKU van de Static Web App in `infra/main.bicep` op `Standard` (ca. € 9 per maand per omgeving).
2. Voeg een Function App (Consumption, Node 22) toe met dezelfde app-settings (`TABLES_CONNECTION`, `ALLOWED_USERS`) en een `Microsoft.Web/staticSites/linkedBackends`-resource die ernaar verwijst.
3. Deploy `backend/` naar die Function App (`Azure/functions-action`) en haal `api_location` uit de Static Web App-deploy; managed functions en een gekoppelde backend kunnen niet naast elkaar bestaan.

De frontend (`/api/...`), de login en de data in Table Storage veranderen niet.
