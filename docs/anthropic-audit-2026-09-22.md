# Audit Anthropic: billing proxy e Hermes DirectSDK

Audit del 22 settembre 2026. Nessuna modifica al servizio, alle credenziali o alla configurazione; nessuna generazione Anthropic effettuata per l'audit.

## Verdetto

Non ci sono dati sufficienti per affermare che il proxy consumi **sostanzialmente più quota di DirectSDK** a parità di lavoro. Ci sono invece difetti verificati che possono peggiorare correttezza, affidabilità e consumo. La migrazione non ha un risparmio percentuale dimostrato: le priorità sono integrità del protocollo, cache, cancellazione e richieste ausiliarie.

Il prompt iniziale confonde token trasmessi, token fatturati per categoria e quota dell'abbonamento. Sono misure diverse. L'identificatore di billing nel body non dimostra quale ponderazione il server applichi alla quota.

## Materiale verificato

- Repository locale, commit `4efa98e`, versione dichiarata 2.1.0.
- Servizio remoto su `<proxy-host>`: WorkingDirectory effettiva `~/hermes-billing-proxy`, non `/opt/hermes-billing-proxy`. Configurazione effettiva: stubs e relocation attivi, 26 replacements, 9 reverse mappings.
- Hash SHA-256 identici tra locale e remoto per `src/proxy/anthropic.js`, `src/utils.js`, `src/auth/anthropicToken.js`. Il billing block remoto dichiara CC 2.1.251, quello locale 2.1.156.
- Hermes installato: `/opt/hermes-agent` punta a `/opt/hermes-releases/v2026.9.14`. Ispezionati conversione Anthropic, strategia cache, normalizzazione usage e database in sola lettura.
- DirectSDK: sorgente pubblico al commit `f1c1220778c7864fe4c1494baf9b1566e7c95bd2`, incluso `directsdk.py`, `admission.py`, `model_catalog.py` e test/eval rilevanti.
- Campione di dump recenti: 70 coppie Anthropic analizzabili nel primo campionamento dei 150 file outbound più recenti. Non è un campione casuale o esaustivo; altri file non comparabili/estraibili sono esclusi. Non sono stati esportati prompt, conversazioni o header di autenticazione.
- Riproduzioni offline con input sintetici dei problemi di replacement, relocation, thinking e refresh OAuth.

## Quota e cache: dati effettivi

Profilo `profilo anonimizzato`, sessioni iniziate negli ultimi sette giorni rispetto all'audit. Dati della tabella `session_model_usage`, join con `sessions`; filtro endpoint `:18801`, modello Anthropic, `task=''`. È il totale cumulativo delle righe selezionate, comprensivo degli avvii a freddo; non sono misure per singolo follow-up. La tabella per modello evita di attribuire tutto al modello finale di una sessione che ha cambiato modello.

| Modello | Sessioni | Chiamate | Input non cached | Cache read | Cache write | Output | Cache read / input totale |
|---|---:|---:|---:|---:|---:|---:|---:|
| Opus 5 | 81 | 779 | 1.558 | 41.772.486 | 6.672.220 | 253.712 | 86,22% |
| Sonnet 5 | 4 | 306 | 612 | 56.635.883 | 5.607.281 | 324.802 | 90,99% |
| Haiku 4.5, ID datato | 26 | 176 | 13.753 | 7.804.150 | 1.883.799 | 90.636 | 80,44% |

Formula: `cache_read / (input_non_cached + cache_read + cache_write)`. Le sessioni delle righe possono sovrapporsi perché una sessione può usare più modelli. Le chiamate ausiliarie non registrate qui non sono comprese. Esiste anche una riga Haiku con alias non datato, esclusa dalla tabella per chiarezza.

Il confronto preliminare sui totali di `sessions` dava 88,68% e 92,76% per Opus/Sonnet; quei numeri non sono quelli da usare per attribuzione per modello.

DirectSDK riporta 97,13% sui follow-up di una review di sette chiamate. È evidenza che quel percorso può sfruttare bene la cache, non un confronto A/B con questi profili. Il suo README riporta anche un esperimento sul contatore di abbonamento: consumo simile a `claude -p`, superiore alla TUI interattiva. È una misura degli autori su un account/carico, non una regola universale né una misura del proxy.

Il proxy usa già la strategia di cache del client Hermes. Non avere ottimizzazione propria non significa non avere cache.

### Overhead degli stubs

I 33 stubs occupano 5.101 caratteri di JSON serializzato. La stima 1.500–2.000 token del prompt non è un conteggio Anthropic verificato. Nel campione vengono aggiunti a tutte le 70 richieste Anthropic confrontate.

Quando un breakpoint successivo copre il prefisso, anche gli stubs sono cacheabili. Quindi non equivalgono a 1.500–2.000 token nuovi a tariffa piena ogni turno. Su contesti lunghi e stabili, l'overhead fisso è verosimilmente secondario; sulle richieste corte può essere rilevante.

Nel campione ci sono richieste Sonnet 4.6 con un solo tool originale, 34 tool dopo il proxy e nessun `cache_control`. Al contrario, una richiesta Opus 5 passa da 26 a 59 tool e conserva due marcatori nei messages. Le richieste corte/ausiliarie meritano misurazione separata.

DirectSDK non aggiunge questi stubs, ma conserva gli schemi Hermes, li rinomina `mcp__hermes__*` e riceve annotazioni native del CLI. Il suo overhead totale non è zero e non è stato misurato contro il proxy in questo audit.

## Difetti verificati e loro impatto

### 1. Reverse replacements non sicuri per SSE, thinking e tool

Riferimenti: `src/proxy/anthropic.js:199`, `src/utils.js:49`, `src/utils.js:94`.

Ogni chunk TCP viene convertito autonomamente in stringa e passato alla reverse map. Un chunk non coincide necessariamente con un evento SSE o un JSON completo.

Riproduzioni sintetiche:

- Un `thinking_delta` contenente `Plan mode` viene modificato in `Plan mode for Hermes`. Il masking riconosce solo blocchi completi con la sequenza esatta `{"type":"thinking"`; non riconosce thinking delta, JSON con spazi o blocchi frammentati. Thinking alterato e firma originale possono diventare incompatibili in replay.
- Un input tool `{"command":"cat secrets.env"}` diventa `{"command":"cat hermes-secrets.env"}`, anche se `secrets.env` era davvero il file richiesto.
- `secrets.env` in un solo chunk viene sostituito; diviso in `secrets.` e `env` non viene sostituito. Il risultato dipende dalla frammentazione di rete. Esiste anche la frammentazione fra delta generati dal modello, quindi il solo parser SSE non basta a rendere sicura una reverse map testuale.
- Spezzando un carattere UTF-8 multibyte tra buffer, `chunk.toString()` separati introducono caratteri sostitutivi.

La sanitizzazione outbound tocca system, descrizioni tool e descrizioni delle proprietà di primo livello, non l'intera history. Inoltre le 26 sostituzioni hanno solo 9 reverse mappings. Esempio: `HERMES_HOME` resta `APP_HOME`; Telegram e Slack diventano entrambi Channel. La trasformazione è semanticamente lossy, non trasparente.

**Priorità:** evitare riscritture di contenuti opachi, thinking, firme e argomenti tool; se si mantiene una trasformazione ammessa, operare su strutture/eventi completi con decoder incrementale e semantica esplicita. Un parser JSON non rende reversibile una mappa many-to-one.

### 2. Relocation: gerarchia delle istruzioni e perdita dei breakpoint

Riferimento: `src/proxy/anthropic.js:39`.

Qualsiasi blocco system oltre 2.000 caratteri o contenente `# SOUL.md` diventa testo di un messaggio user sintetico, seguito da un assistant `Understood.`. Non riguarda solo SOUL: può includere istruzioni operative, memoria e regole per tool/approvals. L'enforcement lato host non viene eliminato, ma il modello riceve istruzioni con un ruolo diverso.

Nel campione reale Opus: due blocchi system di 12.131 e 15.225 caratteri, entrambi con `cache_control`, vengono fusi; i marcatori scendono da quattro a due. Hermes aveva deliberatamente separato il prefisso stabile dal suffisso. Nei 70 confronti ci sono 38 relocation e 74 marcatori persi complessivi.

I breakpoint rimasti nei messages possono comunque coprire tutto il testo spostato. Non è corretto concludere che tutta la cache sia persa. Si perde però il punto di riuso indipendente del prefisso stabile: può pesare su nuovi contesti, compaction e variazioni del suffisso.

Non esiste uno sconto API dovuto al solo ruolo system: la cache copre tools, system e messages. Il problema è la struttura della cache e il ruolo delle istruzioni, non una tariffa system speciale.

**Priorità:** conservare system e marcatori originari. Se la relocation fosse davvero necessaria per l'accettazione del percorso attuale, non distruggere i blocchi e i relativi metadati; verificarne separatamente accettazione, semantica e cache.

### 3. Cancellazione non propagata e stream incompleti

Riferimento: `src/proxy/anthropic.js:103–229`.

Il proxy non distrugge la richiesta upstream quando Hermes chiude la connessione. Una generazione può continuare dopo Stop/disconnessione e consumare output inutilmente. Non è stata misurata la frequenza reale di questi casi.

Mancano gestione esplicita di abort/error sulla risposta upstream, timeout applicativo e backpressure del downstream. L'handler `upstream.on('error')` non chiude la risposta se gli header sono già partiti. Questo può produrre stream appesi e tentativi di recupero lato client.

DirectSDK implementa chiusura delle socket e terminazione del processo. Il suo admission relay risolve anche tentativi extra specifici del CLI. Il proxy semplice non ha un CLI interno che faccia generazioni aggiuntive: l'assenza di quel relay, da sola, non dimostra richieste duplicate.

### 4. Auto-thinking può contraddire Hermes

Riferimento: `src/proxy/anthropic.js:73`.

Con `clear_thinking` presente, persino `thinking: {type: disabled}` viene sostituito con `enabled` e budget fino a 32.000. Questo è un limite/target, non output necessariamente consumato. Su modelli che accettano solo adaptive può causare 400. Con `max_tokens=512`, il codice produce comunque un budget di 1.024: la compatibilità dipende anche dalle regole del modello e dell'interleaved thinking.

Nel campione reale non ho osservato auto-attivazioni: le richieste Opus erano già adaptive. È quindi un bug potenziale verificato offline, non la causa dimostrata dei consumi recenti.

**Priorità:** rispettare il disable esplicito, eliminare gli edit incompatibili e gestire adaptive/effort in base alle capacità del modello. Non passare indiscriminatamente tutti i modelli ad adaptive.

### 5. Refresh OAuth su 401 difettoso

Riferimento: `src/auth/anthropicToken.js:25`.

Se il token riceve 401 ma `expiresAt` è ancora futuro, `refreshToken()` ritorna il token precedente senza refresh. Inoltre l'azzeramento di `refreshInProgress` dentro l'executor sincrono della Promise viene sovrascritto dall'assegnazione esterna: la Promise già risolta può rimanere memorizzata. La riproduzione con filesystem e rete simulati mostra zero richieste di refresh sia al primo tentativo sia dopo una successiva scadenza.

**Priorità:** distinguere refresh forzato e preventivo, liberare il single-flight in `finally`, gestire rilettura e scrittura atomica. Riduce disservizi, non implica di per sé una grande riduzione quota.

### 6. Stubs senza implementazione e betas

Il modello vede tool che Hermes non ha necessariamente registrato. Se li sceglie, può ricevere errori e spendere turni di recupero. Nel controllo dei risultati tool di due profili anonimizzati negli ultimi sette giorni non ho trovato i principali nomi CC cercati; non è dimostrata una frequenza significativa. L'injection non deduplica ogni nome: un tool `Bash` senza Glob/Read/Edit può essere duplicato.

La regola «salta stubs quando ci sono più di cinque tool» è arbitraria: non dimostra compatibilità o correttezza. L'obiettivo tecnico è esporre solo tool eseguibili e verificare il percorso risultante.

`opusOnlyBetas` impedisce soltanto di aggiungere la beta per modelli non Opus; non rimuove una beta già inviata dal client. Nome fuorviante e politica legata a una famiglia, non alle capacità correnti. Nessuna perdita di 1M è dimostrata senza osservare la richiesta e la risposta del modello interessato.

### 7. Osservabilità e debug

`/stats` espone contatori Gemini, non usage Anthropic. Per Anthropic mancano metriche proprie di cache, output, abort e retry. I dump outbound includono gli header con Bearer token quando DEBUG_DUMP è attivo; sono presenti dump sul servizio. È un effetto concreto della modalità debug: preferire metriche aggregate e redazione degli header, senza archiviare credenziali e prompt completi.

## Cosa si conserva e cosa limita DirectSDK

Entrambi lasciano al core Hermes loop, esecuzione tool, memoria, compaction e approvals. Il proxy però modifica ciò che il modello vede e ciò che Hermes riceve: non è semanticamente trasparente.

Dal codice DirectSDK: tool choice solo auto; niente `parallel_tool_calls=False`, strict function schemas, prefill assistant, `n>1`, JSON-object-only; whitelist per extra body e parametri; sampling temperature/top_p rimosso; nomi tool limitati a 50 caratteri prima del prefisso. Non è un superset dell'API nativa. Non c'è un confronto di latenza in questo audit, ma ogni richiesta avvia processi e replay.

La versione Hermes effettivamente compatibile con i requisiti del plugin va verificata prima di migrare: il nome della release installata non basta. Non è stato installato o avviato il plugin sulla macchina.

## Ordine di lavoro consigliato

1. Correggere integrità streaming/replacements e propagare cancellazione/errori.
2. Preservare ruolo system e breakpoints. Misurare nuove sessioni, follow-up e ripartenze separatamente.
3. Correggere refresh e rispetto delle impostazioni thinking.
4. Misurare separatamente le richieste corte/ausiliarie; ridurre tool inutili, schema e contesto soltanto mantenendo stabilità durante la sessione.
5. Valutare TTL 5m/1h in base alle pause reali. Il campione ha TTL 5m; 1h costa di più in scrittura e non conviene automaticamente. A prezzi API standard, ignorando le letture successive comuni, due scritture 5m dello stesso prefisso costano 2,5 unità contro 2 + 0,1 per una scrittura 1h e una lettura: è un criterio indicativo, non conversione della quota abbonamento.
6. Solo dopo, A/B contro DirectSDK con stesso modello esatto, account, effort, tools, history e pause: cold start, round di tool, sessione lunga, ripresa dopo 5m, cancellazione. Rilevare cache read/write per TTL, output/thinking, richieste upstream, errori, tool riusciti, latenza e delta del contatore abbonamento. I soli token/list-price non identificano la ponderazione quota lato server.

## Fonti esterne

- [DirectSDK, commit analizzato](https://github.com/NousResearch/hermes-plugin-claude-subscription-directsdk/tree/f1c1220778c7864fe4c1494baf9b1566e7c95bd2): sorgente, limiti e benchmark degli autori; benchmark non ripetuti qui.
- [Catalogo Hermes DirectSDK](https://hermes-agent.nousresearch.com/docs/plugins/claude-subscription-directsdk): versione, requisiti e stato sperimentale.
- [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching): ruoli cacheabili, TTL, prezzi e breakpoint.
- [Anthropic extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking): compatibilità manual/adaptive e budget.
