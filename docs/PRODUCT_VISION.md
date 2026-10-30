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
| Catalogus | Artiesten, release groups, releases, tracks en recordings uit MB. Refreshen volgens regels (nieuw, oud, nog actief). Optioneel een lokale MB-mirror. |
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
- E2: Per bibliotheek en recording is er hoogstens één "eigen" bestand. Een dubbel bestand gaat naar Beoordelen of wordt (met bewijs) opgeruimd.
- E3: Er is hoogstens één actieve verwervingstaak per (bibliotheek, editie[, track]).
- E4: Aanbod met een karaoke-, tribute- of cover-signaal wordt nooit automatisch gekoppeld.

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
- E12: Bij een vreemde map met MB-tags en volledige dekking koppelt de app 95% of meer automatisch.
- E13: Een twijfelgeval gaat naar Beoordelen, met het beste voorstel en de reden.

### 4.5 Bestanden en metadata
- E14: Tags werken in Plex: één ALBUMARTIST, "Various Artists" waar dat hoort, en per-track ARTIST met de credit.
- E15: Tags werken in Navidrome: ARTISTS en ALBUMARTISTS als lijsten met meerdere waarden, en MBID's.
- E16: Albumhoezen zijn minstens 1000 px, liefst de originele grootte. Artiestfoto's zijn minstens 1000 px. Elke afbeelding vermeldt waar hij vandaan komt.
- E17: Muziekvideo's volgen de structuur van Plex (§6.6).

### 4.6 Bediening
- E18: De app is bruikbaar op 200% zoom en met een schermlezer. Het contrast voldoet aan WCAG AA.
- E19: Met ▶ hoor je binnen 3 s geluid, in Bibliotheek, Ontbrekend en Beoordelen.
- E20: De mediaserver scant binnen 1 minuut na een wijziging gericht de veranderde paden.

### 4.7 Wensen
- W1: Nieuwe diensten en mediaservers toevoegen zonder de kern aan te passen.
- W2: Werkt zonder internet-MB (lokale mirror).
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
| L2 Aanbod | diensten | Provider*Matches | na L1, en periodiek per dienst |
| L3 Curatie | catalogus + beleid + gebruikersbeslissingen | LibraryAlbums/Editions + uitkomst | na L1/L2, en bij een beleidswijziging |
| L4 Plan | gewenst + aanbod | AcquisitionPlan* | na L3 |
| L5 Inventaris | schijf | TrackFiles, UnmappedFiles | watcher + gewijzigde mappen; volledige scan wekelijks |
| L6 Verwerving | **view Ontbrekend/Cutoff** + plan | maximaal N actieve downloads | doorlopend, top-N op prioriteit |
| L7 Import | download of vreemde map | TrackFiles of Beoordelen | na een download, en na L5 voor vreemde bestanden |
| L8 Organiseren | gewenste naam en tags − huidige | hernoemen/retaggen (met logboek) | na import, en bij een profielwijziging (eerst proefrun) |
| L9 Integriteit | schijf + DB | rapport: onbekend, ontbrekend, veranderd, dubbel | wekelijks en op verzoek; herstel alleen via een voorstel |
| L10 Sync | gewijzigde paden | gerichte scan per mediaserver | na L7/L8/L9, gebundeld per 30 s |

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
- `notifyPathsChanged(paths[])` is verplicht.
  - Plex: `/library/sections/{id}/refresh?path=`
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
- **Gevolgen.** Dezelfde regels en dezelfde UI-redenen gelden voor elke herkomst.

### ADR-3: Bibliotheken per soort, artiest standaard in alle
- **Context.** Stereo, spatial en video hebben eigen kwaliteitsdoelen, bronnen en mappen. Spatial mag stereo nooit vullen.
- **Beslissing.**
  - Een bibliotheek heeft een soort (`stereo`, `spatial` of `video`), een map, een kwaliteitsprofiel, een curatiebeleid en een standaardvlag "nieuwe artiesten toevoegen".
  - Een nieuwe artiest komt in elke bibliotheek met die vlag (standaard alle).
  - Per artiest kun je dat overschrijven (`LibraryArtists` per bibliotheek); een overschrijving telt als gebruikersbeslissing (P6).
  - Er kunnen meerdere bibliotheken van dezelfde soort zijn, bijvoorbeeld "Stereo Hi-Res" en "Stereo Mobiel".
- **Gevolgen.** Curatie, plan en wachtrij zijn altijd per bibliotheek. Een muziekvideo hoort alleen in een videobibliotheek en is via `music_video_for` gekoppeld aan een recording.

### ADR-4: Naamgeving en tags voor Plex én Navidrome
- **Beslissing.**
  - **Mappen:** `{Album Artist}/{Album} ({Year})[ {Edition}]/{Disc}{Track:00} - {Title}.{ext}`. Album Artist is één naam: de primaire credit van de release, of "Various Artists". Een veilige pad-normalisatie is configureerbaar.
  - **Tags** (Picard-compatibel, zie `TAG_IO_STRATEGY.md`):
    - ALBUMARTIST = de credit als één string, en voor Plex de eerste of primaire naam als het profiel "Plex-strikt" is.
    - ALBUMARTISTS = lijst.
    - ARTIST = de credit-string met join phrases.
    - ARTISTS = lijst van MB-namen.
    - Alle MBID's, RELEASETYPE (meerdere waarden), ISRC, ORIGINALDATE, LABEL, CATALOGNUMBER, songteksten (LRC indien gesynchroniseerd) en ReplayGain.
  - **Twee tagprofielen:** `picard` (standaard, Navidrome-rijk) en `plex-strict`. Beide schrijven altijd ALBUMARTIST als één waarde.
- **Gevolgen.** Plex groepeert op één albumartiest. Navidrome toont meerdere artiesten. Een wijziging van profiel loopt via L8 met een proefrun.

### ADR-5: Beeld van hoge kwaliteit
- **Beslissing.**
  - **Albumhoes:** bronvolgorde
    1. de hoes van de dienst bij een exacte editie-match (vaak 3000 px)
    2. Cover Art Archive "front" in de originele grootte
    3. de hoes ingebed in de download
  - De hoes wordt opgeslagen als `cover.jpg` naast de audio (originele grootte, maximaal circa 3000 px). Ingebed gaat een kopie van maximaal 1200 px mee.
  - **Artiestfoto:** fanart.tv of de dienst, als `artist.jpg` in de artiestmap. Optioneel ook `backdrop.jpg`.
  - Een kleiner of onzeker beeld vervangt nooit een groter, zeker beeld.
- **Gevolgen.** Plex, Jellyfin en Navidrome lezen deze lokale bestanden.

### ADR-6: Muziekvideo's volgens de Plex-structuur
- **Beslissing.** De videobibliotheek kent twee vormen, per bibliotheek in te stellen:
  - **Globaal** (een aparte videomap, Plex "Global Music Videos"): `{Artist}/{Title}-video.{ext}`. Een live-uitvoering krijgt een suffix (`-live`), een lyric video `-lyrics`, enzovoort.
  - **Inline** (in de stereomap bij het album): `{Album Artist}/{Album}/{Track Title}-video.{ext}`, of `{Album Artist}/{Title}-video.ext` voor een video zonder album.
  - Koppeling gaat via MB `music_video_for`. Is die er niet, dan via een geaccepteerde `ProviderVideoMatches`-koppeling.
- **Gevolgen.** Plex toont video's bij het juiste nummer of bij de artiest. Jellyfin en Navidrome negeren of tonen ze, zonder fouten.

### ADR-7: Bestandsveiligheid
- **Beslissing.** Wijzigingen gaan via een journaal (oud pad, nieuw pad, checksum, reden). Een verwijdering gebeurt alleen bij een betere kopie van dezelfde recording in dezelfde bibliotheek. Onbekende bestanden worden nooit verwijderd. Een batch begint met een proefrun en kan worden teruggedraaid. Integriteit (L9) meldt problemen en lost niets stil op.
- **Waarom.** arr-scripts `UnmappedFilesCleaner` gooit hele mappen weg; dat mag hier niet kunnen.

### ADR-8: Adapters voor bronnen en mediaservers
- **Beslissing.** De contracten staan in §5.5 en §5.6. De registry gebruikt instellingen per instantie, zoals Lidarr `ThingiProvider`. Een adapter test zichzelf met `health()`.
- **Gevolgen.** Een nieuwe dienst is een nieuwe map met een adapter. De kern verandert niet.

### ADR-9: Korte transacties en één schrijver
- **Beslissing.** Er is één schrijver voor SQLite (WAL). Transacties duren korter dan 1 s, en grote updates worden in brokken van circa 200 rijen gedaan. Leeswerk gebeurt buiten een transactie.
- **Gevolgen.** De UI blijft bruikbaar tijdens grote refreshes.

### ADR-10: De UI krijgt alleen wijzigingen
- **Beslissing.** Wachtrij en status gaan per versienummer naar de UI, als wijzigingen sinds die versie (zoals qBittorrent `maindata?rid=`), via SSE.
- **Gevolgen.** Weinig belasting, ook bij grote lijsten.

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
- Lijsten als tabel met grote rijen (Fluent `Table`), meldingen als `MessageBar` en details in een `Drawer`.
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
Elke nieuwe flow wordt getest met de eigenaar, aan de hand van de scenario's in §1.4, op 200% zoom (Product Usability Evaluation). Wat niet lukt, wordt een eis.

---

## 8. Voorstellen (nog niet gevraagd, wel logisch)
Dit zijn voorstellen. Ze worden pas eisen na akkoord van de eigenaar.

| # | Voorstel | Waarom | Bron/inspiratie |
|---|---|---|---|
| V1 | **Nieuwe releases volgen**: melding en automatisch gewenst bij een nieuwe release van een gevolgde artiest | De kern van "af blijven" | Lidarr monitor-new-albums, Tidarr `sync.ts` |
| V2 | **Kwaliteitsupgrades**: per bibliotheek een cutoff (bijvoorbeeld 16/44 → 24/96) en automatisch upgraden als een bron beter aanbiedt | Bibliotheken worden vanzelf beter | Lidarr `UpgradableSpecification` |
| V3 | **Integriteitsrapport** met checksums, kapotte bestanden, ontbrekende bestanden en onbekende bestanden, als csv | Vertrouwen | Immich `IntegrityService` |
| V4 | **Wekelijkse samenvatting** (e-mail of push): toegevoegd, ontbrekend, wat aandacht nodig heeft | Weinig kijken, toch weten | Tidarr ntfy/gotify/apprise |
| V5 | **Beoordelingen en afspeeltellingen uit de mediaserver** gebruiken voor curatie (een remix met sterren blijft) | Smaak telt mee | Plex/Navidrome user data |
| V6 | **Songteksten**: gesynchroniseerde LRC naast het bestand | Plex en Navidrome tonen ze | apple-music-downloader `lyrics`, LRCLIB |
| V7 | **Lokale MusicBrainz-mirror** als optie | Snelheid, geen limieten | musicbrainz-docker |
| V8 | **Ontbrekend per bron**: welke albums geen enkele bron heeft, met een melding als dat verandert | Weten waar je op wacht | – |
| V9 | **Artiest importeren uit de mediaserver of een map** (bestaande collectie inlezen) | Makkelijk starten | Lidarr bulk import |
| V10 | **Opslagbudget per bibliotheek** met een prognose | Spatial en video zijn groot | – |
| V11 | **Back-up en export van beslissingen** (curatie, uitsluitingen, overschrijvingen) | Herstelbaarheid | – |
| V12 | **Lijst van "gezien maar geweigerd" aanbod** met de reden (karaoke, regio, kwaliteit) | Uitleg | Lidarr rejections |

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
| **4. Koppelingen** | Werkt overal | Plex-sync (pad-scan); voorluisteren voor lokaal en Unmapped | `MediaServerSink`; `preview()` |
| **5. Breedte** | Meer bronnen en servers | Jellyfin, Navidrome, Kodi; extra bron (bijvoorbeeld Qobuz) | Adaptercontracten gestabiliseerd |
| **6. Slim** | Bibliotheek groeit mee | V1, V2, V3, V5 | Integriteitslus; user-data lezen |

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
