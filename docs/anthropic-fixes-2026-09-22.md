# Fix Anthropic 2.2.0 — 22 settembre 2026

## Backup e rollback

Backup iniziali, creati prima di qualsiasi modifica:

- Locale: `/home/jarvis/backups/hermes-billing-proxy/local-before-fixes-20260922T094040Z.tar.gz`.
  SHA-256 `0c190fefca6e4537f680dc5dd0005a0598c390c8297cb1312f190a4c598a09f0`.
- LXC `100.116.99.9`: `/home/jarvis/backups/hermes-billing-proxy/live-before-fixes-20260922T094040Z.tar.gz`.
  SHA-256 `cbea601217f28fbacc5f51daa024c33723910b3f11aa246cc7b9bf1aba5d8a54`.

Il backup remoto include tutto il progetto effettivo `/home/jarvis/hermes-billing-proxy`, la configurazione e la unit systemd. Gli archivi sono privati. Non includono `.claude/.credentials.json`: il login rinnovato non va annullato dal rollback.

Rollback del servizio, da eseguire come `jarvis` sulla LXC:

```bash
bash /home/jarvis/hermes-billing-proxy/scripts/rollback-anthropic-20260922.sh
```

Lo script verifica l'hash, ferma il servizio, ripristina i file originali e rimuove solo l'override DEBUG_DUMP aggiunto dal rilascio, poi riavvia. Nuovi file di documentazione/test possono restare, ma non vengono caricati dal vecchio servizio. Lo script è stato verificato sintatticamente. Il percorso equivalente di rollback automatico è stato realmente eseguito dopo il test fallito del primo candidato e ha ripristinato correttamente la versione originale.

## Cambiamenti

- Risposte Anthropic inoltrate byte per byte: nessuna reverse map su thinking, firme, JSON tool, testo, errori o caratteri UTF-8.
- Streaming con backpressure, chiusura upstream alla disconnessione del client, gestione delle interruzioni TCP e timeout di inattività configurabile (default 180 secondi).
- System prompt e marcatori cache conservati nei rispettivi blocchi per default. L'opzione legacy di relocation, se attivata esplicitamente, conserva i metadati dei blocchi.
- Stubs CC conservati sulle richieste che hanno tool, senza duplicare tool reali. Le richieste senza tool non ricevono stubs. La disabilitazione globale resta opt-in (`injectCCStubs: false`), ma è stata esclusa dal rilascio dopo una regressione reale.
- Sostituzioni outbound disabilitate nella configurazione operativa e nei nuovi default. Le vecchie liste esplicite vanno svuotate all'aggiornamento. `reverseMap` non è più usata dal trasporto Anthropic.
- Thinking deciso dal client: nessuna attivazione automatica; rimozione dei soli edit clear-thinking incompatibili quando il thinking è assente/disabilitato.
- Refresh OAuth forzato dopo 401, un solo retry; single-flight ripulito anche dopo errori sincroni e salti; scrittura credenziali atomica e privata; rilettura prima della scrittura per non sovrascrivere un login CLI concorrente.
- Redazione degli header di autenticazione nei dump di trasporto e DEBUG_DUMP disabilitato nel servizio. I dump storici già esistenti non vengono modificati.
- Documentazione, configurazioni esempio e setup aggiornati. Nessun handler Gemini modificato. Il servizio condiviso viene riavviato per caricare i fix; sono documentati anche il primo tentativo e il relativo rollback.
- Il billing block mantiene il valore già presente sul servizio (`cc_version=2.1.251.8c7`); la vecchia copia locale aveva 2.1.156. La policy delle beta rimane invariata.

Configurazione operativa:

```json
{
  "stripSystemConfig": false,
  "injectCCStubs": true,
  "replacements": [],
  "reverseMap": [],
  "anthropicTimeoutMs": 180000
}
```

## Verifica incrementale

Istanza isolata: `/home/jarvis/hermes-billing-proxy-canary-20260922`, bind `127.0.0.1:18802`, DEBUG_DUMP=0. Prima del rilascio il servizio principale è rimasto invariato. Ogni passaggio è stato verificato con generazioni reali prima del successivo sull'istanza di prova.

La prima richiesta sul codice originale ha fallito con `invalid_grant`. L'utente ha rinnovato il login/utenza; il problema era precedente ai fix.

| Passaggio | Verifica reale |
|---|---|
| 01 — OAuth | Generazione Opus 5 completata. Refresh forzato/concorrenza testati offline senza invalidare volontariamente il token reale. |
| 02 — Trasporto e sostituzioni | Streaming completato; tool round-trip con `secrets.env`, `HERMES_HOME`, Telegram/Slack e UTF-8 conservati; identità Hermes non sanitizzata accettata. |
| 03 — System/cache | System e tools di Hermes reali, senza riprodurre la history privata: due generazioni completate; seconda con 29.188 cache-read e 89 input nuovi. |
| 04 — Thinking | Disable esplicito con clear-thinking completato senza reasoning; thinking firmato seguito da tool-result e replay completato. |
| 05 — Nessuno stub | Generazione breve e coppia di richieste con contesto Hermes completate; cache valida. |
| 06 — Primo candidato canary | Generazione cancellata dal client e abort upstream registrato; signed thinking/tool replay con stubs disabilitati; Sonnet 5, Sonnet 4.6 e Haiku 4.5 completano; Sonnet 5 verificato anche con system/tools Hermes reali. |
| 07 — Primo rilascio, annullato | Cache e system Hermes passano; il round-trip corto con tool senza stubs riceve refusal. Rollback automatico alla versione originale completato. |
| 08 — Candidato corretto | Stubs ripristinati per richieste con tool: lo stesso round-trip corto torna a completare entrambi i turni. Richieste senza tool continuano a funzionare senza stubs. |
| 09 — Rilascio definitivo | Sulla porta reale 18801: cache con contesto Hermes, round-trip corto con tool e richiesta senza tool completati. Health 2.2.0 OK. |

Nessun errore Extra Usage nei passaggi qualificati dopo il rinnovo del login. L'utente dichiara Extra Usage disabilitato; l'audit non modifica tale impostazione e non misura direttamente il contatore dell'abbonamento.

Sono conservati anche i test falliti: il prompt sintetico lungo e ripetitivo ha prodotto HTTP 200 con `stop_reason: refusal` sia sulla canary sia sul proxy originale. Un prompt sintetico standalone per thinking ha ugualmente prodotto refusal; il test di thinking firmato con contesto Hermes è poi riuscito. Non abbiamo contato i soli HTTP 200 come successo: servono risposta attesa, completamento, argomenti corretti e, quando richiesto, firma/cache.

Il test di cache ripete intenzionalmente una richiesta identica: verifica integrità e riuso del prefisso, non stabilisce un cache-hit rate medio per tutte le conversazioni. La modifica iniziale di system/tool inventory cambia una volta il prefisso delle sessioni già aperte.

## Risparmio osservato e scelta finale

- Esperimento non adottato globalmente: stesso system/tools Hermes, con stubs 29.277 input totali, senza stubs 26.912; 2.365 token in meno. Il numero di tool reali è 26. Il risparmio NON è incluso sulle richieste con tool nel rilascio finale: togliere gli stubs causa refusal su alcune richieste corte.
- Richiesta minima senza tool reali: 2.693 input con stubs contro 42 senza. La differenza di 2.651 comprende anche l'overhead del percorso tool. L'output/thinking può variare tra generazioni.
- Il riuso cache è verificato anche mantenendo gli stubs: 29.188 token letti da cache e 89 nuovi, circa **99,70%** sulla fixture identica. La conservazione dei breakpoint è mantenuta nel rilascio finale.

Questi sono token osservati, non una percentuale dimostrata di quota abbonamento risparmiata sul carico quotidiano. Gli stubs precedenti erano a loro volta cacheabili; il beneficio relativo è maggiore sulle richieste corte.

## Test offline

`npm test`: 21 test passati localmente e sulla LXC con Node 22.22.0. Coprono i bug riprodotti: credential refresh forzato e concorrente, errori/salti di refresh, scrittura atomica, login concorrente, conservazione system/cache, thinking disabilitato/adaptive/manuale, deduplica tool, redazione header, SSE frammentato e UTF-8, errori JSON byte-identici, cancellazione, upstream troncato, retry limitato e timeout.

Lo script `scripts/probe-anthropic.py` esegue esplicitamente generazioni che consumano allowance, separatamente dai test offline. I risultati JSONL contengono metriche e request ID, senza prompt, argomenti tool o credenziali. La fixture privata rimane solo sulla LXC con permessi 0600.

## Stato del rilascio

Rilascio completato il 22 settembre 2026; ultima generazione di verifica alle 10:07:49 UTC (12:07:49 Europe/Rome). Servizio `hermes-billing-proxy` attivo su `100.116.99.9:18801`, versione 2.2.0, health OK e DEBUG_DUMP=0. L'istanza di prova è stata fermata; directory e fixture privata restano disponibili per riprodurre i test.

Gli hash dei quattro file runtime modificati coincidono tra workspace locale e servizio remoto. Nessuna modifica è stata inviata a GitHub.

Risultati completi: [anthropic-probe-results-2026-09-22.jsonl](anthropic-probe-results-2026-09-22.jsonl). Contengono 25 prove, 21 riuscite e 4 fallite conservate, per 35 risposte upstream osservate (una cancellazione intenzionale inclusa). Il controllo iniziale con token scaduto, precedente allo script, è documentato sopra. I fallimenti sono riportati esplicitamente e il candidato difettoso è stato ritirato; i test di accettazione del rilascio definitivo sono tutti riusciti.

L'archivio del rilascio definitivo è `/home/jarvis/backups/hermes-billing-proxy/release-2.2.0-compatible-tools.tar.gz`, sia locale sia sulla LXC. Gli archivi intermedi `candidate-*` e il primo `release-2.2.0.tar.gz` documentano candidati precedenti e non devono essere usati come versione finale.
