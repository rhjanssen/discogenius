# Discogenius Architecture & Rebuild Design

Ontwerpbesluit, 10 oktober 2026. Status: voorstel voor een rebuild, geen implementatieplan of beschrijving van reeds gebouwde software.

## 1. Executive summary

Ik zou Discogenius bouwen als een lokale bibliotheekbeheerder die een verzameling gebruikerskeuzes omzet in verklaarbare, gecontroleerde bestanden op schijf. De belangrijkste ontwerpbeslissing is het afzonderlijk modelleren van catalogusidentiteit, bronaanbod, gebruikersintentie, berekende selectie en werkelijk aanwezige bestanden. Die verschillen bestaan in het product, ongeacht taal of database.

Mijn keuze is een modulaire monoliet met **C#/.NET 10, ASP.NET Core, SQLite, expliciete SQL via Dapper en React/TypeScript met Fluent UI v9**. Eén applicatieproces bevat de HTTP-server en begrensde achtergrondtaken. Downloaders, probes, fingerprinting en tagbewerkingen draaien als gecontroleerde subprocessen. Eén proces mag de database schrijven en één bestandencoördinator publiceert wijzigingen in beheerde bibliotheken. Er is één applicatie-image en één release. Sommige providers hebben een optionele externe authenticatie- of downloadservice nodig.

Deze keuze wint voor een zelf gehoste toepassing op één server. .NET maakt begrensde parallelle taken, HTTP en synchrone SQLite-toegang mogelijk zonder een zelfgebouwd berichtenprotocol naar een databaseworker. SQLite voorkomt een verplichte databaseserver. Dit is geen claim dat .NET fouten voorkomt, sneller is gemeten of SQLite gelijktijdig laat schrijven. De beperkingen en de sterkste alternatieven staan in §6–10.

De planner wordt een zuivere, deterministische functie met expliciete prioriteiten. Hij bewaart albumintegriteit, onderscheidt identiteit van toegestane substitutie en gebruikt begrensde set-coverzoekopdrachten waar bron- of editiecombinaties dat werkelijk vereisen. Geen universele constraintsolver, geen vrij programmeerbare regelengine en geen permanent netwerk van alle denkbare combinaties.

De betrouwbaarheidskern bestaat uit onveranderlijke acquisitieopdrachten, exacte bestandsidentiteit en een duurzaam journaal voor bestandshandelingen. Een manifest beschrijft de bedoeling; het bewijst geen downloadsucces. Een databasebestand en mediabestanden delen geen transactie. Herstel moet daarom iedere onderbreking tussen voorbereiden, publiceren en registreren herkennen.

Ik adviseer een **clean-slate applicatie met een eenmalige datamigratie**, ontwikkeld in controleerbare verticale stappen. De oude toepassing blijft operationeel tot de nieuwe versie de noodzakelijke productfuncties en hersteltests beheerst. Bestaande bestanden worden eerst zonder wijziging opgenomen. Er komt geen periode waarin twee versies dezelfde bibliotheek muteren.

Het doelproduct omvat catalogusbeheer, curation, acquisitie, import, bestandsbeheer en integraties. Afspelen blijft bij Plex/Jellyfin. Playlistovername krijgt een eigen, latere functionele stap. Dat is een expliciete scopekeuze op basis van het laatste gebruikersstandpunt in het bijgevoegde gesprek, niet een conclusie uit de aanwezigheid van huidige playbackcode.

### Onderzoeksbasis en grenzen

De lokale checkout is onderzocht op branch `codex/managed-library-cleanup`, commit `79094bae54f34148d83e2b9f73b665187c910f26`, met pakketversie `2.21.0`. Vier catalogus-/Servarr-bestanden hadden al lokale wijzigingen. Ook waren `.codex-remote-attachments/`, `GROK_HANDOFF.md` en `GROK_INSTRUCTIE_2.md` al aanwezig als untracked bestanden. Die zijn ongemoeid gelaten. Bevindingen gaan over de gelezen workspace, niet automatisch over een live container of de publieke hoofdbranch.

Onderzocht zijn productdocumentatie, backlog, actieve schema-opbouw, planner- en matchingcode, representatieve regressietests, frontendgedrag, import/herstel en gerichte referentiecode. Het volledige eerdere gesprek is meegenomen als discussiebron. De publieke [GitHub-repository](https://github.com/rhjanssen/discogenius) is geraadpleegd; de openbare webweergave liep achter op de lokale werkversie. De GitHub-connector gaf geen open issues terug. Daarom is de lokale backlog de voornaamste bron voor gepland werk, zonder te veronderstellen dat zij compleet of overal actueel is.

Er is geen productiecode gewijzigd, geen live database geopend en geen live download uitgevoerd. Tests zijn hier onderzocht als specificaties en regressievoorbeelden, niet opnieuw uitgevoerd of als geslaagde validatie gepresenteerd. Concrete repositoryverwijzingen staan in het bronnenregister achteraan.

## 2. Capability map

`Bestaand` betekent aangetroffen in code/tests. Het betekent niet dat iedere provider en ieder pad live bewezen is. `Gewenst` betekent teruggevonden in backlog of gesprek. `Ontwerpkeuze` is mijn voorstel.

| Capability | Wat de gebruiker moet kunnen | Gevonden toestand en besluit |
|---|---|---|
| Catalogus verkennen | Artiesten, albums, edities, tracks en video's bekijken vóór toevoegen | Bestaand; behouden. Browsen creëert geen downloadwens. |
| Catalogus synchroniseren | Metadata vernieuwen via online MusicBrainz-metadata of een lokale mirror | Bestaand; dezelfde interne identiteit, met bron en volledigheid. Wisselen wist geen bibliotheek. |
| Bibliotheken beheren | Eigen roots en kwaliteitsbeleid voor stereo, spatial en video | Bestaand; behouden als zelfstandige bibliotheken, niet als drie kolommen op een album. |
| Artiesten volgen | Alles, alleen nieuwe uitgaven of tijdelijk niets automatisch toevoegen | Bestaand; membership, pauze en verwijderen blijven verschillende acties. |
| Handmatige keuzes | Albums/edities/video's opnemen, uitsluiten, voorkeur geven of vastzetten | Bestaand met complexe locksemantiek; opnieuw modelleren als duurzame beslissingen. |
| Discografie samenstellen | Types filteren, edities kiezen, redundante singles herkennen, unieke bonustracks behouden | Bestaande implementatie plus onvoltooide integratie; essentiële capability. |
| Contentbeleid toepassen | Clean/explicit en verschillende versies bewust behandelen | Bestaand; identiteit, substitutie en voorkeur worden afzonderlijk vastgelegd. |
| Bronnen verbinden | Account, regio, mogelijkheden en storingen per streamingdienst zien | Bestaand, ongelijk volwassen. TIDAL het meest onderzocht. |
| Aanbod vinden | Weten welke bron de gewenste inhoud en kwaliteit kan leveren | Bestaand; beschikbaarheid heeft tijdstip, accountcontext en onbekende toestand. |
| Acquisitie plannen | Ontbrekende tracks of upgrades met verklaarbare bronkeuze verkrijgen | Bestaand; één provider per acquisitie, meerdere bronedities mogelijk. |
| Werk bedienen | Wachtrij, prioriteit, pauze, hervatten, annuleren, retry en historie | Bestaand; één consistent statuscontract nodig. |
| Bestaande media opnemen | Scannen, ingebedde IDs gebruiken, onbekende bestanden beoordelen en handmatig koppelen | Bestaand met open praktijkvalidatie; geen verplichte herkenning om een bestand te bewaren. |
| Bibliotheek onderhouden | Naamgeving previewen, verplaatsen, retaggen, duplicaten beoordelen | Bestaand; alle mutaties gebruiken hetzelfde herstelprotocol. |
| Metadata bij bestanden beheren | Covers, lyrics, NFO, extra bestanden en ingebedde tags behouden/vernieuwen | Bestaand; geselecteerde bronbestanden zijn duurzaam, UI-proxies vervangbaar. |
| Kwaliteit bewijzen | Werkelijke codec, kanalen, resolutie en eventuele Atmos-evidence zien | Bestaand; bronbelofte en bestandsmeting nooit verwisselen. |
| Veilig opschonen | Expliciete cleanup previewen en uitvoeren zonder onbedoeld verlies | Bestaand plus resterende gates; de huidige wenslijst is geen verwijderopdracht. |
| Importlijsten gebruiken | Gevolgde artiesten/favorieten/playlists gebruiken om artiesten te selecteren | Bestaand; huidige artiestenextractie is geen playlistreproductie. |
| Playlists reproduceren | Volgorde, herhalingen en ontbrekende items bij Plex/Jellyfin volgen | Gewenst; apart model en later acceptance milestone. |
| Diagnose en beheer | Tools, mounts, credentials, jobs, opslaggebruik en fouten inspecteren | Bestaand; behouden met concrete herstelacties. |
| Toegang beveiligen | Eén beheeromgeving afschermen zonder providerlogin verplicht te stellen | Bestaand; geen multi-tenant platform of rollenstelsel als uitgangspunt. |
| Afspelen | Lokale/provideraudio streamen en transcoderen | Huidige code aanwezig; vervalt uit de rebuildscope. Externe spelers verzorgen dit. |

Aanvullende gevallen die bij het product horen: albumgebonden én zelfstandige video's, video's die meerdere opnamen betreffen, compilaties met één unieke opname, meerdere edities per album, herhaalde tracks, ontbrekende MusicBrainz-identiteit, veranderde externe IDs en libraries zonder werkende providerverbinding. [R1, R2, R6, R8]

## 3. Requirements versus legacy assumptions

### Harde product- en domeinrequirements

Gebruikersintentie overleeft refresh, uitval van een provider, restart en een mislukte download. Het systeem kan een gewenste editie zonder bron representeren. Bestanden blijven bestaan wanneer iemand een artiest niet meer volgt. Een bestand wordt pas als passend geteld als de identiteit, bibliotheek en werkelijk aangetroffen eigenschappen passen. De gebruiker kan begrijpen waarom iets geselecteerd, overgeslagen of geblokkeerd is.

Een provider-ID is alleen uniek binnen provider en resourcetype. Een trackpositie is een occurrence op een concrete editie. Stereo, spatial en video zijn verschillende leveringsdoelen. Een enkele acquisitie mengt geen providers. Deze regels behouden hun betekenis zonder de huidige tabellen of services.

### Voorgenomen functionaliteit

Playlist-sync, gericht importlijstbeleid, betere review van onbekende bestanden, volledige medleyvideo-UX en consequente artworkrollen zijn gewenste uitbreidingen. Provideradapters voor Amazon en Spotify bewijzen geen werkende downloads; ze staan momenteel als niet ingeschakelde mogelijkheden in de code. Apple, Deezer en YouTube hebben eigen resterende praktijkgates. Het ontwerp ondersteunt deze functies, maar een rebuildrelease mag ze pas als ondersteund adverteren na eigen acceptatie. [R2, R8]

### Toevallige implementatiekeuzes

Express, TypeScript, Yarn 1, `TrackFiles` als verplichte tabelnaam, de huidige commandtypes, row deletion als unmonitoractie en de aparte tabellen voor iedere sidecarsoort zijn geen productrequirements. Ook een bestaande planner, repositorylaag of workerpool heeft geen recht op voortbestaan. De eerdere regel "Do not port to .NET" stuurt onderhoud van de bestaande app; deze opdracht vraagt expliciet om een nieuwe onafhankelijke afweging.

### Legacy en tegenstrijdige bronnen

| Gevonden spanning | Beoordeling voor dit ontwerp |
|---|---|
| Oud set-coverdocument behandelt ISRC/UPC als universele exacte sleutels | Te sterk. Gebruik als bewijs, toets conflicten en bewaar onzekerheid. Een MusicBrainz-recording is bovendien niet hetzelfde als één master. |
| Documentatie zegt dat aanbod monitoring niet bepaalt; instelling/test `require_provider_availability` doet dat voor automatische selectie | Maak aanbod een voorwaarde voor automatisch *toelaten*, indien gewenst. Een eenmaal vastgelegde wens verdwijnt niet bij aanbodverlies. |
| Backlog noemt artist-wide coverage open, terwijl planner en tests al cross-groupgedrag bevatten | Bestaande bouwstenen en bedoelde totale productwerking zijn verschillende zaken. Niet als geheel afwezig of af verklaard. |
| Eén importtest legitimeert een cross-provider composite, terwijl de huidige domeinregel dat verbiedt | Behoud de testles over exacte provenance, verwerp een gemengd plan. |
| Sommige documentatie verbiedt nieuwe providervideo-identiteit, andere staat `provider_catalog` toe | Sta alleen een herkenbaar voorlopige video toe na succesvolle cataloguszoekacties zonder resultaat. Een timeout is geen negatief zoekresultaat. |
| Eerder gesprek koppelt stackkeuze aan toekomstige native players, daarna wordt die scope ingetrokken | Geen playerarchitectuur, MAUI of transcodingserver als argument voor de stack. |
| Huidige app gebruikt al workers en heeft meerdere bestandsjournalen | Niet beschrijven alsof alle achtergrondtaken op de HTTP-loop draaien of ieder journaal ontbreekt. Wel ontbreekt één volledig import-/mutatiecontract. |
| Twee schemadefinities bestaan, waarvan één niet door productie wordt gemaakt | In de rebuild één migratiereeks voor productie én tests. |

Dit zijn bronconflicten, geen nieuwe live defectmetingen. Ze zijn terug te vinden in [R3–R7, R9].

### Aannames en voorgestelde beperkingen

Het doel is één actieve installatie per database, een beheerder/huishouden, een lokale database op betrouwbare opslag en een collectie die door gerichte queries verwerkt kan worden. Geen centrale hele-MusicBrainz-replica in de applicatiedatabase; een lokale mirror blijft een extern systeem.

Ik kies exclusieve, niet-overlappende **beheerde** roots per library. Het huidige delen van exact dezelfde root is geen aangetoonde productnoodzaak en maakt publiceren, cleanup en sidecarownership moeilijker. Read-only importbronnen mogen elders liggen. Dit is een zichtbare compatibiliteitsbreuk met een migratiegate, geen detail dat stilzwijgend verdwijnt. Als gedeelde roots noodzakelijk blijken, moet fysieke rootownership los van librarymembership gemodelleerd worden; dat staat bij de open vragen.

Microsofts Fluent-ontwerptaal blijft behouden als teruggevonden gebruikersvoorkeur. Er is geen overtuigende reden om die te vervangen. De gekozen doelarchitectuur veronderstelt geen bijzondere taal waarin coding agents aantoonbaar foutlozer werken; het eerdere gesprek levert daarvoor geen vergelijkend bewijs.

## 4. Core domain model

Het product beantwoordt zes vragen, in deze volgorde:

1. Welke catalogusobjecten kennen we, en hoe zeker/volledig is die informatie?
2. Welke inhoud wil deze library bewaren?
3. Welke edities vertegenwoordigen die wens volgens het ingestelde beleid?
4. Welke geaccepteerde bronnen kunnen de benodigde occurrences leveren?
5. Welke exacte handeling gaan we uitvoeren?
6. Wat hebben we daarna werkelijk vastgesteld op schijf?

**Artist** is een catalogusartiest. Credits zijn een geordende relatie met artiesten en gecrediteerde naam, geen aanleiding om iedere featured artist te volgen. **Album** is een release group. **Edition** is één concrete uitgave. **EditionTrack** is een positie binnen een medium van die uitgave. **Recording** is de opname waaraan een track refereert. Twee posities kunnen naar dezelfde Recording verwijzen en blijven twee posities.

MusicBrainz maakt hetzelfde onderscheid tussen recordings en tracks; mastering alleen creëert volgens dat model geen nieuwe recording. Daarom bewijst een gelijk recording-MBID geen gelijk masterbestand. [MusicBrainz Recording](https://musicbrainz.org/doc/Recording)

**ProviderResource** is een extern artist/edition/track/video-object. **SourceOccurrence** legt een echte editiepositie of een werkelijk standalone aangeboden track vast. **SourceVariant** is de verwachte leveringsmogelijkheid, bijvoorbeeld de stereo-FLAC-variant bij een dienst die daarnaast Atmos levert. De lijst zegt nog niets over een lokaal bestand.

**MatchDecision** is een begrensde, herleidbare uitspraak over identiteit. Artiestmatches, editiematches, audiomatches en videomatches hebben getypeerde doelen. Een audiomatch verbindt een SourceOccurrence met een Recording. Een strikte editiematch is nuttig, maar niet verplicht om een betrouwbaar gematchte losse opname te kunnen leveren. De exacte koppeling naar een doeltrackpositie ontstaat in een plan.

**LibraryIntent** is duurzaam gebruikersbeleid: membership, inclusie/exclusie, vastgezette edities, bronvoorkeur en kwaliteits-/contentvoorwaarden. **CurationSnapshot** is de herberekenbare selectie met redenen en invoerversies. **Acquisition** is een geaccepteerde uitvoeringsopdracht met onveranderlijke items. **Attempt** registreert een concrete poging. **MediaFile** beschrijft een waargenomen bestand, de huidige eigenaar, identiteit en geprobeerde technische eigenschappen.

Een **FileOperation** beschrijft een voorgenomen bestandshandeling en de voortgang van herstel. Dat journaal is noodzakelijk omdat database en filesystem afzonderlijk kunnen uitvallen. Een **Sidecar** is een werkelijk bestand met een rol en expliciete relaties naar de media/edities die het gebruiken. Een cover die de gebruiker koos is geen wegwerpcache.

### Canonical, waargenomen, gekozen en berekend

| Soort informatie | Opslaan? | Autoriteit en wijziging |
|---|---|---|
| Catalogus-ID, trackvolgorde, credits en externe redirects | Ja, lokale replica met bronversie/volledigheid | Catalogusmodule; gerichte refresh. Een onvolledige response mag geen eerder complete lijst verwijderen. |
| Providerresources, occurrences en beschikbaarheid | Ja, begrensde waarnemingscache | Provideradapter levert observaties; geen canonieke metadata overschrijven. |
| Handmatige matches, afwijzingen en contentcorrecties | Ja, duurzaam | Gebruiker; automatische rematching respecteert deze besluiten. |
| Automatische matchuitkomst en bewijs | Ja, zolang gebruikt of nodig voor diagnose | Matching; vervalt bij relevante bronwijziging, historisch bewijs blijft bij acquisitie. |
| Membership, uitgesloten albums, pins en beleid | Ja, duurzaam en geversioneerd | Librarymodule; geen onderdeel van catalogusrefresh. |
| Kandidaten, overlapgrafen en zoekcombinaties | Normaal niet | Geheugen tijdens een berekening; begrensde debugdump optioneel. |
| Selectie, completeness, statistics en previewplannen | Cache toegestaan met inputrevision | Herberekenbaar; geen andere module mag ze als ongeversioneerde waarheid schrijven. |
| Geaccepteerde acquisitie, items, attempts en operation journal | Ja, duurzaam | Execution; ook nodig wanneer brondata later weg is. |
| Bestandsinventaris en probegegevens | Ja, met verification time/fingerprint | Inventory; scan kan opnieuw observeren. Ownership/provenance zijn niet volledig uit de bestanden te reconstrueren. |
| Browserproxies en tijdelijke downloadbytes | Cache/tijdelijk | Opnieuw verkrijgbaar waar mogelijk; actieve operation artifacts niet opruimen. |

Een lokale gebruikerscorrectie is een aparte override boven catalogusdata. Zij wordt niet teruggeschreven alsof MusicBrainz die waarde leverde. Wanneer catalogusidentiteit ontbreekt, blijft een geïmporteerd bestand identificeerbaar via zijn lokale file-ID en zichtbare metadata. Er hoeft geen fictieve catalogusrelease aangemaakt te worden.

## 5. Belangrijkste invarianten

Deze invarianten moeten zichtbaar worden in databaseconstraints, domeinchecks en foutinjectietests. Alleen een comment in code is onvoldoende.

| ID | Invariant | Primaire handhaving |
|---|---|---|
| I01 | Externe identity is namespace + soort + native ID | UNIQUE op providerresource; getypeerde interne IDs. |
| I02 | Catalogusidentiteit wordt niet afgeleid uit een provider-ID of bestandspad | Alleen catalogusingest/expliciete identiteitshandeling maakt of wijzigt cataloguslinks. |
| I03 | Trackoccurrences blijven onderscheiden, ook bij gelijke Recording | Unieke edition/medium/ordinal en afzonderlijke planitems. |
| I04 | Eén actief geaccepteerd matchdoel per subject/context; ambigu is geen willekeurige match | Partiële unieke index plus matchstatus en evidence revision. |
| I05 | Gelijke opname, toegestane vervanging en identieke bytes zijn verschillende uitspraken | Afzonderlijke functies en bewijssoorten; geen gedeelde universele equivalence-ID. |
| I06 | Gebruikersuitsluitingen en pins blijven bestaan bij automatische herberekening | Eigen intenttabellen; revision check bij wijziging. |
| I07 | Gewenst, beschikbaar, geselecteerd, queued en lokaal voldaan zijn onafhankelijk | API-contract met afzonderlijke velden; geen universele `status` of `monitored` boolean. |
| I08 | Een acquisitie betreft één library, één doelproduct en één leverende provider | Planheader en samengestelde FKs; check ook bij uitvoer. |
| I09 | Bronoccurrence, variant en werkelijk resultaat horen aantoonbaar bij elkaar | Exact planitem-ID in downloaderresultaat; geen zip van lijsten of bestandsvolgorde. |
| I10 | Spatial levert nooit impliciet stereo en capability is geen bestandskwaliteit | Hard compatibility predicate op geprobeerde facts. |
| I11 | Een bestand heeft één beheerder en één actuele fysieke inventory-identiteit | Exclusieve roots, unieke root/path key, conditionele updates op file revision. |
| I12 | Oude bruikbare bytes verdwijnen niet voordat vervanging veilig is vastgelegd | FileOperation-protocol met backup/quarantaine en herstel. |
| I13 | Een gemiste/storende mount maakt geen collectie leeg | Root identity/health en complete scangeneratie vóór missing-markering. |
| I14 | Herhaling levert geen dubbele actieve acquisitie, publicatie of playlistentry op | Idempotency key, acquisition item identity, journaloperation-ID, playlist occurrence-ID. |
| I15 | Alleen de huidige attempt mag jobstate afronden; een DB-lease is geen filesystemlock | Compare-and-set token plus één eigenaar van librarymutaties. |
| I16 | Een cache/snapshot wordt alleen gepubliceerd voor de inputrevision waarop hij berekend is | Optimistic generation check, anders opnieuw berekenen. |
| I17 | Afleiding door overlap mag geen onzekere identity transitief samenvoegen | Conservatieve substitutieregels; geen union-find op fuzzy matches. |
| I18 | Stoppen van monitoring verwijdert geen bestanden; cleanup heeft een eigen opdracht | Geen cascade van intent naar inventory of bytes. |

`Explicitness` heeft minstens `explicit`, `clean` en `unknown`, met bron van het bewijs. Een albumflag, trackflag of handmatige correctie is geen audiometing. Een ffprobe-uitkomst kan explicitness niet bewijzen. Bij tegenstrijdig bewijs mag een strict-clean policy niet stilzwijgend slagen.

## 6. Architectuurkandidaten

Alle kandidaten gebruiken hetzelfde onafhankelijke domeinmodel, dezelfde bestandenveiligheid en dezelfde React/Fluent-webapp. Een taalverschil mag niet verhullen dat ze hetzelfde product moeten dragen.

### A. C#-monoliet met embedded database

ASP.NET Core serveert API en gebouwde webassets. Hosted services plannen en uitvoeren begrensde taken. Eén SQLite-database staat op een lokale volume. Dapper projecteert expliciete SQL naar records. Korte schrijftransacties nemen een gedeelde `SemaphoreSlim`; reads hebben eigen kortlevende connections. Native tools zijn subprocessen. Geen apart deployment van API en worker.

Sterk voor een appliance: geen databasebeheer, geen in-process RPC-protocol voor SQL, goede scheiding tussen netwerkawaits, begrensde rekenarbeid en subprocessen. Zwak: tweede applicatietaal, SQL-strings niet compile-time schemaveilig en het proces deelt geheugen/CPU tussen HTTP en taken. .NET lost SQLite-writecontention niet op.

### B. TypeScript-monoliet met geïsoleerde SQLite-toegang

Fastify en React delen TypeScript-contracten. Alle synchrone SQL loopt buiten de HTTP-eventloop, via een vaste databaseworker die domeinspecifieke query-/transactionverzoeken afhandelt. Een begrensde executor verwerkt netwerk-/bestandstaken; zware pure planning gebruikt een CPU-worker. Er is één schrijver. Leesisolatie kan later een aparte readonly-worker krijgen als de gemeten responstijd dat vraagt.

Deze kandidaat is serieus en kan het volledige product dragen. Hij vereist echter een expliciet intern protocol voor typed requests, transacties, workerfailure, timeouts en backpressure. Een extra executionproces naast een Fastify-proces lost synchrone HTTP-queries of SQLite-contention op zichzelf niet op. Kysely maakt een synchronous driver niet asynchroon. Worker threads zijn beschikbaar voor parallel JavaScript, maar hun levenscyclus blijft applicatieverantwoordelijkheid. [Node worker threads](https://nodejs.org/api/worker_threads.html)

Sterk: één applicatietaal en compileerbare contracten. Zwak: extra runtimeboundary voor een lokale database, serialization van results en risico dat callers toch een directe synchronous connection openen. Het protocol moet klein blijven: complete domeintransacties, geen generieke remote-SQL-engine.

### C. TypeScript-monoliet met PostgreSQL

Fastify gebruikt `pg` en Kysely. Een worker-entrypoint in hetzelfde codeproject verwerkt durable jobs uit PostgreSQL. Eén Compose-project bevat app en database; de app en worker kunnen hetzelfde image gebruiken. Geen Redis. Jobclaiming gebruikt korte row-locktransacties; userstate en follow-upjob kunnen in dezelfde databasecommit staan.

Deze kandidaat ruilt embedded-eenvoud in voor een echte async SQL-client en betere ondersteuning voor concurrente writes. Row locks zijn nuttig voor jobclaims, maar serialiseren geen bestandshandelingen en maken side effects niet exactly-once. [PostgreSQL locking](https://www.postgresql.org/docs/current/explicit-locking.html)

Sterk bij intensieve gelijktijdige scans, refreshes en imports, ook op één server. Zwak voor een eenvoudige NAS-installatie: aparte databasevolume, credentials, readiness, versie-upgrades en backup-/restoreprocedure. Een eigen queue blijft nodig of een kleine bibliotheek die werkelijk in dezelfde transactie kan enqueuen. Een universele workflowengine is niet nodig.

### Aanvullend onderzocht: Go met SQLite

Go kan dit product eveneens goed dragen met goroutines, SQL en subprocessen. Het levert een eenvoudige backendbinary en vermijdt Node-specifieke isolatie. Ik zet het achter A: het voordeel van één binary is beperkt wanneer downloaders, Python en mediatools toch meegeleverd worden; voor dit ontwerp weegt Go's eenvoud niet duidelijk op tegen ASP.NET's beschikbare hosting-, binding-, toegangs- en diagnoseonderdelen. Dit is een afweging, geen claim dat Go slechtere domeinlogica of slechtere AI-code oplevert. Rust, Python en Java zijn evenmin functioneel onmogelijk, maar leveren hier geen doorslaggevend extra voordeel.

## 7. Vergelijkingsmatrix

De beoordeling is kwalitatief. Geen gewogen totaalscore die schijnprecisie geeft. Correcte identiteit en bestandshandelingen zijn bij alle kandidaten harde voorwaarden; daarna beslissen de kosten van runtimecoördinatie en zelf hosten.

| Criterium | A: .NET + SQLite | B: TS + SQLite-workers | C: TS + PostgreSQL |
|---|---|---|---|
| Conceptuele eenvoud | Eén host, gewone modules; tweede taal | Eén taal; expliciete worker-/DB-boundary | Bekende client/server-DB; extra runtimecomponent |
| Hoeveelheid domeinstate | Zelfde minimale model | Zelfde | Zelfde |
| Extra technische state | Jobs/journaal, geen broker | Workerrequests naast jobs/journaal | DB-serverstate, jobs/journaal |
| Coupling | Compileerbare modulegrenzen; OpenAPI naar UI | Shared types plus protocolcoupling | Shared types; SQL en queuecoupling |
| Databasecomplexiteit | Eén writer; expliciete korte transacties | Eén writer plus transport/lifetime | Concurrente writers; row locks en deadlockhandling |
| Consistency | Eén DB-transactie waar mogelijk | Zelfde, maar transactie volledig in DB-worker | Eén DB-transactie waar mogelijk |
| Background processing | Hosted services, begrensde paralleliteit | Executors/workerprotocol zelf afbakenen | Aparte worker eenvoudig; pool begrenzen |
| Foutafhandeling | Hostfailure kan alle taken raken | Workerfailure isoleerbaar, herstelprotocol nodig | DB-/netwerkuitval komt erbij |
| Testbaarheid | Pure core + echte SQLite + API | Pure core + echte workers + SQLite + API | Pure core + echte PG + API |
| Observability | Process/tasks/query timings | Ook workerqueues, transport en event-looplag | Ook pool, locks en DB-service |
| Performance | Voldoende mits writers kort en queries gericht | Voldoende mits DB-worker geen bottleneck wordt | Beste groeiruimte voor parallel DB-werk |
| Frontend/backend | Gegenereerd contract tussen C# en TS | Eén taal; geen domeincode in UI | Eén taal; geen domeincode in UI |
| Ontwikkelsnelheid greenfield | Goed; extra clientgeneratie | Goed; extra runtimeprotocol | Goed; meer infrastructuur |
| Operationele complexiteit | Laag, één actieve app | Laag extern, hoger intern | Middel, database-upgrades en backups |
| Voorziene uitbreidingen | Providers, playlists, libraries passen | Idem | Idem, eenvoudigere concurrencygroei |
| Migratierisico huidige code | Hoger door herschrijven backend | Lager taalrisico, nieuw model blijft risicovol | Database- én orchestrationconversie |
| Belangrijkste faalmodus | Lange SQL/CPU-taken verdringen werk | Bypass DB-worker of workerqueue blokkeert app | Meer componenten maskeren onjuiste domein-/filelogica |

SQLite ondersteunt één schrijver tegelijk; WAL laat readers en writer naast elkaar werken, niet meerdere writers. Een serverdatabase wordt relevant zodra gelijktijdige writers het product daadwerkelijk hinderen. [SQLite toepassingsgebied](https://www.sqlite.org/whentouse.html), [SQLite WAL](https://www.sqlite.org/wal.html)

## 8. Gekozen architectuur en motivatie

Ik kies A. Discogenius is vooral een combinatie van begrensde relationele beslissingen, wachten op externe systemen en zorgvuldig bestandsonderhoud. Een enkele database en een enkel actief proces zijn voldoende voor het beoogde product. Ik wil daarbij zo weinig mogelijk eigen infrastructuur schrijven om gewone applicatiecode veilig te kunnen uitvoeren.

C# biedt hier een kleinere runtimeconstructie dan TS plus een eigen asynchrone SQL-boundary. Het voordeel zit niet in betere MusicBrainz-matching of vanzelf veilige bestanden. Het zit in het kunnen uitvoeren van korte synchronous databaseoperaties op request-/workerthreads, terwijl het HTTP-hostmodel daarvoor al bestaat. De database, CPU-concurrency en bestandspublicatie blijven begrensd.

Ik kies SQLite boven PostgreSQL zolang het writerbudget met korte transacties en gerichte indexes haalbaar blijkt. Een bibliotheek met veel bestanden is op zichzelf geen bewijs voor PostgreSQL; werkelijk gelijktijdig databasewerk is het relevante criterium. De gekozen architectuur moet vóór een rebuildinvestering een korte concurrency-/herstelproef doorstaan. §18 bevat de meetbare acceptatievoorwaarden.

De scheiding in het model komt uit onafhankelijke vragen. Een catalogusfeit kan niet tegelijk een gebruikerswens zijn. Een actuele bronbelofte kan niet bewijzen dat bytes op schijf bestaan. Een occurrence moet zijn positie behouden. Pas na deze redenering blijkt dat delen van de bestaande authorityscheiding dezelfde juiste grenzen herkennen. Dat behoud is inhoudelijk verdiend.

## 9. Sterkste argument tegen de keuze

Het sterkste bezwaar is dat A een herschrijving en een tweede taal introduceert om een beheersbaar runtimeprobleem op te lossen. B kan met een kleine, goed begrensde databaseworker net zo correct zijn, terwijl Robert en de bestaande tools TypeScript gewend zijn. Zonder een concrete proef is niet bewezen dat de C#-uitvoering werkelijk eenvoudiger blijft of sneller te ontwikkelen is.

Voor de huidige productaannames is **B de sterkste alternatieve architectuur**. Wanneer SQL- en werklastmetingen structureel veel gelijktijdige writes laten zien, wordt C de sterkste. PostgreSQL verdient dan de voorkeur boven steeds verfijndere embedded-locking, ongeacht dat er maar één server is.

De huidige Discogenius is beter op reeds opgebouwde providerkennis, codecgevallen, bestaande GUI en recente herstelmaatregelen. Een nieuw model geeft geen vrijbrief om die ervaring weg te gooien. De huidige workerpool is ook al een echte isolatiestap. Een single-host .NET-app is niet vanzelf beter bestand tegen een vastgelopen in-process taak; begrenzing en veilig herstarten blijven nodig.

Ik zou na deze analyse schrappen: een volledige player, runtime pluginloading, een generieke message bus, een tweede eventstore, een permanente tabel met alle matchkandidaten, een universele graph van fuzzy identiteit, een ORM plus parallel SQL-repositorysysteem en een abstractie die SQLite en PostgreSQL vanaf dag één identiek probeert te maken. SignalR is evenmin nodig voor eenrichtingsprogress.

Ik zou juist expliciet behouden: editie-occurrences, negatieve gebruikersbeslissingen, onbekende explicitness, bronvarianten, meerdere geselecteerde edities, broncontext in planitems, aparte uitvoeringspogingen, fileoperationjournal en catalogusvolledigheid. Deze begrippen wegdrukken in één statusveld maakt de code korter en het product onjuist.

## 10. Technology stack

| Onderdeel | Keuze | Waarom boven alternatieven |
|---|---|---|
| Backend | C# op .NET 10 LTS | Standaard host, tasks, cancellation en process APIs; geen eigen event-loop-/DB-bridge. |
| HTTP | ASP.NET Core met gegroepeerde Minimal APIs | Dunne endpointfuncties; ingebouwde binding, DI, ProblemDetails en OpenAPI. Geen MediatR/CQRS-framework nodig. |
| Frontend | React + TypeScript + Vite | Interactieve beheerapp zonder SSR-/SEO-behoefte; Next.js voegt daarvoor geen nuttige serverlaag toe. |
| UI | Fluent UI React v9 | Passend bij gewenste ontwerptaal en rijke beheerschermen. Geen migratie naar shadcn als doel op zichzelf. |
| Routing/data | React Router + TanStack Query | URL voor navigatie/filterselectie; serverstate met invalidatie en foutstatus. |
| Database | SQLite, WAL, foreign keys, `synchronous=FULL` | Embedded installatie; duurzame journalintents vóór fileside effects. DB op lokale storage. |
| SQL | Microsoft.Data.Sqlite + Dapper | SQL expliciet, kleine projection-records; geen lazy loading of tracked objectgraph. Geen EF én Dapper naast elkaar. |
| Migraties | Geordende SQL-bestanden met checksum en schemaversie | Eén productiepad; fixtures lopen door dezelfde migraties. |
| Achtergrondwerk | Kleine persistente jobscheduler in dezelfde DB, hosted dispatcher | Transactie met domeinwijziging; geen Redis/Temporal/Hangfire-afhankelijkheid voor een beperkte lokale taakset. |
| Realtime | SSE met snapshotreconciliation | Server zendt voortgang; geen bidirectioneel protocol nodig. |
| API | REST/JSON, OpenAPI, gegenereerde TS-client | Eén inspecteerbaar wirecontract, onafhankelijk van backendtaal. Geen directe DB-entiteiten naar browser. |
| Logging/metrics | `ILogger` JSON, `Activity`/`Meter`, optionele OTLP-export | Gestructureerde correlatie; geen verplichte observabilitystack. |
| Backendtests | xUnit, FsCheck, echte SQLite en procesfixtures | Transacties, invarianten en killpoints controleren. |
| Frontendtests | Vitest/Testing Library; Playwright voor productflows | Interactie en contracten, met kleine E2E-suite. |
| Mediatools | Gepinde ffmpeg/ffprobe, fpcalc en Python/Mutagen-helper | Reeds relevante formatkennis; codecs/tagging niet herschrijven om alles C# te maken. |
| Provideruitvoering | Gepinde adapter-owned CLI's/bridges | Providerbackend kan veranderen zonder kerndomeinwijziging. |
| Packaging | Linux-container, amd64 eerst; arm64 per tool bewezen | .NET-portabiliteit bewijst geen providerbinary-portabiliteit. |
| Build | `dotnet` + Yarn 1 voor web, lockfiles, één buildscript | Een nieuwe package manager is geen architectureverbetering. Onafhankelijke modernisering kan later. |

.NET 10 is op de onderzoeksdatum een ondersteunde LTS-release. Patchversies worden bij bouwen gepind en onderhouden; dit document bevriest geen oude patch. [Microsoft supportbeleid](https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core)

Een technische beperking moet zichtbaar blijven: Microsoft.Data.Sqlite voert de async ADO-methoden synchroon uit. `await` is geen bewijs dat SQLite niet blokkeert. Het hostmodel en begrensde SQL-workloads dragen deze keuze. [Microsoft.Data.Sqlite async-beperkingen](https://learn.microsoft.com/en-us/dotnet/standard/data/sqlite/async)

Caching blijft beperkt tot catalogus-/providerwaarnemingen, geversioneerde plan/statisticsprojecties en artworkproxies op disk. Geen Redis, geen globale mutable kandidaatcache en geen tweede indexserver. Lokale zoekfuncties starten met gerichte SQL en SQLite FTS waar nuttig. De UI-cache heeft geen beslissingsbevoegdheid.

