# Discogenius — productvisie en ontwerprichtlijnen

Dit is het leidende document voor wat Discogenius is, waarom het zo ontworpen is en hoe je een wijziging toetst. Technische details staan in `ARCHITECTURE.md`, `DATA_MODEL_TARGET.md`, `CURATION_DEDUPLICATION.md`, `TAG_IO_STRATEGY.md` en `STREAMING_PROVIDER_PLUGIN_CONTRACT.md`. Spreken die documenten dit document tegen, dan geldt dit document, en pas je het andere document aan.

Methodes en bronnen die bij het opstellen zijn gebruikt:
- J.J. Garrett, *The Elements of User Experience* (2e druk, 2011): de vijf vlakken.
- *Delft Design Guide* (BIS, 2e druk): Vision in Design (blz. 65), Problem Definition (blz. 119), Persona (blz. 115), Written Scenario (blz. 155), List of Requirements (blz. 125), Morphological Chart (blz. 171), Harris Profile (blz. 177), Product Usability Evaluation (blz. 199) en Design Roadmapping (blz. 79).
- De code van 16 referentieprojecten (zie §9).

---

## 1. Visie

**Discogenius geeft je een muziekbibliotheek die af is: juist, compleet en mooi. Je hoeft er zelf niet op te letten.**

Discogenius is een muziekbeheerder in de lijn van Lidarr. De bronnen zijn streamingdiensten, en de waarheid over muziek komt uit MusicBrainz. De app bepaalt wat je wilt hebben (slimme curatie), haalt dat op, importeert het, geeft het een naam en tags, en houdt het daarna netjes. Het resultaat is een bibliotheek die in Plex, Jellyfin, Navidrome en Kodi meteen goed werkt.

### 1.1 Wat Discogenius is
- Een **beheerder van bibliotheken**: stereo, ruimtelijk geluid (spatial) en muziekvideo, elk als eigen bibliotheek met een eigen map.
- Een **brug tussen streamingaanbod en MusicBrainz**. Elk aanbod is aantoonbaar gekoppeld aan een MB-release en MB-recording, of het blijft buiten de bibliotheek.
- Een **curator**. De app kiest de kleinste set uitgaven die de gewenste discografie dekt, en legt elke keuze uit.
- Een **bestandsbeheerder** met de volwassenheid van Lidarr: importbeslissingen, hernoemen, taggen en repareren, altijd met een logboek.

### 1.2 Wat Discogenius niet is
- Geen speler. Er zijn geen afspeellijsten, geen radio en geen afspeelwachtrij; dat doen mediaservers. Wel is er **voorluisteren**: één track afspelen om te controleren of het de juiste is.
- Geen downloader van losse links. Alles loopt via identiteit (MB) en beleid.
- Geen tagger voor willekeurige collecties. Bestanden die Discogenius niet kan koppelen, gaan naar Beoordelen. Ze worden nooit stil aangepast.

### 1.3 Voor wie
- **De verzamelaar-eigenaar.** Zet de app één keer goed in en wil daarna alleen een melding als zijn oordeel nodig is. Hij ziet slecht en gebruikt zoom of een schermlezer, dus status moet in woorden staan en acties moeten groot en eenduidig zijn.
- **De luisteraar in huis.** Merkt Discogenius alleen via Plex of Navidrome. Voor hem betekent kwaliteit: juiste artiesten, mooie hoezen, geen dubbele albums en video's bij de juiste nummers.

### 1.4 Scenario's
1. **"Klopt alles?"** Het Overzicht toont één statuswoord (Op orde / Bezig / Aandacht nodig) en één zin. Bij Aandacht nodig staat er een knop naar de eerste beslissing.
2. **"Nieuwe artiest."** Je zoekt een artiest en voegt hem toe. Hij komt in de bibliotheken die je standaard hebt ingesteld (bijvoorbeeld stereo en video, niet spatial). Curatie kiest de uitgaven. Binnen een dag is alles binnen, of je ziet per album waarom niet.
3. **"Waarom ontbreekt dit album?"** Onder Ontbrekend staat de reden: geen aanbod, onvolledig aanbod, of buiten het type-beleid. Met ▶ hoor je de versie van de dienst, en je kunt een andere bron kiezen.
4. **"Ik heb oude bestanden."** Je wijst een map aan. Discogenius herkent bijna alles automatisch. De rest staat onder Beoordelen, met een voorstel en ▶.
5. **"Plex toont het verkeerd."** Je wijzigt de naamgeving of het tagprofiel. Een proefrun laat zien wat er verandert. Na het toepassen scant de mediaserver alleen de mappen die zijn veranderd.

---

## 2. Principes
Elke ontwerpbeslissing moet hieruit te herleiden zijn.

| # | Principe | Betekenis |
|---|---|---|
| P1 | **MusicBrainz is identiteit, aanbieders zijn beschikbaarheid** | Niets komt in een bibliotheek zonder MB-anker. Aanbieders verzinnen geen albums. |
| P2 | **Toestand wordt berekend, niet opgestapeld** | Ontbrekend = gewenst − aanwezig. Werklijsten zijn een begrensde afgeleide, nooit een archief. |
| P3 | **Elke stap is herhaalbaar** | Een lus die opnieuw draait, komt op dezelfde eindstand uit. Herstel na een crash is "gewoon nog eens". |
| P4 | **Bestanden zijn heilig** | Verwijderen of overschrijven mag alleen met bewijs (een betere kopie van dezelfde recording), een logboekregel en een proefrun. Onbekende bestanden worden nooit verwijderd. |
| P5 | **Elke beslissing heeft een reden** | Weigeren, kiezen en overslaan gebeurt altijd met een leesbare reden, die in de UI zichtbaar is. |
| P6 | **De gebruiker wint** | Een handmatige keuze wordt nooit door automatiek overschreven, totdat de gebruiker zelf "terug naar automatisch" kiest. |
| P7 | **Het systeem blijft rustig** | Schrijfacties op de database duren korter dan 1 s, werk is begrensd en de app reageert altijd. |
| P8 | **Toegankelijk eerst** | Status in woorden, groot en hoog contrast, volledig met het toetsenbord te bedienen en geschikt voor een schermlezer. |
| P9 | **De kern is klein, randen zijn adapters** | Streamingdiensten, mediaservers en metadatabronnen zijn adapters met een vast contract. Kennis van één dienst zit nooit in de kern. |

---

## 3. Scope

### 3.1 In scope
| Domein | Functies |
|---|---|
| Catalogus | Artiesten, release groups, releases, tracks en recordings uit MB. Refreshen volgens regels (nieuw, oud, nog actief). Bron is de MusicBrainz-proxy van Lidarr of de eigen lokale mirror (musicbrainz-docker); beide werken al. |
| Bibliotheken | Meerdere bibliotheken per soort (stereo, spatial, video), elk met een eigen map, beleid en profielen. |
| Curatie | Type- en statusbeleid, discografie dekken met zo weinig uitgaven mogelijk, compilaties alleen voor gaten, en beslissingen van de gebruiker die blijven staan. |
| Aanbod-koppeling | Aanbod van diensten koppelen aan MB-releases en -recordings op bewijs (links, UPC/ISRC, vorm). |
| Verwerving | Zoeken naar ontbrekende uitgaven en naar uitgaven onder het kwaliteitsdoel (cutoff), een begrensde actieve wachtrij en downloaden per dienst. |
| Import | Eén beslisser voor downloads, gescande mappen en handmatige import. |
| Bestanden | Naamgeving, tags, albumhoezen, artiestfoto's, songteksten, ReplayGain, reparatie en integriteit. |
| Integraties | Gerichte scans op mediaservers. Later ook beoordelingen en afspeelgegevens lezen. |
| Voorluisteren | ▶ per track, voor een lokaal bestand of de stream van een dienst. |

### 3.2 Buiten scope
Afspeellijsten, radio, een volledige speler, sociale functies, aanbevelingen van nieuwe artiesten buiten MB-relaties (tenzij voorgesteld in §8), en torrent- of usenet-indexers.

---

## 4. Eisen (programma van eisen)
**E** = eis (moet, toetsbaar). **W** = wens (afweging).

### 4.1 Juistheid
- E1: Elk bestand in een bibliotheek heeft een MB-recording-id en een release-id.
- E2: Elk album in een bibliotheek is compleet: een editie wordt altijd in zijn geheel verworven, ook tracks die al in een andere editie aanwezig zijn. Eén bestand per recording is een streven, geen harde regel (ADR-11).
- E3: Er is hoogstens één actieve verwervingstaak per (bibliotheek, editie[, track]).
- E4: Een karaoke-, tribute- of coverversie door een ander staat nooit in voor het echte nummer. Eigen werk van de artiest (een eigen instrumentaal- of karaoke-album, of covers die de artiest zelf opnam) mag wel, als aparte recording of album (ADR-12).
- E4b: Wat niet in MusicBrainz staat, komt nooit op de verwervingslijst (P1).

### 4.2 Rust en herstel
- E5: Geen schrijftransactie duurt 1 s of langer.
- E6: Er staan hoogstens N actieve verwervingstaken tegelijk (standaard 50 per bibliotheek). Er bestaat geen onbegrensde wachtrij.
- E7: Na een herstart hervat elke lus zonder handwerk.
- E8: Elke dienst heeft een gezondheidsstatus. Zolang een dienst ongezond is, start er geen nieuw werk voor die dienst.

### 4.3 Uitleg en controle
- E9: Elke weigering of keuze heeft een reden die in de UI te zien is.
- E10: Elke verwijdering of verplaatsing staat met reden in het logboek en is per batch vooraf te bekijken met een proefrun.
- E11: Een handmatige keuze blijft staan totdat de gebruiker die zelf terugdraait.

### 4.4 Import
- E12: Een vreemde map wordt automatisch geïmporteerd als en alleen als het bewijs sluitend is: MB-release-id in de tags, één release in de catalogus, elke track eenduidig gekoppeld en de lengte binnen 10 s. Waar de tags ontbreken of twijfel bestaat, beslist de audio-vingerafdruk die al in de engine zit (AcoustID/Chromaprint, ADR-13). Eigen downloads komen binnen met hun bekende identiteit en worden alleen geverifieerd (ADR-18). Er is geen streefpercentage: het aandeel automatisch is een meetwaarde op het dashboard, geen eis.
- E13: Een twijfelgeval gaat naar Beoordelen, met het beste voorstel en de reden.

### 4.5 Bestanden en metadata
- E14: Tags werken in Plex: één ALBUMARTIST, "Various Artists" waar dat hoort, en per-track ARTIST met de credit.
- E15: Tags werken in Navidrome: ARTISTS en ALBUMARTISTS als lijsten met meerdere waarden, en MBID's.
- E16: De app kiest de albumhoes zelf, zonder instelling: de bron die de hoogste kwaliteit levert. Er is geen minimum- of doelresolutie. `cover.jpg` mag zo groot zijn als de bron levert (vaak 2000–3000 px); ingebed gaat maximaal 1200 px mee. Elke afbeelding vermeldt waar hij vandaan komt (ADR-5).
- E17: Muziekvideo's volgen de structuur van Plex (§6.6).

### 4.6 Bediening
- E18: De app werkt met een vergrootglas op 600–700% (Windows Vergrootglas of macOS Zoom), met een schermlezer en in hoog contrast. Wat dat concreet betekent, staat in ADR-17.
- E19: Met ▶ hoor je binnen 3 s geluid, in Bibliotheek, Ontbrekend en Beoordelen.
- E20: Na een wijziging vraagt de app de mediaserver om een gedeeltelijke scan van alleen de veranderde map(pen), zoals Lidarr dat doet (ADR-15). Dit is een latere fase.

### 4.7 Wensen
- W1: Nieuwe diensten en mediaservers toevoegen zonder de kern aan te passen.
- W2: Werkt zonder internet-MB. Dit kan al: de catalogus leest van de MusicBrainz-proxy van Lidarr of van de lokale musicbrainz-docker-mirror (instelbaar).
- W3: Zo min mogelijk instellingen nodig voor een goede standaard.

---

## 5. Architectuur

### 5.1 Lagen
```
          Adapters (in)                    Kern                         Adapters (uit)
 ┌─────────────────────────┐   ┌──────────────────────────────┐   ┌──────────────────────┐
 │ Metadata: MusicBrainz,  │──▶│ Catalogus (MB-model)         │   │ Mediaservers: Plex,  │
 │ CAA, fanart, lyrics     │   │ Bibliotheken + curatie        │   │ Jellyfin, Navidrome, │
 │ Bronnen: TIDAL, Apple,  │──▶│ Aanbod-koppeling              │──▶│ Kodi, Subsonic       │
 │ Deezer, YouTube, Qobuz  │   │ Verwerving · Import · Bestand │   │ Meldingen (webhook)  │
 └─────────────────────────┘   └──────────────────────────────┘   └──────────────────────┘
```

### 5.2 Domeinmodel (kort)
- **Catalogus** (gedeeld en uitsluitend MB): `ArtistMetadata`, `Albums` (release group), `AlbumEditions` (release), `Tracks`, `Recordings`, `RecordingRelations` (onder andere `music_video_for`).
- **Bibliotheek** (per bibliotheek): `Libraries` (soort, map, profielen), `LibraryArtists`, `LibraryAlbums` (gewenst), `LibraryEditions` (dekking), `LibraryVideos`, `LibraryUserExclusions`, `LibraryCurationOutcomes`.
- **Aanbod**: `ProviderItems` (cache) en de enige koppelingen `Provider{Artist,Edition,Track,Video}Matches`.
- **Plan**: `AcquisitionPlanSources` en `AcquisitionPlanTracks`, die per bibliotheek en editie vastleggen hoe die wordt verworven.
- **Bezit**: `TrackFiles` (met bibliotheek, recording, pad, kwaliteit en checksum), `UnmappedFiles`.
- **Werk**: `Commands`, met een soort, sleutel, status, voortgang en reden.

### 5.3 De lussen
Elke lus is herhaalbaar, werkt in kleine transacties en schrijft redenen weg.

| Lus | Invoer | Uitvoer | Trigger |
|---|---|---|---|
| L1 Catalogus | MB | catalogusrijen | regels per artiest (nieuw, ouder dan 30 d, nog actief en ouder dan 2 d; niet binnen 12 u) |
| L2 Aanbod | catalogi van de diensten | Provider*Matches + beschikbaarheid per editie en recording | na L1, en periodiek per dienst |
| L3 Curatie | catalogus + beschikbaarheid + beleid + gebruikersbeslissingen | LibraryAlbums/Editions + uitkomst | na L2, en bij een beleidswijziging |
| L4 Plan | gewenste edities + aanbod | AcquisitionPlan* (alleen voor gewenst) | na L3 |
| L5 Inventaris | schijf | TrackFiles, UnmappedFiles | direct per gewijzigde map (watcher); wekelijks een volledige controle (§5.3.2) |
| L6 Verwerving | **view Ontbrekend/Cutoff** + plan | maximaal N actieve downloads | doorlopend, top-N op prioriteit (§5.3.3) |
| L7 Import | download of vreemde map | TrackFiles of Beoordelen | na een download, en na L5 voor vreemde bestanden |
| L8 Organiseren | gewenste naam en tags − huidige | hernoemen/retaggen (met logboek) | na import, en bij een profielwijziging (eerst proefrun) |
| L9 Integriteit | schijf + DB | rapport: onbekend, ontbrekend, veranderd, dubbel | wekelijks en op verzoek; herstel alleen via een voorstel |
| L10 Sync | gewijzigde paden | gerichte scan per mediaserver | na L7/L8/L9, gebundeld per 30 s |

#### 5.3.1 Volgorde van de lussen
MB-discografie (L1) → catalogi van de diensten ophalen en koppelen, met beschikbaarheid per editie en recording (L2) → curatie (L3) → plannen voor wat gewenst is (L4) → verwerving (L6). De afweging staat in ADR-16.

#### 5.3.2 De inventarislus (L5) uitgelegd
- **Watcher.** Het bestandssysteem meldt elke wijziging. De app wacht tot een map 30 s stil is en leest dan alleen die map opnieuw in: nieuwe bestanden worden gekoppeld of gaan naar Unmapped, verdwenen bestanden verdwijnen uit TrackFiles.
- **Wekelijkse volledige controle.** Een watcher kan meldingen missen (netwerkshare, herstart, wijzigingen terwijl de app uit stond). Daarom loopt eens per week, 's nachts, één ronde over alle mappen. Die vergelijkt alleen grootte en wijzigingstijd; alleen afwijkende mappen worden echt opnieuw gelezen. Zo blijft de ronde licht, ook bij een grote bibliotheek.

#### 5.3.3 Prioriteit van de verwerving (top-N)
De eenheid is één album (bibliotheek + editie). De view Ontbrekend/Cutoff wordt gesorteerd op:
1. **Door de gebruiker gevraagd** (handmatig "download"): altijd eerst.
2. **Nieuwe uitgave**: verschenen in de afgelopen 30 dagen.
3. **Ontbrekend vóór cutoff**: een album dat er niet is, gaat voor een album dat er al is in mindere kwaliteit.
4. **Releasedatum**, nieuwste eerst. Dat geeft de luisteraar het snelst waarde.
5. Daarna artiestnaam en editie-id, zodat de volgorde stabiel is.

Elke cyclus pakt de eerste N die nog niet actief zijn en waarvan de dienst gezond is. Per dienst geldt een eigen maximum, zodat één trage dienst de rest niet ophoudt. De UI toont bij elk album zijn plek en de reden (bijvoorbeeld "nieuw, 3 dagen oud").

### 5.4 Werkverdeling
- Er zijn **wachtrijen per soort werk**: catalogus, aanbod, download (per dienst), import, bestand en artwork. Elke wachtrij heeft een eigen gelijktijdigheid, zoals bij Immich `QueueService`.
- Elk commando heeft een **sleutel**: (soort, bibliotheek, entiteit). Dezelfde sleutel kan maar één keer actief zijn, zoals bij Lidarr `CommandQueue` met `IsTypeExclusive`.
- **Schijfwerk** binnen een bibliotheekmap gebeurt serieel. Verschillende mappen mogen tegelijk.
- Een **watchdog** kijkt naar voortgang en niet naar de looptijd. Een taak die voortgang meldt, wordt nooit afgebroken.

### 5.5 Contract voor bronnen (streamingdiensten)
Een bron levert losse vermogens. Elk vermogen is optioneel, en de kern vraagt alleen wat er is.

| Vermogen | Functie |
|---|---|
| `auth` | Inloggen (device code of OAuth) en vernieuwen, met `health()` als status: ok, verlopen of geblokkeerd. |
| `catalog` | Artiest, albums en tracks met id's, UPC, ISRC en kwaliteitsniveaus. |
| `search` | Zoeken op artiest, album of ISRC. |
| `offers` | Voor een editie: beschikbare kwaliteiten (stereo, Atmos/spatial, hi-res) en video. |
| `download` | Een item naar een tijdelijk pad, met voortgang en met fouten ingedeeld in soorten: auth, niet beschikbaar, regio, tijdelijk of limiet. |
| `preview` | Een stream-URL voor één track. |
| `artwork` | De grootste beschikbare hoes. |

Regels voor elke bron:
- De rate limiter en de pauze tussen batches horen bij de adapter.
- Een `auth`-fout zet alle wachtende werk van die bron op pauze en hervat het daarna in dezelfde volgorde.

### 5.6 Contract voor mediaservers
- `notifyPathsChanged(paths[])` is verplicht. Plex komt eerst; de concrete aanroepen staan in ADR-15.
  - Plex: `GET /library/sections/{id}/refresh?path=<albummap>`
  - Jellyfin: `POST /Library/Media/Updated`
  - Navidrome/Subsonic: `startScan`
  - Kodi: `AudioLibrary.Scan` met een map
- `health()` is verplicht.
- Optioneel:
  - `readUserData()`: beoordelingen en afspeeltellingen, alleen lezen.
  - `mapSection(library)`: welke sectie bij welke bibliotheek hoort.
- Paden worden bij elkaar gezet per 30 s. Er wordt nooit een volledige scan gestart, tenzij de gebruiker daarom vraagt.

### 5.7 Voorluisteren
- Er is één endpoint, `preview(trackRef)`. Bestaat er een lokaal bestand, dan streamt het dat (zo nodig getranscodeerd naar AAC of Opus). Anders gebruikt het de `preview` van de bron via een ondertekende URL die kort geldig is.
- In de UI zit één zwevende minispeler, met afspelen/pauze, positie, bron (lokaal of welke dienst) en kwaliteit. Er is geen afspeelwachtrij.

---

### 5.8 Lessen uit Lidarr en arr-scripts voor de adapters
Bestudeerd: Lidarr `NzbDrone.Core/{ThingiProvider, Notifications, ImportLists, Indexers, Download/Clients}` en arr-scripts `lidarr/{Audio.service, ARLChecker, PlexNotify, UnmappedFilesCleaner, AutoArtistAdder}.bash`.

**Voor beide soorten adapters (uit `ThingiProvider`):**
- Eén registry met **definities per instantie** (naam, type, instellingen als JSON, aan/uit). Zo kun je twee Plex-servers of twee TIDAL-accounts hebben zonder codewijziging.
- Elke adapter heeft `Test()` met **validatie per veld**, aangeroepen bij opslaan in de UI. Fout = niet opslaan, met de reden bij het veld.
- **Status per instantie met oplopende pauze** (`ProviderStatusServiceBase`, `EscalationBackOff`: 0, 1 min, 5, 15, 30 min, 1, 3, 6, 12, 24 uur). Na een fout wordt de instantie tijdelijk overgeslagen in plaats van elke taak te laten falen; na een succes gaat de teller terug naar nul. Bij herstart geldt een korte grace-periode. Dit vervangt onze losse retry's.
- Vermogens als **vlaggen** (`SupportsRss`, `SupportsSearch`, `SupportsOnUpgrade` …): de kern vraagt de vlag, niet het type.

**Mediaservers (uit `Notifications`):**
- Per gebeurtenis een methode én een vlag (`OnReleaseImport`, `OnUpgrade`, `OnRename`, `OnAlbumDelete`, `OnArtistDelete`, `OnTrackRetag`, `OnHealthIssue`), en de gebruiker kiest per instantie welke aan staan.
- Plex: inloggen via **PIN op plex.tv** (`PlexTvService.GetPinUrl`), geen token plakken. Sectie zoeken via `Location` met **padvertaling** (container-pad ↔ serverpad) en dan `refresh?path=`; bij oude servers de hele sectie.
- `ProcessQueue()`: meldingen worden verzameld en in één keer verstuurd; dat is onze bundeling per 30 s.
- arr-scripts `PlexNotify.bash` controleert eerst de versie (`/`) en zoekt de sectie per map: zelfde aanpak, bevestigt dat `refresh?path=` genoeg is.

**Streamingbronnen (uit `Indexers`, `Download/Clients` en `ImportLists`):**
- Lidarr splitst **zoeken** (Indexer) en **downloaden** (DownloadClient). Bij ons doet één dienst beide, maar we houden de vermogens gescheiden (`search`/`offers` tegenover `download`), zodat een dienst zonder download (alleen catalogus, bv. Spotify-lijst) ook past.
- DownloadClient-vorm: `GetItems()`, `GetStatus()`, `RemoveItem(deleteData)`, `MarkItemAsImported()`. Neem over: de kern vraagt de status op in plaats van op callbacks te vertrouwen, en markeert expliciet "geïmporteerd".
- Indexer: `HttpIndexerBase` met **rate limit per instantie** en paginering via een request-generator. De limiter hoort dus bij de adapter-instantie (zoals §5.5 al zegt).
- ImportLists (Spotify, Last.fm, MusicBrainz-series): `MinRefreshInterval` per lijst, eigen status/backoff, en **uitsluitingen** (`ImportListExclusions`) zodat verwijderde artiesten niet terugkomen. Neem over voor V13 (playlists) en automatisch artiesten toevoegen.
- arr-scripts `Audio.service.bash`: zoekt vanuit missing én cutoff-unmet, eerst exact (id/UPC), dan fuzzy op titel; controleert na download de kwaliteit (`DownloadQualityCheck`) en FLAC-integriteit; onthoudt "niet gevonden" per album met een **vervaltermijn** (`NotFoundFolderCleaner`, standaard opnieuw proberen na X dagen). Neem over: "niet beschikbaar" is een status met een datum, geen definitieve fout.
- arr-scripts `ARLChecker`: controleert de login (token) periodiek en meldt verlopen vóórdat downloads falen. Bij ons: `health()` van `auth` op een schema, en een verlopen login pauzeert alleen die bron.
- Vermijden: arr-scripts schrijft configuratie direct via de Lidarr-API bij elke start (`AutoConfig`) en mengt bronnen per album (Deezer → TIDAL fallback per album). Wij mengen niet binnen één editie (ADR-16).

## 6. Ontwerpbeslissingen (ADR)
Elke beslissing heeft de vorm: context → beslissing → gevolgen.

### ADR-1: Ontbrekend is een view, de wachtrij is top-N
- **Context.** Een opgeslagen wachtrij groeide naar meer dan 100.000 rijen, met dubbelingen en minutenlange rebuilds.
- **Beslissing.** Ontbrekend en cutoff zijn queries, zoals bij Lidarr `AlbumsWithoutFiles` en `AlbumsWhereCutoffUnmet`. De verwervingslus haalt de top-N op prioriteit op en houdt maximaal N actieve taken aan. Een unieke index op (bibliotheek, editie) dwingt E3 af.
- **Gevolgen.** Een rebuild is niet meer nodig. De UI kan de view pagineren. Prioriteit is een sortering (bijvoorbeeld nieuw toegevoegd, door de gebruiker gevraagd, of populariteit).
- **Afweging.** Ik heb de varianten tegen elkaar gezet met een morfologische kaart en een Harris-profiel; daarbij scoorde de view op alle eisen behalve bouwwerk het best.

### ADR-2: Eén importbeslisser met specificaties
- **Context.** Downloads, scans en vreemde mappen hadden elk hun eigen pad. Automatisch importeren van vreemde bestanden deed niets.
- **Beslissing.** Er is één engine (`ImportDecisionEngine`) met losse specificaties die elk een reden geven. Identificatie gaat in deze volgorde, zoals bij Lidarr `IdentifyRelease`:
  1. MB-id's uit de tags
  2. lokale catalogus (artiest + album + aantal tracks)
  3. MB online (een release toevoegen als de artiest gevolgd wordt)
  4. AcoustID
  5. afstand plus een marge op nummer twee (Picard `find_best_match_with_margin`)
- **Drempels.** Een album wordt geaccepteerd bij een afstand ≤ 0,20, een track bij ≤ 0,40, mits geen track ontbreekt of niet gekoppeld is. Daartussen gaat het naar Beoordelen.
- **In gewone woorden.**
  - *De volgorde* is: eerst kijken of het bestand zelf zegt wat het is (MusicBrainz-nummers in de tags). Lukt dat niet, dan zoeken in wat de app al kent (artiest, albumtitel, aantal tracks). Dan online bij MusicBrainz. Dan luisteren: de vingerafdruk van het geluid opzoeken. Pas als laatste: vergelijken op "lijkt het genoeg".
  - *Afstand* is een cijfer van 0 (precies gelijk) tot 1 (niets gemeen). Het telt verschillen op in titel, artiest, aantal tracks, tracklengtes, jaar en label, elk met een gewicht.
  - *Drempel per album*: een album met afstand 0,20 of minder (ongeveer 80% gelijk) mag automatisch; een losse track tot 0,40.
  - *Marge*: de beste kandidaat moet duidelijk beter zijn dan de tweede. Lijken twee edities even goed (standaard en deluxe met dezelfde tracks), dan kiest de app niet zelf maar vraagt het jou.
- **Gevolgen.** Dezelfde regels en dezelfde UI-redenen gelden voor elke herkomst. Wel verschilt het vertrouwen in de invoer (ADR-18).

### ADR-3: Bibliotheken per soort, artiest standaard in alle
- **Context.** Stereo, spatial en video hebben eigen kwaliteitsdoelen, bronnen en mappen. Spatial mag stereo nooit vullen.
- **Beslissing.**
  - Een bibliotheek heeft een soort (`stereo`, `spatial` of `video`), een map, een kwaliteitsprofiel, een curatiebeleid en een standaardvlag "nieuwe artiesten toevoegen".
  - Een nieuwe artiest komt in elke bibliotheek met die vlag (standaard alle).
  - Per artiest kun je dat overschrijven (`LibraryArtists` per bibliotheek); een overschrijving telt als gebruikersbeslissing (P6).
  - Er kunnen meerdere bibliotheken van dezelfde soort zijn, bijvoorbeeld "Stereo Hi-Res" en "Stereo Mobiel".
- **Op korte termijn (zoals Lidarr's standaard-hoofdmap).** Eén scherm met: gewenste audiokwaliteit, "ook ruimtelijk geluid" (aan/uit, eigen hoofdmap) en "ook muziekvideo's" (aan/uit, eigen hoofdmap). Daaronder maakt de app zelf de bibliotheken aan.
- **Op lange termijn.** Je maakt een bibliotheek aan met een hoofdmap, koppelt er inhoudssoorten aan (stereo, spatial, video) en een rangorde, net als Lidarr's root folders met kwaliteits- en metadataprofielen.
- **Muziekvideo's.** Twee structuren, al in de code als instelling `video_folder_layout`: `separated` (Plex' globale muziekvideomap), `inline` (naast het album), en `inline_only`: download een video alleen als hij inline bij een track past. Die laatste optie bestaat al.
- **Gevolgen.** Curatie, plan en wachtrij zijn altijd per bibliotheek. Een muziekvideo is via `music_video_for` gekoppeld aan een recording.

### ADR-4: Naamgeving en tags volgens de standaard, met een Plex-instelling
- **Mappen:** `{Album Artist}/{Album} ({Year})[ {Edition}]/{Disc}{Track:00} - {Title}.{ext}`. De map gebruikt altijd één naam: de primaire albumartiest of "Various Artists" (Plex eist dat alle albums in een artiestmap dezelfde ALBUMARTIST hebben). Een veilige pad-normalisatie is configureerbaar.
- **Wat de standaard is (bronnen):**
  - **Picard** (de facto standaard, `picard/formats/{vorbis,id3,mp4}.py`, Picard-documentatie "Tag Mapping"): ALBUMARTIST is de **volledige credit als één tekst** met join phrases ("Taylor Swift feat. Bon Iver"); ALBUMARTISTS is een **lijst** met elke artiest apart. Opslag per formaat: Vorbis/FLAC `ALBUMARTIST` + meerdere `ALBUMARTISTS`-velden; ID3v2.4 `TPE2` + `TXXX:ALBUMARTISTS` (sortering `TSO2`); MP4 `aART` + `----:com.apple.iTunes:ALBUMARTISTS` (sortering `soaa`). Hetzelfde voor ARTIST/ARTISTS en de MBID's.
  - **Navidrome** (`resources/mappings.yaml`, `model/metadata/map_participants.go`; navidrome.org/docs/usage/tagging): leest ALBUMARTISTS als die er is en splitst dan ALBUMARTIST niet meer. Zonder ALBUMARTISTS splitst het ALBUMARTIST op " / ", " feat. ", "; ".
  - **Plex** (support.plex.tv "Adding Music Media From Folders"; Plex-forum, moderators): leest alleen ALBUMARTIST (ID3 TPE2), gebruikt bij meerdere waarden alleen de eerste, kent ALBUMARTISTS niet, en maakt van "A & B" een **nieuwe artiest** "A & B" (of voegt die bij "A" samen). Compilaties: "Various Artists".
- **Beslissing.**
  - **ALBUMARTISTS (lijst) wordt altijd geschreven**, ARTISTS ook. Dat is standaard en Plex negeert het, dus het kost niets.
  - **Instelling "Plex-compatibel: één albumartiest"** (bestaande `album_artist_mode`), **standaard aan**, omdat Plex de hoofdserver is:
    - **aan** (`plex_jellyfin`): ALBUMARTIST = alleen de primaire artiest. Navidrome toont toch alle artiesten via ALBUMARTISTS; Plex maakt geen samenwerkingsartiesten.
    - **uit** (`picard`): ALBUMARTIST = de volledige credit zoals Picard. Volledig volgens het boekje; goed voor Navidrome, foobar en Picard, slecht voor Plex.
  - Beide tegelijk schrijven is daarmee correct: het verschil zit alleen in de ene ALBUMARTIST-waarde, en geen van beide modi breekt de standaard voor ALBUMARTISTS.
  - Verder: ARTIST = credit-tekst met join phrases, alle MBID's, RELEASETYPE (meerdere waarden), ISRC, ORIGINALDATE, LABEL, CATALOGNUMBER, songteksten (LRC indien gesynchroniseerd) en ReplayGain (zie `TAG_IO_STRATEGY.md`).
- **Gevolgen.** Plex groepeert op één albumartiest, Navidrome toont meerdere. Omzetten van de instelling herschrijft alleen ALBUMARTIST, via L8 met een proefrun.

### ADR-5: Beeld van de hoogste kwaliteit
- **Beslissing.**
  - **Albumhoes:** de app kiest zonder instelling de bron met de hoogste kwaliteit (grootste afmeting, dan bestandsgrootte): de dienst bij een exacte editie-match (meestal de beste), Cover Art Archive "front" in originele grootte, of de hoes in de download.
  - Uitzondering: een **echt samengesteld album** (ADR-19, soort b) krijgt de Cover Art Archive-hoes van de MB-release, omdat geen dienst-hoes bij die editie hoort.
  - **Geen minimum- of doelresolutie.** `cover.jpg` naast de audio krijgt de originele grootte (vaak 2000–3000 px). Ingebed gaat een kopie van maximaal 1200 px mee.
  - **Artiestfoto:** de grootste van fanart.tv of de dienst, als `artist.jpg`. Optioneel `backdrop.jpg`.
  - Een kleiner of onzeker beeld vervangt nooit een groter, zeker beeld.
- **Gevolgen.** Plex, Jellyfin en Navidrome lezen deze lokale bestanden.

### ADR-6: Muziekvideo's volgens de Plex-structuur
- **Beslissing.** De videobibliotheek kent twee vormen, per bibliotheek in te stellen:
  - **Globaal** (een aparte videomap, Plex "Global Music Videos"): `{Artist}/{Title}-video.{ext}`. Een live-uitvoering krijgt een suffix (`-live`), een lyric video `-lyrics`, enzovoort.
  - **Inline** (in de stereomap bij het album): `{Album Artist}/{Album}/{Track Title}-video.{ext}`, of `{Album Artist}/{Title}-video.ext` voor een video zonder album.
  - Koppeling gaat via MB `music_video_for`. Is die er niet, dan via een geaccepteerde `ProviderVideoMatches`-koppeling.
- **Gevolgen.** Plex toont video's bij het juiste nummer of bij de artiest. Jellyfin en Navidrome negeren of tonen ze, zonder fouten.

### ADR-7: Bestandsveiligheid
- **Beslissing.** Wijzigingen gaan via een journaal (oud pad, nieuw pad, checksum, reden). **Automatisch** verwijderen gebeurt alleen bij een betere kopie van dezelfde recording in dezelfde bibliotheek, of via de Unmapped-termijn (ADR-14). **Handmatig** mag altijd: bij ontmonitoren worden de bestanden meteen verwijderd als de instelling "bestanden verwijderen bij ontmonitoren" aan staat, en net als Lidarr's *Manage Tracks* kun je per album of track bestanden kiezen en verwijderen (met bevestiging en journaal). Onbekende bestanden worden nooit automatisch verwijderd, behalve via ADR-14. Een batch begint met een proefrun en kan worden teruggedraaid. Integriteit (L9) meldt problemen en lost niets stil op.
- **Waarom.** arr-scripts `UnmappedFilesCleaner` gooit hele mappen weg; dat mag hier niet kunnen.

### ADR-8: Adapters voor bronnen en mediaservers
- **Beslissing.** De contracten staan in §5.5 en §5.6. De registry gebruikt instellingen per instantie, `Test()` en status met oplopende pauze, zoals Lidarr `ThingiProvider` (zie §5.8). Een adapter test zichzelf met `health()`.
- **Gevolgen.** Een nieuwe dienst is een nieuwe map met een adapter. De kern verandert niet.

### ADR-9: Korte transacties en één schrijver
- **Beslissing.** Er is één schrijver voor SQLite (WAL). Transacties duren korter dan 1 s, en grote updates worden in brokken van circa 200 rijen gedaan. Leeswerk gebeurt buiten een transactie.
- **Zo doen anderen het.** Lidarr: `BasicRepository.InsertMany/UpdateMany` schrijft een lijst in één transactie per batch, en zware taken lopen via de commandoqueue. Navidrome: SQLite in WAL met `_busy_timeout=15000`, schrijven via `WithTx`/`WithTxImmediate` (de schrijflock vooraf pakken, zodat er geen `SQLITE_BUSY_SNAPSHOT` ontstaat), en de scanner schrijft per map. Picard heeft geen database; daar valt voor dit punt niets over te nemen.
- **Gevolgen.** De UI blijft bruikbaar tijdens grote refreshes. Overnemen: `BEGIN IMMEDIATE` voor schrijftransacties (zoals Navidrome) en batch-schrijven per map of per 200 rijen.

### ADR-10: De UI krijgt alleen wijzigingen
- **Beslissing.** Wachtrij en status gaan per versienummer naar de UI, als wijzigingen sinds die versie (zoals qBittorrent `maindata?rid=`), via SSE.
- **Gevolgen.** Weinig belasting, ook bij grote lijsten.

### ADR-11: Complete edities boven één bestand per recording
- **Context.** De oude eis "hoogstens één bestand per recording per bibliotheek" leidde ertoe dat bij twee nodige edities (bijvoorbeeld deluxe plus complete edition) alleen de extra tracks werden gehaald. Albums zagen er in de mediaserver incompleet uit.
- **Beslissing.** Eén bestand per recording is een **streven**. De curatie kiest zo weinig edities als nodig om de discografie te dekken, en elke gekozen editie wordt **volledig** verworven, ook tracks die al in een andere editie staan.
- **Gevolgen.** Meer schijfruimte, maar elk album is compleet. L9 meldt alleen een dubbel bestand binnen **dezelfde** editie.

### ADR-12: Echte opnames, MusicBrainz als poort
- **Beslissing.** Een karaoke-, tribute-, cover- of soundalike-versie door een andere artiest wordt nooit gekoppeld als vervanger van het echte nummer. Eigen werk van de artiest mag wel: een eigen instrumentaal- of karaoke-album, of een cover die de artiest zelf opnam, als aparte recording of album zoals MusicBrainz het vastlegt. Alleen wat in MusicBrainz staat, kan op de verwervingslijst komen.
- **Gevolgen.** Aanbod zonder MB-anker blijft zichtbaar als "gezien, niet in MB" (V12), maar wordt nooit gedownload.

### ADR-13: Importbewijs en audio-verificatie (bestaat al)
- **Context.** Een eerder genoemd doel van "95% automatisch" was een schatting zonder meting. Het is geschrapt.
- **Wat er al is.** `services/mediafiles/fingerprint.ts` maakt een Chromaprint-vingerafdruk en zoekt die op bij AcoustID (sleutel `acoustid_api_key`). De importengine (`services/import-decision/engine.ts`) gebruikt die al: zijn de tags onvoldoende, dan mag een import toch automatisch als de vingerafdruk één duidelijke winnaar geeft (`matchType = "fingerprint"`). Tags en vingerafdruk werken dus al samen.
- **Beslissing (herzien 30-10-2026).** Een map zonder MB-release-id in de tags wordt gekoppeld zoals Lidarr dat doet:
  - **Lidarr-identiek** (`services/mediafiles/lidarr-distance.ts`, port van Lidarr's `DistanceCalculator`, `Distance`, `Munkres` en `IdentificationService`): tracks worden gepaard met het Hongaarse algoritme (Munkres); per track tellen lengte (drempels 10 s en 40 s), titel, tracknummer en recording-id; per album tellen artiestnaam, albumtitel (tegen de hoofdtitel), aantal schijven, media, jaar, land, label, disambiguation, release-id, ontbrekende en niet-passende tracks, met Lidarr's gewichten;
  - de kandidaat met de **kleinste afstand** wint; bij gelijke afstand de eerste kandidaat. Drempels: album ≤ 0,20 (zonder ontbrekende/niet-passende tracks), per track ≤ 0,40. Er is geen marge en geen tie-breaker op gemonitorde editie;
  - de vingerafdruk wordt gemaakt op Lidarr's momenten (`shouldFingerprint`) en telt mee via het recording-id in de trackafstand;
  - releasestatus volgt de filters van het metadataprofiel; een bootleg alleen als de filters bootlegs toelaten **en** een streamingdienst die release aanbiedt. Bestanden met een MB-release-id in de tags volgen hun id;
  - bewuste afwijkingen: kandidaten komen uit de eigen catalogus (titel-voorfilter ≤ 0,4), niet uit de vingerafdruk. Tracktitels worden opgeschoond zoals Lidarr's CleanTrackTitle ("feat." en editietekst eraf);
  - geen kandidaat in de eigen catalogus: eerst online opzoeken bij MusicBrainz en de ontbrekende release-groups toevoegen, dan opnieuw kiezen;
  - bestanden die niet in de gekozen release passen, blijven in Unmapped (gedeeltelijke import).
- **Handmatige import vervangt.** Een handmatige import vervangt de bestaande bestanden van dezelfde recordings in dat album; de oude bestanden worden verwijderd en gelogd.
- **Artwork.** Een apart gezette artwork-herstelregel die opnieuw mislukt, wordt afgesloten en er wordt vervangende artwork opgehaald. Een afbeelding die een andere app of de gebruiker neerzette, wordt nooit overschreven.

### ADR-14: Unmapped opruimen na een termijn
- **Beslissing (eis).** Een bestand dat **N dagen** in Unmapped staat, wordt verwijderd. N is standaard **90**, instelbaar, en in dezelfde instelling uit te zetten. Er is geen aparte lijst "wordt binnenkort verwijderd" (de Unmapped-lijst toont al alles, met de leeftijd) en geen bevestigingsstop bij grote aantallen.
- **Waarborgen:**
  - de klok start bij de eerste keer dat het bestand in Unmapped verscheen en loopt opnieuw als het bestand verandert;
  - per bestand een journaalregel: pad, grootte, checksum, reden en datum;
  - een bestand in Beoordelen, een bestand in een lopende import, of een pad buiten een bibliotheekroot wordt nooit aangeraakt.
- **Waarom.** arr-scripts `UnmappedFilesCleaner.bash` haalt `trackFile?unmapped=true` op en doet `rm -rf` op de hele map, zonder termijn of journaal. Het opruimen nemen we over, per bestand en met termijn.

### ADR-15: Mediaserver-koppeling volgens Lidarr (latere fase)
- **Model.** Lidarr's notificatiekoppelingen (`NzbDrone.Core/Notifications`). Elke koppeling implementeert gebeurtenissen (`OnReleaseImport`, `OnUpgrade`, `OnRename`, `OnAlbumDelete`, `OnArtistDelete`, `OnTrackRetag`) en kiest per gebeurtenis of ze reageert. Dat nemen we over.
- **Per server:**
  - **Plex** (`Notifications/Plex/Server`): bij die gebeurtenissen `UpdateLibrary(artist)`: secties ophalen (`/library/sections`), de sectie zoeken waarvan een `Location` het artiestpad bevat (met padvertaling, "mapping path for partial scan"), en `GET /library/sections/{id}/refresh?path=<artiestmap>`. Oudere servers zonder partial scan krijgen de hele sectie. Health: `/identity`.
  - **Jellyfin/Emby** (`Notifications/MediaBrowser`): `POST /Library/Media/Updated` met de gewijzigde paden.
  - **Navidrome/Subsonic** (`Notifications/Subsonic`): `startScan` (Navidrome scant zelf incrementeel).
  - **Kodi** (`xbmc`): `AudioLibrary.Scan` met een map.
  - **Plex-melding zonder app** (arr-scripts `PlexNotify.bash`): hetzelfde `refresh?path=` per map; bevestigt de aanpak.
- **Beslissing.** Gebundeld per 30 s per artiestmap. Dit komt in een latere fase (zie Roadmap).

### ADR-16: Beschikbaarheid → curatie → plan; geen mengen van diensten
- **Context.** Curatie moet weten wat te krijgen is (welke editie dekt de discografie en is beschikbaar). Volledige plannen voor elke editie maken is duur, en plan-wisselingen vervuilden de wachtrij.
- **Beslissing.**
  - L2 bepaalt **beschikbaarheid** per editie en recording: welke dienst, welke kwaliteit, en of een editie 1:1 als album te krijgen is of samen te stellen uit meerdere albums van één dienst. Dat is goedkoop en genoeg voor de curatie.
  - L3 kiest daarmee de gewenste edities. L4 maakt **alleen voor gewenste edities** een plan (1:1 of samengesteld).
  - **Eén dienst per plan.** Een editie wordt niet gemengd uit meerdere diensten (bijvoorbeeld 5 tracks van Apple Music en 5 van TIDAL): mastering, loudness en kwaliteit lopen dan uiteen binnen één album. Kan geen dienst de editie volledig leveren, dan wacht ze met de reden "niet compleet bij één dienst" en kiest de curatie zo mogelijk een andere editie.
- **Gevolgen.** Minder plannen, een stabielere wachtrij en consistente albums. Na een nieuwe dienst of een catalogusupdate kan een wachtende editie alsnog compleet worden.


### ADR-17: Werken met een vergrootglas op 600–700%
- **Context.** Met een vergrootglas zie je steeds een klein stukje van het scherm. De opmaak van de app verandert niet; wat telt is hoe ver je moet schuiven om iets te vinden en of er iets gebeurt buiten beeld.
- **Wat er concreet verandert:**
  - status staat direct naast de naam (in dezelfde regel), niet helemaal rechts in een brede rij;
  - meldingen verschijnen naast de knop waarop je klikte, niet in een hoek van het scherm; ze sluiten zodra je ergens anders klikt (light dismiss), je hoeft ze niet zelf weg te klikken;
  - popovers en tooltips mogen, maar altijd met de Fluent UI-componenten (`Popover`, `Tooltip`, `MessageBar`) en in één consistente stijl, inclusief de glas/acryl-achtergrond van Fluent 2; geen zelfgebouwde varianten;
  - de standaard Fluent-focusrand is genoeg; een extra dikke focusrand is geen eis;
  - tabellen hebben een compacte weergave waarin alles van een rij binnen ongeveer 400 px breedte past;
  - niets beweegt of herschikt terwijl je leest: lijsten springen niet bij nieuwe gegevens; een "nieuwe items"-knop laat ze zien.
- **Wat niet hoeft te veranderen.** Grootte en kleuren: die regelt het vergrootglas al. Browserzoom-herschikking blijft netjes werken, maar is niet het hoofddoel.
- **Daarnaast.** Schermlezer: elke status en knop heeft een naam. Hoog contrast: Windows-contrastthema's (`forced-colors`) worden gevolgd.

### ADR-18: Eigen downloads met bekende identiteit (vertrouwde herkomst)
- **Context.** Bij een eigen download weet de app al welke MB-release en -recordings bedoeld zijn: dat staat in het plan.
- **Beslissing.** Dezelfde importengine, maar met een ander vertrouwen in de invoer. Een download geeft zijn verwachte identiteit mee (bibliotheek, editie, plan, track ↔ recording). De download draagt zijn koppeling mee en wordt **niet opnieuw geïdentificeerd**. De engine doet alleen **verificatie**: aantal tracks, lengte binnen 3 s, ISRC waar de dienst die geeft, en een steekproef met de vingerafdruk. Klopt dat, dan import; klopt het niet, dan Beoordelen met reden "dienst leverde iets anders dan verwacht".
- **Gevolgen.** Snellere import en geen dubbele identificatie, zonder een tweede importpad.

### ADR-19: Twee soorten samengestelde albums
- **Onderscheid (structureel vast te stellen).** Het plan bevat al de bronnen per track en of een bron een exacte editie-match is (`composition` = `single_source` of `composite`). Daarmee:
  - **(a) aangevuld album:** er is één bron die de hele editie 1:1 levert, en enkele tracks komen uit een andere bron omdat die een hogere kwaliteit heeft. Herkenbaar: één bron dekt alle tracks.
  - **(b) echt samengesteld album:** geen enkele bron dekt de editie; de tracks komen van verschillende albums bij de dienst.
- **Beslissing.** De app slaat dit soort op bij het plan en toont het. Hoes: (a) die van de 1:1-bron, (b) Cover Art Archive.
- **Kwaliteitsupgrades.** Bij (a) blijft de 1:1-bron gevolgd: komt het hele album later in hogere kwaliteit, dan wordt het in één keer vervangen. Bij (b) wordt per track opnieuw gekeken; zodra een 1:1-bron verschijnt, wordt het album (a) of single-source.
- **ADR-16 blijft gelden:** binnen één plan één dienst.

### ADR-20: Doelformaat en omzetten
- **Beslissing.** Per bibliotheek een doelformaat. Omlaag (bijvoorbeeld FLAC → Opus 256 of AAC 256 in m4a, instelbaar) gebeurt **lokaal** met ffmpeg, zonder opnieuw downloaden; tags, hoes en MBID's gaan mee; het origineel wordt pas verwijderd na een geslaagde controle, via het journaal. Omhoog kan alleen door opnieuw te downloaden: de albums komen dan in Ontbrekend/Cutoff.

---

## 7. UI/UX-richtlijnen (de vijf vlakken van Garrett, van onder naar boven)

### 7.1 Strategy
De visie (§1) en de succesmaten:
- 0 dubbele taken
- minder dan 1% van de bestanden in Unmapped die er langer dan 24 u staan
- een statuswoord dat klopt
- de gebruiker hoeft minder dan 5 minuten per week iets te doen

### 7.2 Scope
De eisen in §4. Tekst en content horen ook bij de scope: elke reden en foutmelding staat in gewone taal, met de volgende stap erbij. Een melding als "SQLITE_BUSY" staat nooit in de UI.

### 7.3 Structure
Het denkmodel is **gewenst − aanwezig = ontbrekend**, per bibliotheek.

Navigatie (zoals bij Lidarr, maar platter):

| Plek | Doel |
|---|---|
| **Overzicht** | Status, aandachtspunten en recente activiteit. |
| **Bibliotheek** | Artiesten → albums → tracks, met een filter per bibliotheek (stereo, spatial, video). |
| **Ontbrekend** | De view, met de reden per album en cutoff-tabbladen. |
| **Beoordelen** | Twijfelimports, conflicten en voorstellen van de integriteitslus. |
| **Activiteit** | Actieve taken, geschiedenis en het logboek. |
| **Instellingen** | Bibliotheken, bronnen, mediaservers, naamgeving, tags en curatie. |

### 7.4 Skeleton
- Per scherm één primaire actie.
- Lijsten als tabel met grote rijen (Fluent `Table`), meldingen als `MessageBar` naast de actie (sluit bij klikken ernaast), details in een `Drawer`, popovers en tooltips alleen als Fluent `Popover`/`Tooltip` met de glas/acryl-stijl.
- Er zijn geen acties die alleen bij hover zichtbaar zijn, en alles is met het toetsenbord te bereiken (tabster).
- ▶ staat links in elke trackrij, in alle plekken. De minispeler staat vast onderaan.
- Op de artiestpagina staan een grote foto en de albums als hoezen-grid, zoals in Plex. Per album zie je een dekkingsbalk per bibliotheek.
- Elk album toont de beslissing, bijvoorbeeld "Gekozen door curatie: dekt 14/14", "Door jou gekozen" of "Wacht op bron".

### 7.5 Surface
- Fluent 2-tokens, met donker thema standaard. Het accent volgt de artiestfoto, maar alleen binnen het AA-contrast.
- Lettergrootte 16 px of meer, rijen 44 px of hoger.
- Status is altijd woord + icoon + kleur, nooit alleen kleur.
- Elke hoes gebruikt dezelfde afronding en schaduw. Ontbreekt een hoes, dan zie je de artiestinitialen in plaats van een leeg vlak.

### 7.6 Toetsing
Elke nieuwe flow wordt getest met de eigenaar, aan de hand van de scenario's in §1.4, met een vergrootglas op 600–700%, met een schermlezer en in hoog contrast (Product Usability Evaluation, ADR-17). Wat niet lukt, wordt een eis.

---

## 8. Voorstellen (nog niet gevraagd, wel logisch)
Status na beoordeling door de eigenaar. "Akkoord" wordt een eis zodra het op de roadmap staat.

| # | Voorstel | Status | Bron/inspiratie |
|---|---|---|---|
| V1 | **Nieuwe releases volgen**: automatisch gewenst bij een nieuwe release van een gevolgde artiest | **Akkoord** | Lidarr monitor-new-albums |
| V2 | **Doelformaat, omhoog en omlaag** (ADR-20) | **Akkoord** | ffmpeg; Lidarr `UpgradableSpecification` |
| V3 | **Integriteitsrapport**: checksums, kapotte bestanden (decodeertest), ontbrekende en onbekende bestanden | **Akkoord** | Immich `IntegrityService`, Navidrome `missing`-vlag, `flac -t` |
| V4 | **Wekelijkse samenvatting** als pushbericht | **Akkoord** | Lidarr notificaties (ntfy, Gotify, Apprise) |
| V5 | Beoordelingen en afspeeltellingen uit de mediaserver | **Uitgesteld**: helpt alleen voor wat je al hebt, voegt geen nieuwe artiesten toe | – |
| V6 | Gesynchroniseerde songteksten | **Bestaat al** (`services/extras/lyrics`, `save_lyrics`, `embed_lyrics`) | – |
| V7 | Lokale MusicBrainz | **Bestaat al** (Lidarr-proxy of musicbrainz-docker). Later: een bijcontainer die zichzelf instelt, met voortgang in de app | musicbrainz-docker |
| V8 | **Albums die geen enkele dienst heeft**, met uploaden via de webinterface of een map op schijf aanwijzen; daarna pakt de automatische import ze op | **Akkoord** | – |
| V9 | **Bestaande collectie inlezen**: je wijst een map met muziek aan; de app herkent de artiesten en albums en zet ze als "aanwezig" in de bibliotheek, zodat ze niet opnieuw worden gedownload | Uitleg (zie hieronder) | Lidarr bulk import |
| V10 | Opslagbudget per bibliotheek | Toekomst | – |
| V11 | **Back-up van alle beslissingen**: zoals Lidarr `Backup` (zip van database en instellingen, gepland met instelbare interval en bewaartermijn, plus handmatig, terugzetten vanuit de UI) | **Akkoord** | Lidarr `BackupService` |
| V12 | **Afgewezen aanbod met reden**: per album de lijst van wat een dienst wel had maar de app niet koos, met waarom (bijvoorbeeld "karaoke-versie", "niet in jouw land", "alleen 16-bit, je wilt 24-bit", "andere tracklijst") | Uitleg (zie hieronder) | Lidarr "rejections" bij handmatig zoeken |
| V13 | **Playlists doorgeven**: gekozen playlists van een dienst (eigen playlists, of mixen zoals "Mixes for You" of "Discover") volgen en op de mediaserver nabouwen via de adapters | **Nieuw, akkoord** | streamingadapter → mediaserveradapter |
| V14 | **Gemengde bibliotheek**: per track een video verkiezen boven audio (album met tracks 1, 3, 5 als video), afhankelijk van wat de speler aankan | **Toekomst** | – |

**Uitleg V9 (bestaande collectie inlezen).** Je hebt al muziek op schijf, bijvoorbeeld uit Lidarr of een oude cd-collectie. Je wijst die map aan. De app herkent wat er staat, maakt de artiesten aan en markeert de albums als aanwezig. Daarna downloadt hij alleen wat nog ontbreekt. Zonder deze stap zou hij alles opnieuw willen downloaden.

**Uitleg V12 (afgewezen aanbod).** Als een dienst wel iets heeft voor een album maar de app kiest het niet, zie je waarom. Voorbeeld: bij "Doom Days" vond de app op TIDAL een karaoke-versie (afgewezen: karaoke), op Apple Music de echte versie maar alleen in jouw land niet beschikbaar (afgewezen: regio). Zo weet je waarom iets in Ontbrekend blijft staan.

---

## 9. Wat de referentieprojecten ons leren
| Project | Code | Overnemen | Vermijden |
|---|---|---|---|
| Lidarr | `AlbumRepository.AlbumsWithoutFiles/AlbumsWhereCutoffUnmet`; `DownloadDecisionMaker` + specs; `TrackImport/ImportDecisionMaker` + `CloseAlbumMatchSpecification` (0,20/0,40); `Identification/IdentificationService.IdentifyRelease`; `DistanceCalculator`; `CommandQueue.TryGet` (exclusief, schijf, prioriteit); `ShouldRefreshArtist`; `ThingiProvider`; `Notifications/Plex/Server/PlexServerService.UpdateLibrary`; `Organizer/FileNameBuilder` | Missing en cutoff als view, specificaties met een reden, de identificatievolgorde, de refresh-regels, de providerregistry en de pad-scan na import | Afhankelijkheid van indexers |
| Picard | `matching.compare_to_release`, `find_best_match_with_margin`, `Metadata` weights; `file.File._save_and_rename`, `_move_additional_files`; `plugin.register` | Score met marge; eerst opslaan, dan atomisch verplaatsen; tag-namen | – |
| Navidrome | `scanner/phase_1_folders`, `phase_2_missing_tracks` (PID, verplaatsingen), `phase_3_refresh_albums`, `watcher.go`; `plugins/capabilities` | Incrementele scan in fasen en verplaatsingen herkennen | Volledige scans |
| Jellyfin | `IRemoteMetadataProvider`, `IImageProvider`, `IHasOrder`, `IMetadataService.RefreshMetadata`; `LibraryController` `Media/Updated` | Vermogens met volgorde, gerichte refresh | – |
| Immich | `IntegrityService` (`handleUntrackedFiles`, `handleMissingFiles`, `handleChecksumFiles`), `LibraryService.handleSyncFiles`/`watchAll`, `QueueService` (gelijktijdigheid per wachtrij) | Integriteitsrapport, wachtrijen per soort | – |
| Tidarr | `processing/core/queue-manager.ts`; `services/plex.ts plexUpdate`; `jellyfin.ts`; `navidrome.ts`; `tiddl-error-patterns.classifyTiddlLine`; `batch-queue.checkBatchPause`; `sync.ts`; `PlayerProvider`/`FloatingPlayer`; `helpers/signature.ts` | Foutsoorten, batch-pauze, pad-refresh, minispeler, ondertekende URL's | Jellyfin volledig verversen |
| tiddl | `core/auth/client.AuthClient` (device code, refresh), `core/api/client.TidalClient.fetch`, `core/metadata/track.add_flac_metadata`, `normalize_credits_keys` | Device-flow-auth, credit-normalisatie | – |
| streamrip | `client/client.py Client` (`login`, `search`, `get_metadata`, `get_downloadable`, rate limiter) | Vorm van het broncontract | – |
| apple-music-downloader | `internal/wrapper` (`Status`, license, m3u8, lyrics), `internal/app` (search, rip, artwork, convert) | Health-check vóór download; lyrics en artwork als vermogens | – |
| ytmusicapi | `mixins/search`, `browsing`, `library`, `auth/browser` | Catalogus en zoeken voor YouTube | – |
| yt-dlp | extractor-registry, `postprocessor/` (ffmpeg, embedthumbnail, metadataparser, movefilesafterdownload) | Nabewerking als keten | – |
| arr-scripts | `lidarr/Audio.service.bash` (`GetMissingCutOffList`, `FuzzyTidalSearch`, `DownloadQualityCheck`), `PlexNotify.bash`, `UnmappedFilesCleaner.bash` | Zoeken vanuit missing en cutoff | `rm -rf` op onbekende mappen |
| qBittorrent | `webui/api/synccontroller.cpp maindata` met `rid` | Alleen wijzigingen naar de UI sturen | – |
| Kodi (xbmc) | JSON-RPC `AudioLibrary.Scan` | Kodi-adapter | – |
| musicbrainz-docker | compose: mirror, replicatie, live-indexing | Optionele lokale MB | – |
| Fluent UI | react-components: table, message-bar, drawer, nav, tabster | Toegankelijke bouwstenen | – |

---

## 10. Roadmap
De roadmap heeft drie lagen: waarde, product en techniek.

| Fase | Waarde | Product | Techniek |
|---|---|---|---|
| **1. Fundament (nu)** | Vreemde bestanden komen vanzelf binnen; geen wachtrij-explosie | Automatische import van vreemde mappen; Ontbrekend als view, wachtrij top-N | ImportDecisionEngine voor mappen; unieke index en view; korte transacties (credits) |
| **2. Rust en uitleg** | Vertrouwen | Schermen Beoordelen en Ontbrekend met redenen; watchdog op voortgang | Specificaties met redenen; voortgangs-heartbeat; SSE met wijzigingen |
| **3. Afwerking** | Mooie bibliotheek | Tagprofielen Plex en Navidrome; artwork volgens ADR-5; video's volgens ADR-6 | L8 met proefrun; artwork-pijplijn |
| **4. Eigen import en bibliotheken** | Minder werk | Vertrouwde herkomst (ADR-18); bibliotheekinstellingen kort (ADR-3); Unmapped-opruimen (ADR-14); voorluisteren | importengine met verwachte identiteit |
| **5. Slim** | Bibliotheek groeit mee | V1, V2/ADR-20, V3, V4, V8, V11 | integriteitslus; ffmpeg-omzetting; back-up |
| **6. Koppelingen** | Werkt overal | Mediaservers volgens Lidarr (ADR-15), Plex eerst; daarna V13 playlists | notificatiekoppelingen per gebeurtenis |
| **7. Breedte** | Meer bronnen | extra bron (bijvoorbeeld Qobuz); bibliotheken zoals Lidarr (ADR-3 lang); V14 | adaptercontracten gestabiliseerd |

---

## 11. Toets voor elke wijziging (change gate)
Een wijziging gaat pas door als alle antwoorden "ja" of "n.v.t." zijn.

1. Dient de wijziging een eis (E) of wens (W), of een geaccordeerd voorstel (V)?
2. Pakt ze de oorzaak aan in de juiste lus, en niet een symptoom?
3. Geeft herhalen dezelfde eindstand (P3)?
4. Blijft ontbrekend te berekenen als gewenst − aanwezig (P2)?
5. Raakt ze bestanden? Dan journaal, proefrun en bewijs (P4, ADR-7).
6. Blijven transacties korter dan 1 s (ADR-9)?
7. Is elke weigering of keuze zichtbaar met een reden (P5)?
8. Zit kennis van een dienst of mediaserver in een adapter (P9)?
9. Is het toegankelijk: woorden, groot, toetsenbord (P8)?
10. Zijn er tests, zijn die groen, en is er niet gedeployed tijdens een bibliotheekbrede retag of rename?
